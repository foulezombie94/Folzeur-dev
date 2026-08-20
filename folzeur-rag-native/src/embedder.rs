use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use napi::bindgen_prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

pub const EMBEDDING_DIMENSION: i32 = 768;
pub const EMBEDDING_SIGNATURE: &str = "nomic-embed-text-v1.5|max_length=512|document-prefix=v1";
const MAX_MODEL_TOKENS: usize = 512;
const EMBEDDING_BATCH_SIZE: usize = 32;

static MODEL_MANAGER: OnceLock<Mutex<ModelManager>> = OnceLock::new();
static MODEL_DOWNLOAD_ALLOWED: AtomicBool = AtomicBool::new(true);
static MODEL_INSTALLING: AtomicBool = AtomicBool::new(false);
static MODEL_INSTALL_PROGRESS: AtomicU8 = AtomicU8::new(0);
static MODEL_RETRY_COUNT: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Serialize)]
pub struct ModelStatus {
    pub state: &'static str,
    pub cache_directory: String,
    pub offline_ready: bool,
    pub progress_percent: Option<u8>,
    pub retry_count: u32,
    pub last_error: Option<String>,
}

struct ModelManager {
    model: Option<TextEmbedding>,
    last_error: Option<String>,
}

impl ModelManager {
    fn new() -> Self {
        Self {
            model: None,
            last_error: None,
        }
    }

    fn ensure_installed(&mut self, allow_download: bool) -> Result<&mut TextEmbedding> {
        if self.model.is_none() {
            let cache_dir = model_cache_directory();
            let offline_ready = cache_contains_model_data(&cache_dir);
            if !allow_download && !offline_ready {
                return Err(Error::new(Status::GenericFailure, format!("The local embedding model is not installed in {}. Connect once and call installModel(), or configure FOLZEUR_MODEL_CACHE.", cache_dir.display())));
            }
            std::fs::create_dir_all(&cache_dir).map_err(|source| {
                Error::new(
                    Status::GenericFailure,
                    format!(
                        "Failed to create model cache {}: {source}",
                        cache_dir.display()
                    ),
                )
            })?;
            MODEL_INSTALLING.store(true, Ordering::Release);
            MODEL_INSTALL_PROGRESS.store(5, Ordering::Release);
            let initialized = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                TextEmbedding::try_new(
                    TextInitOptions::new(EmbeddingModel::NomicEmbedTextV15)
                        .with_max_length(MAX_MODEL_TOKENS)
                        .with_cache_dir(cache_dir)
                        .with_show_download_progress(allow_download),
                )
            }));
            MODEL_INSTALLING.store(false, Ordering::Release);
            match initialized {
                Ok(Ok(model)) => {
                    self.model = Some(model);
                    self.last_error = None;
                    MODEL_INSTALL_PROGRESS.store(100, Ordering::Release);
                }
                Ok(Err(source)) => {
                    self.last_error = Some(source.to_string());
                    MODEL_INSTALL_PROGRESS.store(0, Ordering::Release);
                    MODEL_RETRY_COUNT.fetch_add(1, Ordering::AcqRel);
                    return Err(Error::new(Status::GenericFailure, format!("Failed to install or initialize the local embedding model: {source}. Retry is safe and offline mode remains available after a successful install.")));
                }
                Err(_) => {
                    self.last_error = Some("native model initialization panicked".to_owned());
                    MODEL_INSTALL_PROGRESS.store(0, Ordering::Release);
                    MODEL_RETRY_COUNT.fetch_add(1, Ordering::AcqRel);
                    return Err(Error::new(Status::GenericFailure, "The embedding runtime failed during initialization; the host process was protected and a retry is safe"));
                }
            }
        }
        self.model.as_mut().ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "Embedding model manager reached an invalid state",
            )
        })
    }
}

fn manager() -> &'static Mutex<ModelManager> {
    MODEL_MANAGER.get_or_init(|| Mutex::new(ModelManager::new()))
}

