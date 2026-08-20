#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

pub mod chunker;
pub mod database;
pub mod embedder;
pub mod lexical;
mod manifest;
mod reranker;
pub mod scanner;
mod storage;

use fs2::FileExt;
use futures_util::stream::{FuturesUnordered, StreamExt};
use manifest::{FileState, Manifest};
use napi::bindgen_prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Instant;
use tokio::sync::Mutex as AsyncMutex;

static WORKSPACE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>> = OnceLock::new();
static CANCELLATIONS: OnceLock<Mutex<HashMap<PathBuf, Weak<AtomicBool>>>> = OnceLock::new();
static INDEX_STATS: OnceLock<Mutex<HashMap<String, IndexStats>>> = OnceLock::new();

#[derive(Clone, Debug, Default, serde::Serialize)]
struct IndexStats {
    scanned_files: usize,
    updated_files: usize,
    deleted_files: usize,
    duration_ms: u128,
    last_error: Option<String>,
}

fn canonical_workspace(workspace_path: &str) -> Result<PathBuf> {
    let path = dunce::canonicalize(workspace_path)
        .map_err(|source| Error::new(Status::InvalidArg, format!("Invalid workspace: {source}")))?;
    if !path.is_dir() {
        return Err(Error::new(
            Status::InvalidArg,
            "Workspace is not a directory",
        ));
    }
    Ok(path)
}

fn workspace_lock(workspace: &Path) -> Result<Arc<AsyncMutex<()>>> {
    let registry = WORKSPACE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut registry = registry.lock().map_err(|_| {
        Error::new(
            Status::GenericFailure,
            "Workspace lock registry is poisoned",
        )
    })?;
    if let Some(lock) = registry.get(workspace).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(AsyncMutex::new(()));
    registry.insert(workspace.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

fn cancellation_flag(workspace: &Path) -> Result<Arc<AtomicBool>> {
    let registry = CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut registry = registry
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "Cancellation registry is poisoned"))?;
    if let Some(flag) = registry.get(workspace).and_then(Weak::upgrade) {
        return Ok(flag);
    }
    let flag = Arc::new(AtomicBool::new(false));
    registry.insert(workspace.to_owned(), Arc::downgrade(&flag));
    Ok(flag)
}

fn acquire_process_lock(workspace: &Path, cancellation: &AtomicBool) -> Result<std::fs::File> {
    let directory = workspace.join(".folzeur");
    std::fs::create_dir_all(&directory).map_err(|source| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create index directory: {source}"),
        )
    })?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("index.lock"))
        .map_err(|source| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to open index lock: {source}"),
            )
        })?;
    let started = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(_source) if started.elapsed().as_secs() < 30 => {
                if cancellation.load(Ordering::Acquire) {
                    return Err(Error::new(Status::Cancelled, "Indexing cancelled"));
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(source) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("Timed out waiting for the workspace index lock: {source}"),
                ));
            }
        }
    }
}

fn record_stats(workspace: &Path, stats: IndexStats) {
    if let Ok(mut registry) = INDEX_STATS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        registry.insert(workspace.to_string_lossy().into_owned(), stats);
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct SearchConfig {
    pub top_k: Option<u32>,
    pub similarity_threshold: Option<f64>,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            top_k: Some(20),
            similarity_threshold: Some(0.8),
        }
    }
}

impl SearchConfig {
    fn top_k(&self) -> u32 {
        self.top_k.unwrap_or(20).clamp(1, 200)
    }

    fn threshold(&self) -> f32 {
        self.similarity_threshold.unwrap_or(0.8).clamp(0.0, 2.0) as f32
    }
}

struct PreparedFile {
    path: String,
    chunks: Vec<chunker::CodeChunk>,
    state: Option<FileState>,
}

