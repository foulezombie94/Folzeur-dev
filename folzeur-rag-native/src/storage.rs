use napi::{Error, Result, Status};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const STORAGE_SCHEMA_VERSION: u32 = 2;
const GENERATIONS_DIRECTORY: &str = "rag-generations";
const POINTER_PREFIX: &str = "rag-current";
const KEEP_GENERATIONS: usize = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct GenerationPointer {
    generation_id: u64,
    storage_schema_version: u32,
    checksum: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GenerationState {
    pub generation_id: u64,
    pub storage_schema_version: u32,
    pub rag_schema_version: u32,
    pub lexical_schema_version: u32,
    pub manifest_schema_version: u32,
    pub embedding_signature: String,
}

#[derive(Deserialize, Serialize)]
struct GenerationStateCheckpoint {
    state: GenerationState,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredGenerationState {
    Checkpoint(GenerationStateCheckpoint),
    Legacy(GenerationState),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitPhase {
    Preparing,
    VectorCommitted,
    LexicalCommitted,
    ManifestCommitted,
    Published,
}

impl CommitPhase {
    fn name(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::VectorCommitted => "vector_committed",
            Self::LexicalCommitted => "lexical_committed",
            Self::ManifestCommitted => "manifest_committed",
            Self::Published => "published",
        }
    }
}

pub struct GenerationTransaction {
    workspace: PathBuf,
    staging: PathBuf,
    final_path: PathBuf,
    generation_id: u64,
    published: bool,
}

impl GenerationTransaction {
    pub fn begin(workspace: &Path, rebuild: bool) -> Result<Self> {
        let directory = generations_directory(workspace);
        fs::create_dir_all(&directory)
            .map_err(|source| error("Failed to create generation directory", source))?;
        let generation_id = next_generation_id(workspace);
        let final_path = directory.join(format!("generation-{generation_id}"));
        if final_path.exists() {
            return Err(Error::new(
                Status::GenericFailure,
                "Generation destination already exists",
            ));
        }
        // A generation directory is immutable from the reader's perspective and
        // becomes visible only through the checksummed pointer. Creating it with
        // its final name avoids renaming a directory that LanceDB may still have
        // memory-mapped on Windows; a crash before pointer publication leaves the
        // previous generation active and this unpublished directory collectable.
        fs::create_dir_all(&final_path)
            .map_err(|source| error("Failed to create prepared generation", source))?;
        if !rebuild {
            if let Some(active) = active_root(workspace)? {
                copy_directory(&active, &final_path)?;
            }
        }
        let transaction = Self {
            workspace: workspace.to_owned(),
            staging: final_path.clone(),
            final_path,
            generation_id,
            published: false,
        };
        transaction.record_phase(CommitPhase::Preparing)?;
        Ok(transaction)
    }

    pub fn root(&self) -> &Path {
        &self.staging
    }

    pub fn generation_id(&self) -> u64 {
        self.generation_id
    }

    pub fn record_phase(&self, phase: CommitPhase) -> Result<()> {
        self.write_journal(phase)?;
        failpoint(phase)
    }

    fn write_journal(&self, phase: CommitPhase) -> Result<()> {
        let journal = serde_json::json!({
            "generation_id": self.generation_id,
            "phase": phase.name(),
            "staging": self.staging.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
        });
        write_atomic(
            &self
                .workspace
                .join(".folzeur")
                .join("rag-commit-journal.json"),
            &serde_json::to_vec(&journal)
                .map_err(|source| error("Failed to encode commit journal", source))?,
        )
    }

    pub fn publish(mut self, state: &GenerationState) -> Result<PathBuf> {
        if state.generation_id != self.generation_id {
            return Err(Error::new(
                Status::InvalidArg,
                "Generation state does not match transaction",
            ));
        }
        let payload = serde_json::to_vec(state)
            .map_err(|source| error("Failed to encode generation state", source))?;
        let checkpoint = GenerationStateCheckpoint {
            state: state.clone(),
            sha256: integrity_hash(&payload),
        };
        write_atomic(
            &self.staging.join("generation-state.json"),
            &serde_json::to_vec(&checkpoint)
                .map_err(|source| error("Failed to encode generation checkpoint", source))?,
        )?;
        failpoint(CommitPhase::Published)?;
        let pointer = GenerationPointer::new(self.generation_id);
        let pointer_path = pointer_path(&self.workspace, self.generation_id as usize % 2);
        write_atomic(
            &pointer_path,
            &serde_json::to_vec(&pointer)
                .map_err(|source| error("Failed to encode generation pointer", source))?,
        )?;
        self.published = true;
        self.write_journal(CommitPhase::Published)?;
        cleanup_old_generations(&self.workspace, self.generation_id);
        Ok(self.final_path.clone())
    }
}

impl Drop for GenerationTransaction {
    fn drop(&mut self) {
        if !self.published && self.staging.exists() {
            let _ = fs::remove_dir_all(&self.staging);
        }
    }
}

impl GenerationPointer {
    fn new(generation_id: u64) -> Self {
        Self {
            generation_id,
            storage_schema_version: STORAGE_SCHEMA_VERSION,
            checksum: pointer_checksum(generation_id, STORAGE_SCHEMA_VERSION),
        }
    }

    fn is_valid(&self) -> bool {
        self.storage_schema_version == STORAGE_SCHEMA_VERSION
            && self.checksum == pointer_checksum(self.generation_id, self.storage_schema_version)
    }
}

pub fn active_root(workspace: &Path) -> Result<Option<PathBuf>> {
    let Some(pointer) = active_pointer(workspace)? else {
        return Ok(None);
    };
    let root =
        generations_directory(workspace).join(format!("generation-{}", pointer.generation_id));
    if !root.is_dir() {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "Published RAG generation {} is missing",
                pointer.generation_id
            ),
        ));
    }
    Ok(Some(root))
}