fn model_cache_directory() -> PathBuf {
    if let Some(path) = std::env::var_os("FOLZEUR_MODEL_CACHE").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "windows")]
    if let Some(path) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(path).join("Folzeur").join("models");
    }
    #[cfg(target_os = "macos")]
    if let Some(path) = std::env::var_os("HOME") {
        return PathBuf::from(path)
            .join("Library")
            .join("Caches")
            .join("Folzeur")
            .join("models");
    }
    if let Some(path) = std::env::var_os("XDG_CACHE_HOME") {
        return PathBuf::from(path).join("folzeur").join("models");
    }
    std::env::temp_dir().join("folzeur-models")
}

fn cache_contains_model_data(path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    entries.filter_map(|entry| entry.ok()).any(|entry| {
        entry.file_type().is_ok_and(|kind| {
            kind.is_dir()
                || (kind.is_file()
                    && entry
                        .metadata()
                        .is_ok_and(|metadata| metadata.len() > 1_000_000))
        })
    })
}

pub fn status() -> Result<ModelStatus> {
    let cache = model_cache_directory();
    let installing = MODEL_INSTALLING.load(Ordering::Acquire);
    let manager = match manager().try_lock() {
        Ok(manager) => Some(manager),
        Err(std::sync::TryLockError::WouldBlock) => None,
        Err(std::sync::TryLockError::Poisoned(_)) => {
            return Err(Error::new(
                Status::GenericFailure,
                "Embedding model manager is poisoned",
            ));
        }
    };
    let ready = manager
        .as_ref()
        .is_some_and(|manager| manager.model.is_some());
    let last_error = manager
        .as_ref()
        .and_then(|manager| manager.last_error.clone());
    Ok(ModelStatus {
        state: if ready {
            "ready"
        } else if installing {
            "installing"
        } else if manager.is_none() {
            "busy"
        } else if last_error.is_some() {
            "error"
        } else {
            "not_installed"
        },
        cache_directory: cache.to_string_lossy().into_owned(),
        offline_ready: ready || cache_contains_model_data(&cache),
        progress_percent: if installing || ready {
            Some(MODEL_INSTALL_PROGRESS.load(Ordering::Acquire))
        } else {
            None
        },
        retry_count: MODEL_RETRY_COUNT.load(Ordering::Acquire),
        last_error,
    })
}

pub fn install(allow_download: bool) -> Result<()> {
    let attempts = if allow_download { 3 } else { 1 };
    for attempt in 0..attempts {
        let result = manager()
            .lock()
            .map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "Embedding model manager is poisoned",
                )
            })?
            .ensure_installed(allow_download)
            .map(|_| ());
        match result {
            Ok(()) => return Ok(()),
            Err(source) if attempt + 1 < attempts => {
                std::thread::sleep(std::time::Duration::from_millis(500 * (attempt + 1) as u64));
                eprintln!(
                    "folzeur model install attempt {} failed: {source}; retrying",
                    attempt + 1
                );
            }
            Err(source) => return Err(source),
        }
    }
    Err(Error::new(
        Status::GenericFailure,
        "Embedding model installation exhausted its retry budget",
    ))
}

pub fn set_download_allowed(allowed: bool) {
    MODEL_DOWNLOAD_ALLOWED.store(allowed, Ordering::SeqCst);
}

/// Enriches the code chunk with contextual metadata before embedding.
pub fn enrich_context(file_path: &str, node_name: &str, code: &str) -> String {
    format!("search_document: File: {file_path} | Symbol: {node_name} | Code:\n{code}")
}

/// Embeds multiple texts in bounded batches and converts native panics into recoverable N-API errors.
pub fn embed_texts(texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let mut manager = manager().lock().map_err(|_| {
        Error::new(
            Status::GenericFailure,
            "Embedding model manager is poisoned",
        )
    })?;
    let model = manager.ensure_installed(MODEL_DOWNLOAD_ALLOWED.load(Ordering::SeqCst))?;
    let references: Vec<&str> = texts.iter().map(String::as_str).collect();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        model.embed(references, Some(EMBEDDING_BATCH_SIZE))
    })) {
        Ok(Ok(embeddings)) => Ok(embeddings),
        Ok(Err(source)) => Err(Error::new(
            Status::GenericFailure,
            format!("Embedding failed: {source}"),
        )),
        Err(_) => Err(Error::new(
            Status::GenericFailure,
            "The embedding runtime panicked; the host process was protected",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_model_status_without_initializing_or_downloading() {
        let status = status().expect("model status");
        assert!(!status.cache_directory.is_empty());
    }
}