fn prepare_file(path: PathBuf) -> Result<Option<PreparedFile>> {
    let metadata = std::fs::metadata(&path).map_err(|source| {
        Error::new(
            Status::GenericFailure,
            format!("Metadata read failed: {source}"),
        )
    })?;
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(source) if source.kind() == std::io::ErrorKind::InvalidData => {
            return Ok(Some(PreparedFile {
                path: path.to_string_lossy().into_owned(),
                chunks: Vec::new(),
                state: None,
            }));
        }
        Err(source) => {
            return Err(Error::new(
                Status::GenericFailure,
                format!("Failed to read {}: {source}", path.display()),
            ));
        }
    };
    if scanner::contains_secret_content(&content) {
        return Ok(Some(PreparedFile {
            path: path.to_string_lossy().into_owned(),
            chunks: Vec::new(),
            state: None,
        }));
    }
    let path = path.to_string_lossy().into_owned();
    let state = FileState::from_content(content.as_bytes(), &metadata);
    let chunks = chunker::parse_and_chunk(&path, &content)?;
    Ok(Some(PreparedFile {
        path,
        chunks,
        state: Some(state),
    }))
}

fn resolve_embeddings(
    path: String,
    chunks: Vec<chunker::CodeChunk>,
    cached: HashMap<String, Vec<f32>>,
) -> Result<Vec<Vec<f32>>> {
    let mut missing_texts = Vec::new();
    let mut missing_positions = Vec::new();
    let mut output = vec![Vec::new(); chunks.len()];
    for (position, chunk) in chunks.iter().enumerate() {
        let id = database::chunk_id(&path, &chunk.stable_id);
        if let Some(embedding) = cached.get(&id) {
            output[position] = embedding.clone();
        } else {
            missing_positions.push(position);
            missing_texts.push(embedder::enrich_context(&path, &chunk.name, &chunk.content));
        }
    }
    for (position, embedding) in missing_positions
        .into_iter()
        .zip(embedder::embed_texts(missing_texts)?)
    {
        output[position] = embedding;
    }
    Ok(output)
}

async fn prepare_files(paths: Vec<PathBuf>) -> Result<Vec<PreparedFile>> {
    let mut work = FuturesUnordered::new();
    for path in paths {
        work.push(tokio::task::spawn_blocking(move || prepare_file(path)));
    }
    let mut prepared = Vec::new();
    while let Some(result) = work.next().await {
        if let Some(file) =
            result.map_err(|source| Error::new(Status::GenericFailure, source.to_string()))??
        {
            prepared.push(file);
        }
    }
    Ok(prepared)
}

async fn commit_prepared_files(
    generation_root: &Path,
    files: Vec<PreparedFile>,
    cancellation: &AtomicBool,
    lexical_writer: &mut Option<lexical::LexicalWriter>,
    manifest: &mut Manifest,
    stats: &mut IndexStats,
) -> Result<()> {
    for prepared in files {
        if cancellation.load(Ordering::Acquire) {
            return Err(Error::new(Status::Cancelled, "Indexing cancelled"));
        }
        let workspace_string = generation_root.to_string_lossy();
        let cached =
            database::existing_embeddings(workspace_string.as_ref(), &prepared.path).await?;
        let embedding_path = prepared.path.clone();
        let embedding_chunks = prepared.chunks.clone();
        let embeddings = tokio::task::spawn_blocking(move || {
            resolve_embeddings(embedding_path, embedding_chunks, cached)
        })
        .await
        .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))??;
        database::upsert_chunks(
            workspace_string.as_ref(),
            &prepared.path,
            prepared.chunks.clone(),
            embeddings,
        )
        .await?;
        if lexical_writer.is_none() {
            *lexical_writer = Some(lexical::LexicalWriter::new(workspace_string.as_ref())?);
        }
        if let Some(writer) = lexical_writer.as_mut() {
            writer.replace_file(&prepared.path, &prepared.chunks)?;
        }
        if let Some(state) = prepared.state {
            manifest.files.insert(prepared.path, state);
            stats.updated_files += 1;
        } else if manifest.files.remove(&prepared.path).is_some() {
            stats.deleted_files += 1;
        }
        if stats.updated_files.is_multiple_of(16) {
            if let Some(writer) = lexical_writer.as_mut() {
                writer.commit()?;
            }
        }
    }
    Ok(())
}