pub fn active_state(workspace: &Path) -> Result<Option<GenerationState>> {
    let Some(root) = active_root(workspace)? else {
        return Ok(None);
    };
    let bytes = fs::read(root.join("generation-state.json"))
        .map_err(|source| error("Failed to read generation state", source))?;
    let stored: StoredGenerationState = serde_json::from_slice(&bytes)
        .map_err(|source| error("Corrupt generation state", source))?;
    let state = match stored {
        StoredGenerationState::Legacy(state) => state,
        StoredGenerationState::Checkpoint(checkpoint) => {
            let payload = serde_json::to_vec(&checkpoint.state)
                .map_err(|source| error("Failed to verify generation state", source))?;
            if checkpoint.sha256 != integrity_hash(&payload) {
                return Err(Error::new(
                    Status::GenericFailure,
                    "RAG generation state integrity check failed",
                ));
            }
            checkpoint.state
        }
    };
    if state.storage_schema_version != STORAGE_SCHEMA_VERSION {
        return Err(Error::new(
            Status::GenericFailure,
            "Unsupported RAG storage schema",
        ));
    }
    Ok(Some(state))
}

fn active_pointer(workspace: &Path) -> Result<Option<GenerationPointer>> {
    let mut pointers = Vec::new();
    let mut corrupt = Vec::new();
    for slot in 0..2 {
        let path = pointer_path(workspace, slot);
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<GenerationPointer>(&bytes) {
                Ok(pointer) if pointer.is_valid() => pointers.push(pointer),
                Ok(_) | Err(_) => corrupt.push(path),
            },
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(error("Failed to read generation pointer", source)),
        }
    }
    if pointers.is_empty() && !corrupt.is_empty() {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "All RAG generation pointers are corrupt: {}",
                corrupt
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    Ok(pointers
        .into_iter()
        .max_by_key(|pointer| pointer.generation_id))
}

fn generations_directory(workspace: &Path) -> PathBuf {
    workspace.join(".folzeur").join(GENERATIONS_DIRECTORY)
}

fn next_generation_id(workspace: &Path) -> u64 {
    let pointer_generation = active_pointer(workspace)
        .ok()
        .flatten()
        .map(|pointer| pointer.generation_id)
        .unwrap_or_default();
    let directory_generation = fs::read_dir(generations_directory(workspace))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let suffix = name.strip_prefix("generation-")?.split('.').next()?;
            suffix.parse::<u64>().ok()
        })
        .max()
        .unwrap_or_default();
    pointer_generation
        .max(directory_generation)
        .saturating_add(1)
        .max(1)
}

fn pointer_path(workspace: &Path, slot: usize) -> PathBuf {
    workspace
        .join(".folzeur")
        .join(format!("{POINTER_PREFIX}-{slot}.json"))
}

fn pointer_checksum(generation_id: u64, schema_version: u32) -> String {
    integrity_hash(format!("folzeur-rag-pointer\0{generation_id}\0{schema_version}").as_bytes())
}

fn integrity_hash(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn write_atomic(target: &Path, bytes: &[u8]) -> Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| Error::new(Status::InvalidArg, "Atomic target has no parent"))?;
    fs::create_dir_all(parent)
        .map_err(|source| error("Failed to create atomic target directory", source))?;
    let temporary = target.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = File::create(&temporary)
        .map_err(|source| error("Failed to create temporary file", source))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|source| error("Failed to persist temporary file", source))?;
    if target.exists() {
        fs::remove_file(target)
            .map_err(|source| error("Failed to rotate atomic target", source))?;
    }
    fs::rename(&temporary, target)
        .map_err(|source| error("Failed to publish atomic target", source))
}

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    for entry in fs::read_dir(source)
        .map_err(|source| error("Failed to enumerate active generation", source))?
    {
        let entry =
            entry.map_err(|source| error("Failed to inspect active generation entry", source))?;
        let file_type = entry
            .file_type()
            .map_err(|source| error("Failed to inspect active generation file type", source))?;
        let name = entry.file_name();
        let target = destination.join(&name);
        if file_type.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|source| error("Failed to create cloned generation directory", source))?;
            copy_directory(&entry.path(), &target)?;
        } else if file_type.is_file() && !name.to_string_lossy().contains(".tmp-") {
            fs::copy(entry.path(), target)
                .map_err(|source| error("Failed to clone active generation file", source))?;
        }
    }
    Ok(())
}