#[napi]
pub async fn index_project(
    workspace_path: String,
    exclude_patterns: Option<Vec<String>>,
) -> Result<u32> {
    let workspace = canonical_workspace(&workspace_path)?;
    let lock = workspace_lock(&workspace)?;
    let _guard = lock.lock_owned().await;
    let cancellation = cancellation_flag(&workspace)?;
    cancellation.store(false, Ordering::Release);
    let lock_workspace = workspace.clone();
    let lock_cancellation = cancellation.clone();
    let _process_guard = tokio::task::spawn_blocking(move || {
        acquire_process_lock(&lock_workspace, &lock_cancellation)
    })
    .await
    .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))??;
    let started = Instant::now();
    let excludes = exclude_patterns.unwrap_or_default();
    let (mut manifest, mut rebuild) = match storage::active_root(&workspace) {
        Ok(Some(root)) => match (storage::active_state(&workspace), Manifest::load(&root)) {
            (Ok(Some(state)), Ok(manifest)) => {
                let compatible = state.rag_schema_version == database::RAG_SCHEMA_VERSION
                    && state.lexical_schema_version == lexical::LEXICAL_SCHEMA_VERSION
                    && state.manifest_schema_version == manifest::MANIFEST_SCHEMA_VERSION
                    && state.embedding_signature == embedder::EMBEDDING_SIGNATURE
                    && state.generation_id == manifest.generation_id
                    && manifest.is_compatible();
                (manifest, !compatible)
            }
            (state, loaded) => {
                eprintln!("folzeur RAG recovery: active generation is invalid (state={:?}, manifest={:?}); rebuilding without publishing partial state", state.err(), loaded.err());
                (Manifest::default(), true)
            }
        },
        Ok(None) => (Manifest::default(), true),
        Err(source) => {
            eprintln!("folzeur RAG recovery: generation pointer validation failed: {source}; rebuilding into a new generation");
            (Manifest::default(), true)
        }
    };
    if !manifest.is_compatible() {
        rebuild = true;
    }
    if rebuild {
        manifest = Manifest::default();
    }
    let transaction = storage::GenerationTransaction::begin(&workspace, rebuild)?;
    let generation_root = transaction.root().to_owned();
    let compatible = !rebuild;
    let mut stale_paths: HashSet<String> = manifest.files.keys().cloned().collect();
    let mut stats = IndexStats::default();
    let mut lexical_writer: Option<lexical::LexicalWriter> = None;
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<PathBuf>(32);
    let scan_workspace = workspace.clone();
    let scan_cancellation = cancellation.clone();
    let scan_task = tokio::task::spawn_blocking(move || {
        scanner::visit_files_to_index(scan_workspace, &excludes, |path| {
            if scan_cancellation.load(Ordering::Acquire) {
                return Err(Error::new(Status::Cancelled, "Indexing cancelled"));
            }
            sender
                .blocking_send(path)
                .map_err(|_| Error::new(Status::Cancelled, "Indexing consumer stopped"))
        })
    });
    let mut prepare_batch = Vec::with_capacity(4);
    while let Some(path) = receiver.recv().await {
        if cancellation.load(Ordering::Acquire) {
            return Err(Error::new(Status::Cancelled, "Indexing cancelled"));
        }
        stats.scanned_files += 1;
        let path_key = path.to_string_lossy().into_owned();
        stale_paths.remove(&path_key);
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let unchanged = if compatible {
            match manifest.files.get(&path_key) {
                Some(state) if state.metadata_matches(&metadata) => state.content_matches(&path)?,
                _ => false,
            }
        } else {
            false
        };
        if unchanged {
            continue;
        }
        prepare_batch.push(path);
        if prepare_batch.len() >= 4 {
            let prepared = prepare_files(std::mem::take(&mut prepare_batch)).await?;
            commit_prepared_files(
                &generation_root,
                prepared,
                cancellation.as_ref(),
                &mut lexical_writer,
                &mut manifest,
                &mut stats,
            )
            .await?;
        }
    }
    scan_task
        .await
        .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))??;
    if !prepare_batch.is_empty() {
        let prepared = prepare_files(prepare_batch).await?;
        commit_prepared_files(
            &generation_root,
            prepared,
            cancellation.as_ref(),
            &mut lexical_writer,
            &mut manifest,
            &mut stats,
        )
        .await?;
    }

    for stale_path in stale_paths {
        if cancellation.load(Ordering::Acquire) {
            return Err(Error::new(Status::Cancelled, "Indexing cancelled"));
        }
        if let Err(source) =
            database::delete_file_chunks(generation_root.to_string_lossy().as_ref(), &stale_path)
                .await
        {
            stats.last_error = Some(source.to_string());
            record_stats(&workspace, stats);
            return Err(source);
        }
        if lexical_writer.is_none() {
            lexical_writer = Some(lexical::LexicalWriter::new(
                generation_root.to_string_lossy().as_ref(),
            )?);
        }
        if let Some(writer) = lexical_writer.as_mut() {
            writer.delete_file(&stale_path);
        }
        manifest.files.remove(&stale_path);
        stats.deleted_files += 1;
    }

    database::ensure_indices(generation_root.to_string_lossy().as_ref()).await?;
    transaction.record_phase(storage::CommitPhase::VectorCommitted)?;
    if let Some(writer) = lexical_writer.as_mut() {
        writer.commit()?;
    } else {
        lexical::LexicalWriter::new(generation_root.to_string_lossy().as_ref())?.commit()?;
    }
    transaction.record_phase(storage::CommitPhase::LexicalCommitted)?;
    manifest.save(&generation_root, transaction.generation_id())?;
    transaction.record_phase(storage::CommitPhase::ManifestCommitted)?;
    let vector_rows = database::validate(generation_root.to_string_lossy().as_ref()).await?;
    let lexical_rows = lexical::validate(generation_root.to_string_lossy().as_ref())?;
    if vector_rows != lexical_rows {
        return Err(Error::new(Status::GenericFailure, format!("Staged RAG generation is inconsistent: LanceDB has {vector_rows} chunks and Tantivy has {lexical_rows}")));
    }
    let state = storage::GenerationState {
        generation_id: transaction.generation_id(),
        storage_schema_version: storage::STORAGE_SCHEMA_VERSION,
        rag_schema_version: database::RAG_SCHEMA_VERSION,
        lexical_schema_version: lexical::LEXICAL_SCHEMA_VERSION,
        manifest_schema_version: manifest::MANIFEST_SCHEMA_VERSION,
        embedding_signature: embedder::EMBEDDING_SIGNATURE.to_owned(),
    };
    transaction.publish(&state)?;
    stats.duration_ms = started.elapsed().as_millis();
    let changed = stats.updated_files + stats.deleted_files;
    eprintln!(
        "folzeur index: scanned={} updated={} deleted={} duration_ms={}",
        stats.scanned_files, stats.updated_files, stats.deleted_files, stats.duration_ms
    );
    record_stats(&workspace, stats);
    Ok(changed as u32)
}

async fn apply_file_events_internal(
    workspace_path: String,
    upsert_paths: Vec<String>,
    deleted_paths: Vec<String>,
    exclude_patterns: Vec<String>,
) -> Result<u32> {
    let workspace = canonical_workspace(&workspace_path)?;
    if inspect_active_index(&workspace).await.is_err() {
        return index_project(workspace_path, Some(exclude_patterns)).await;
    }
    let lock = workspace_lock(&workspace)?;
    let _guard = lock.lock_owned().await;
    let cancellation = cancellation_flag(&workspace)?;
    cancellation.store(false, Ordering::Release);
    let lock_workspace = workspace.clone();
    let lock_cancellation = cancellation.clone();
    let _process_guard = tokio::task::spawn_blocking(move || {
        acquire_process_lock(&lock_workspace, &lock_cancellation)
    })
    .await
    .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))??;

    let active_root = storage::active_root(&workspace)?.ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "No active RAG generation for delta update",
        )
    })?;
    let mut manifest = Manifest::load(&active_root)?;
    if !manifest.is_compatible() {
        return Err(Error::new(
            Status::GenericFailure,
            "Active manifest is incompatible; a full rebuild is required",
        ));
    }
    let transaction = storage::GenerationTransaction::begin(&workspace, false)?;
    let generation_root = transaction.root().to_owned();
    let mut stats = IndexStats::default();
    let mut lexical_writer: Option<lexical::LexicalWriter> = None;
    let mut prepared_paths = Vec::new();
    let excludes = scanner::build_excludes(&exclude_patterns)?;
    for raw_path in upsert_paths {
        let path = resolve_event_path(&workspace, &raw_path, true)?;
        if scanner::is_explicit_file_allowed(&workspace, &path, &excludes)? {
            prepared_paths.push(path);
        } else {
            delete_from_generation(
                &generation_root,
                &path.to_string_lossy(),
                &mut lexical_writer,
                &mut manifest,
                &mut stats,
            )
            .await?;
        }
    }
    for batch in prepared_paths.chunks(16) {
        if cancellation.load(Ordering::Acquire) {
            return Err(Error::new(Status::Cancelled, "Indexing cancelled"));
        }
        let prepared = prepare_files(batch.to_vec()).await?;
        commit_prepared_files(
            &generation_root,
            prepared,
            cancellation.as_ref(),
            &mut lexical_writer,
            &mut manifest,
            &mut stats,
        )
        .await?;
    }
    for raw_path in deleted_paths {
        let path = resolve_event_path(&workspace, &raw_path, false)?;
        delete_from_generation(
            &generation_root,
            &path.to_string_lossy(),
            &mut lexical_writer,
            &mut manifest,
            &mut stats,
        )
        .await?;
    }
    publish_generation(
        transaction,
        &generation_root,
        &mut manifest,
        lexical_writer.as_mut(),
    )
    .await?;
    Ok((stats.updated_files + stats.deleted_files) as u32)
}