fn cleanup_old_generations(workspace: &Path, active: u64) {
    let Ok(entries) = fs::read_dir(generations_directory(workspace)) else {
        return;
    };
    let mut generations = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_prefix("generation-")?
                .parse::<u64>()
                .ok()
                .map(|generation| (generation, entry.path()))
        })
        .collect::<Vec<_>>();
    generations.sort_by_key(|(generation, _)| std::cmp::Reverse(*generation));
    for (generation, path) in generations.into_iter().skip(KEEP_GENERATIONS) {
        if generation != active {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn failpoint(phase: CommitPhase) -> Result<()> {
    #[cfg(test)]
    let injected_by_test = TEST_FAILPOINT.with(|value| value.get() == Some(phase));
    #[cfg(not(test))]
    let injected_by_test = false;
    if injected_by_test
        || std::env::var("FOLZEUR_RAG_FAILPOINT").is_ok_and(|value| value == phase.name())
    {
        return Err(Error::new(
            Status::GenericFailure,
            format!("Injected RAG failure at {}", phase.name()),
        ));
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static TEST_FAILPOINT: std::cell::Cell<Option<CommitPhase>> = const { std::cell::Cell::new(None) };
}

fn error(context: &str, source: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {source}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpublished_generation_never_replaces_active_state() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let transaction =
            GenerationTransaction::begin(directory.path(), false).expect("first transaction");
        let generation = transaction.generation_id();
        let state = GenerationState {
            generation_id: generation,
            storage_schema_version: STORAGE_SCHEMA_VERSION,
            rag_schema_version: 1,
            lexical_schema_version: 1,
            manifest_schema_version: 1,
            embedding_signature: "test".to_owned(),
        };
        transaction
            .publish(&state)
            .expect("publish first generation");
        let active = active_root(directory.path())
            .expect("active lookup")
            .expect("active generation");
        {
            let second =
                GenerationTransaction::begin(directory.path(), false).expect("second transaction");
            fs::write(second.root().join("partial"), "partial").expect("partial write");
        }
        assert_eq!(
            active_root(directory.path()).expect("active lookup"),
            Some(active)
        );
    }

    #[test]
    fn generation_checkpoint_detects_tampering() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let transaction =
            GenerationTransaction::begin(directory.path(), false).expect("transaction");
        let generation = transaction.generation_id();
        transaction
            .publish(&GenerationState {
                generation_id: generation,
                storage_schema_version: STORAGE_SCHEMA_VERSION,
                rag_schema_version: 1,
                lexical_schema_version: 1,
                manifest_schema_version: 1,
                embedding_signature: "test".to_owned(),
            })
            .expect("publish generation");
        let state_path = active_root(directory.path())
            .expect("active lookup")
            .expect("active generation")
            .join("generation-state.json");
        let mut checkpoint: serde_json::Value =
            serde_json::from_slice(&fs::read(&state_path).expect("read generation state"))
                .expect("decode checkpoint");
        checkpoint["state"]["generation_id"] = generation.saturating_add(1).into();
        fs::write(
            state_path,
            serde_json::to_vec(&checkpoint).expect("encode tampering"),
        )
        .expect("tamper generation state");
        assert!(active_state(directory.path()).is_err());
    }

    #[test]
    fn every_commit_failpoint_preserves_the_previous_published_generation() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let initial = GenerationTransaction::begin(directory.path(), false).expect("initial");
        let initial_generation = initial.generation_id();
        initial
            .publish(&state(initial_generation))
            .expect("publish initial generation");
        let original = active_root(directory.path()).expect("active root");

        for phase in [
            CommitPhase::Preparing,
            CommitPhase::VectorCommitted,
            CommitPhase::LexicalCommitted,
            CommitPhase::ManifestCommitted,
            CommitPhase::Published,
        ] {
            TEST_FAILPOINT.with(|value| value.set(Some(phase)));
            let result = (|| {
                let transaction = GenerationTransaction::begin(directory.path(), false)?;
                if phase != CommitPhase::Preparing {
                    transaction.record_phase(CommitPhase::VectorCommitted)?;
                    transaction.record_phase(CommitPhase::LexicalCommitted)?;
                    transaction.record_phase(CommitPhase::ManifestCommitted)?;
                    let generation = transaction.generation_id();
                    transaction.publish(&state(generation))?;
                }
                Ok::<(), napi::Error>(())
            })();
            TEST_FAILPOINT.with(|value| value.set(None));
            assert!(result.is_err(), "phase {phase:?} should inject a failure");
            assert_eq!(
                active_root(directory.path()).expect("active root"),
                original
            );
        }
    }

    fn state(generation_id: u64) -> GenerationState {
        GenerationState {
            generation_id,
            storage_schema_version: STORAGE_SCHEMA_VERSION,
            rag_schema_version: 1,
            lexical_schema_version: 1,
            manifest_schema_version: 1,
            embedding_signature: "test".to_owned(),
        }
    }
}