fn resolve_event_path(workspace: &Path, raw_path: &str, must_exist: bool) -> Result<PathBuf> {
    let raw = Path::new(raw_path);
    if raw
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(Error::new(
            Status::InvalidArg,
            "RAG file event contains parent traversal",
        ));
    }
    let candidate = if raw.is_absolute() {
        raw.to_owned()
    } else {
        workspace.join(raw)
    };
    let resolved = if must_exist {
        dunce::canonicalize(&candidate).map_err(|source| {
            Error::new(
                Status::InvalidArg,
                format!("Invalid RAG event path {}: {source}", candidate.display()),
            )
        })?
    } else {
        candidate
    };
    if !scanner::is_within(workspace, &resolved) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("RAG file event escaped workspace: {}", resolved.display()),
        ));
    }
    Ok(resolved)
}

async fn delete_from_generation(
    generation_root: &Path,
    file_path: &str,
    lexical_writer: &mut Option<lexical::LexicalWriter>,
    manifest: &mut Manifest,
    stats: &mut IndexStats,
) -> Result<()> {
    database::delete_file_chunks(generation_root.to_string_lossy().as_ref(), file_path).await?;
    if lexical_writer.is_none() {
        *lexical_writer = Some(lexical::LexicalWriter::new(
            generation_root.to_string_lossy().as_ref(),
        )?);
    }
    if let Some(writer) = lexical_writer.as_mut() {
        writer.delete_file(file_path);
    }
    if manifest.files.remove(file_path).is_some() {
        stats.deleted_files += 1;
    }
    Ok(())
}

async fn publish_generation(
    transaction: storage::GenerationTransaction,
    generation_root: &Path,
    manifest: &mut Manifest,
    lexical_writer: Option<&mut lexical::LexicalWriter>,
) -> Result<()> {
    database::ensure_indices(generation_root.to_string_lossy().as_ref()).await?;
    transaction.record_phase(storage::CommitPhase::VectorCommitted)?;
    if let Some(writer) = lexical_writer {
        writer.commit()?;
    } else {
        lexical::LexicalWriter::new(generation_root.to_string_lossy().as_ref())?.commit()?;
    }
    transaction.record_phase(storage::CommitPhase::LexicalCommitted)?;
    manifest.save(generation_root, transaction.generation_id())?;
    transaction.record_phase(storage::CommitPhase::ManifestCommitted)?;
    let vector_rows = database::validate(generation_root.to_string_lossy().as_ref()).await?;
    let lexical_rows = lexical::validate(generation_root.to_string_lossy().as_ref())?;
    if vector_rows != lexical_rows {
        return Err(Error::new(Status::GenericFailure, format!("Staged RAG generation is inconsistent: LanceDB has {vector_rows} chunks and Tantivy has {lexical_rows}")));
    }
    transaction.publish(&storage::GenerationState {
        generation_id: manifest.generation_id,
        storage_schema_version: storage::STORAGE_SCHEMA_VERSION,
        rag_schema_version: database::RAG_SCHEMA_VERSION,
        lexical_schema_version: lexical::LEXICAL_SCHEMA_VERSION,
        manifest_schema_version: manifest::MANIFEST_SCHEMA_VERSION,
        embedding_signature: embedder::EMBEDDING_SIGNATURE.to_owned(),
    })?;
    Ok(())
}

#[napi]
pub async fn index_file(
    workspace_path: String,
    file_path: String,
    exclude_patterns: Option<Vec<String>>,
) -> Result<u32> {
    apply_file_events_internal(
        workspace_path,
        vec![file_path],
        Vec::new(),
        exclude_patterns.unwrap_or_default(),
    )
    .await
}

#[napi]
pub async fn delete_file(workspace_path: String, file_path: String) -> Result<u32> {
    apply_file_events_internal(workspace_path, Vec::new(), vec![file_path], Vec::new()).await
}

#[napi]
pub async fn rename_file(
    workspace_path: String,
    old_path: String,
    new_path: String,
    exclude_patterns: Option<Vec<String>>,
) -> Result<u32> {
    apply_file_events_internal(
        workspace_path,
        vec![new_path],
        vec![old_path],
        exclude_patterns.unwrap_or_default(),
    )
    .await
}

#[napi]
pub async fn apply_file_events(
    workspace_path: String,
    upsert_paths: Vec<String>,
    deleted_paths: Vec<String>,
    exclude_patterns: Option<Vec<String>>,
) -> Result<u32> {
    apply_file_events_internal(
        workspace_path,
        upsert_paths,
        deleted_paths,
        exclude_patterns.unwrap_or_default(),
    )
    .await
}

#[napi]
pub fn cancel_index_project(workspace_path: String) -> Result<()> {
    let workspace = canonical_workspace(&workspace_path)?;
    if let Ok(registry) = CANCELLATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        if let Some(flag) = registry.get(&workspace).and_then(Weak::upgrade) {
            flag.store(true, Ordering::Release);
        }
    }
    Ok(())
}

#[napi]
pub fn get_index_stats(workspace_path: String) -> Result<String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let stats = INDEX_STATS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "Stats registry is poisoned"))?
        .get(workspace.to_string_lossy().as_ref())
        .cloned()
        .unwrap_or_default();
    serde_json::to_string(&stats)
        .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))
}

async fn semantic_search(
    generation_root: String,
    query: String,
    top_k: u32,
    threshold: f32,
) -> Result<Vec<serde_json::Value>> {
    let embedding = tokio::task::spawn_blocking(move || {
        embedder::embed_texts(vec![format!("search_query: {query}")])
    })
    .await
    .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))??
    .pop()
    .unwrap_or_default();
    if embedding.is_empty() {
        return Ok(Vec::new());
    }
    database::search_chunks(&generation_root, embedding, top_k, threshold).await
}

#[derive(serde::Serialize)]
struct IndexHealth {
    valid: bool,
    generation_id: u64,
    manifest_files: usize,
    vector_chunks: usize,
    lexical_chunks: usize,
    error: Option<String>,
}

async fn inspect_active_index(workspace: &Path) -> Result<(PathBuf, IndexHealth)> {
    let root = storage::active_root(workspace)?
        .ok_or_else(|| Error::new(Status::GenericFailure, "No published RAG generation"))?;
    let state = storage::active_state(workspace)?.ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "Published RAG generation has no state",
        )
    })?;
    let manifest = Manifest::load(&root)?;
    if state.generation_id != manifest.generation_id
        || state.rag_schema_version != database::RAG_SCHEMA_VERSION
        || state.lexical_schema_version != lexical::LEXICAL_SCHEMA_VERSION
        || state.manifest_schema_version != manifest::MANIFEST_SCHEMA_VERSION
        || state.embedding_signature != embedder::EMBEDDING_SIGNATURE
        || !manifest.is_compatible()
    {
        return Err(Error::new(
            Status::GenericFailure,
            "Published RAG generation metadata is inconsistent",
        ));
    }
    let vector_chunks = database::validate(root.to_string_lossy().as_ref()).await?;
    let lexical_chunks = lexical::validate(root.to_string_lossy().as_ref())?;
    if vector_chunks != lexical_chunks {
        return Err(Error::new(Status::GenericFailure, format!("RAG generation {} is inconsistent: LanceDB={vector_chunks}, Tantivy={lexical_chunks}", state.generation_id)));
    }
    Ok((
        root,
        IndexHealth {
            valid: true,
            generation_id: state.generation_id,
            manifest_files: manifest.files.len(),
            vector_chunks,
            lexical_chunks,
            error: None,
        },
    ))
}

async fn ensure_healthy_index(workspace: &Path) -> Result<PathBuf> {
    match inspect_active_index(workspace).await {
        Ok((root, _)) => Ok(root),
        Err(source) => {
            eprintln!("folzeur RAG health check failed: {source}; starting controlled rebuild");
            index_project(workspace.to_string_lossy().into_owned(), None).await?;
            inspect_active_index(workspace).await.map(|(root, _)| root)
        }
    }
}

#[napi]
pub async fn validate_index(workspace_path: String, auto_rebuild: Option<bool>) -> Result<String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let inspected = if auto_rebuild.unwrap_or(true) {
        match ensure_healthy_index(&workspace).await {
            Ok(_) => inspect_active_index(&workspace)
                .await
                .map(|(_, health)| health),
            Err(source) => Err(source),
        }
    } else {
        inspect_active_index(&workspace)
            .await
            .map(|(_, health)| health)
    };
    let health = match inspected {
        Ok(health) => health,
        Err(source) => IndexHealth {
            valid: false,
            generation_id: 0,
            manifest_files: 0,
            vector_chunks: 0,
            lexical_chunks: 0,
            error: Some(source.to_string()),
        },
    };
    serde_json::to_string(&health)
        .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))
}

#[napi]
pub fn list_indexed_files(workspace_path: String) -> Result<String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let root = storage::active_root(&workspace)?
        .ok_or_else(|| Error::new(Status::GenericFailure, "No published RAG generation"))?;
    let manifest = Manifest::load(&root)?;
    let mut files = manifest.files.keys().cloned().collect::<Vec<_>>();
    files.sort_unstable();
    serde_json::to_string(
        &serde_json::json!({ "generation_id": manifest.generation_id, "files": files }),
    )
    .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))
}

#[napi]
pub fn get_model_status() -> Result<String> {
    serde_json::to_string(&embedder::status()?)
        .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))
}

#[napi]
pub async fn install_model(allow_download: Option<bool>) -> Result<()> {
    tokio::task::spawn_blocking(move || embedder::install(allow_download.unwrap_or(true)))
        .await
        .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))?
}

#[napi]
pub fn set_model_download_allowed(allowed: bool) {
    embedder::set_download_allowed(allowed);
}

#[napi]
pub async fn search_code(
    workspace_path: String,
    query: String,
    top_k: u32,
    config: Option<SearchConfig>,
) -> Result<String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let generation_root = ensure_healthy_index(&workspace).await?;
    let config = config.unwrap_or_default();
    let mut results = semantic_search(
        generation_root.to_string_lossy().into_owned(),
        query,
        config.top_k().max(top_k),
        config.threshold(),
    )
    .await?;
    redact_search_results(&mut results);
    serde_json::to_string(&results)
        .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))
}

const RRF_K: f64 = 60.0;

/// Evaluates a ranked fixture without loading the embedding model. This is used
/// by CI relevance gates to detect retrieval regressions deterministically.
#[napi]
pub fn evaluate_ranking(ranked_json: String, relevance_json: String, k: u32) -> Result<String> {
    let ranked: Vec<String> = serde_json::from_str(&ranked_json).map_err(|source| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid ranked fixture: {source}"),
        )
    })?;
    let relevance: HashMap<String, u32> =
        serde_json::from_str(&relevance_json).map_err(|source| {
            Error::new(
                Status::InvalidArg,
                format!("Invalid relevance fixture: {source}"),
            )
        })?;
    let relevant = relevance.keys().cloned().collect();
    serde_json::to_string(&serde_json::json!({
        "recall_at_k": reranker::recall_at_k(&ranked, &relevant, k as usize),
        "mrr": reranker::reciprocal_rank(&ranked, &relevant),
        "ndcg_at_k": reranker::ndcg_at_k(&ranked, &relevance, k as usize)
    }))
    .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))
}

#[napi]
pub async fn hybrid_search(
    workspace_path: String,
    query: String,
    config: Option<SearchConfig>,
) -> Result<String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let generation_root = ensure_healthy_index(&workspace).await?;
    let workspace_string = generation_root.to_string_lossy().into_owned();
    let config = config.unwrap_or_default();
    let top_k = config.top_k();
    let candidates = (top_k * 3).max(30);
    let lexical_workspace = workspace_string.clone();
    let lexical_query = reranker::expand_lexical_query(&query);
    let rerank_query = query.clone();
    let semantic = semantic_search(workspace_string, query, candidates, config.threshold());
    let lexical = tokio::task::spawn_blocking(move || {
        lexical::search(&lexical_workspace, &lexical_query, candidates as usize)
    });
    let (semantic_results, lexical_results) = tokio::join!(semantic, lexical);
    let semantic_results = semantic_results?;
    let lexical_results = lexical_results
        .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))??;

    let key = |value: &serde_json::Value| {
        format!(
            "{}:{}:{}",
            value["file_path"].as_str().unwrap_or_default(),
            value["line_start"].as_i64().unwrap_or_default(),
            value["line_end"].as_i64().unwrap_or_default()
        )
    };
    let mut scores: HashMap<String, (f64, serde_json::Value)> = HashMap::new();
    for (rank, item) in semantic_results.iter().enumerate() {
        let score = 1.0 / (RRF_K + rank as f64 + 1.0);
        scores.insert(key(item), (score, item.clone()));
    }
    for (rank, item) in lexical_results.iter().enumerate() {
        let score = 1.0 / (RRF_K + rank as f64 + 1.0);
        scores
            .entry(key(item))
            .and_modify(|entry| entry.0 += score)
            .or_insert((score, item.clone()));
    }

    let mut ranked: Vec<_> = scores.into_values().collect();
    ranked.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut per_file = HashMap::<String, usize>::new();
    let mut output = Vec::with_capacity(top_k as usize);
    for (score, mut value) in ranked {
        let path = value["file_path"].as_str().unwrap_or_default().to_owned();
        let seen = per_file.entry(path).or_default();
        let diversified_score =
            (score + reranker::code_score(&rerank_query, &value)) / (1.0 + *seen as f64 * 0.15);
        *seen += 1;
        value["rrf_score"] = serde_json::json!(diversified_score);
        output.push(value);
    }
    output.sort_by(|left, right| {
        right["rrf_score"]
            .as_f64()
            .partial_cmp(&left["rrf_score"].as_f64())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    output.truncate(top_k as usize);
    redact_search_results(&mut output);
    serde_json::to_string(&output)
        .map_err(|source| Error::new(Status::GenericFailure, source.to_string()))
}

fn redact_search_results(results: &mut [serde_json::Value]) {
    for result in results {
        if let Some(content) = result.get("content").and_then(serde_json::Value::as_str) {
            if scanner::contains_secret_content(content) {
                result["content"] = serde_json::Value::String(
                    "[REDACTED: potential credential material]".to_owned(),
                );
            }
        }
    }
}
