use napi::{Error, Result, Status};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MANIFEST_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FileState {
    pub hash: u64,
    pub size: u64,
    pub modified_ns: u128,
}

impl FileState {
    pub fn from_metadata(hash: u64, metadata: &std::fs::Metadata) -> Self {
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_nanos());
        Self {
            hash,
            size: metadata.len(),
            modified_ns,
        }
    }

    pub fn metadata_matches(&self, metadata: &std::fs::Metadata) -> bool {
        self.size == metadata.len()
            && metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .is_some_and(|duration| duration.as_nanos() == self.modified_ns)
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub generation: u64,
    pub embedding_signature: String,
    pub files: HashMap<String, FileState>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            generation: 0,
            embedding_signature: String::new(),
            files: HashMap::new(),
        }
    }
}

impl Manifest {
    pub fn is_compatible(&self) -> bool {
        self.schema_version == MANIFEST_SCHEMA_VERSION
            && self.embedding_signature == crate::embedder::EMBEDDING_SIGNATURE
    }

    pub fn load(workspace: &Path) -> Self {
        [slot_path(workspace, 0), slot_path(workspace, 1)]
            .into_iter()
            .filter_map(|path| fs::read(path).ok())
            .filter_map(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .filter(|manifest| manifest.schema_version <= MANIFEST_SCHEMA_VERSION)
            .max_by_key(|manifest| manifest.generation)
            .unwrap_or_default()
    }

    pub fn save(&mut self, workspace: &Path) -> Result<()> {
        self.schema_version = MANIFEST_SCHEMA_VERSION;
        self.embedding_signature = crate::embedder::EMBEDDING_SIGNATURE.to_owned();
        self.generation = self.generation.saturating_add(1);
        let directory = workspace.join(".folzeur");
        fs::create_dir_all(&directory)
            .map_err(|source| error("Failed to create manifest directory", source))?;
        let target = slot_path(workspace, self.generation as usize % 2);
        let temporary = target.with_extension(format!("tmp-{}", std::process::id()));
        let bytes = serde_json::to_vec(self)
            .map_err(|source| error("Failed to serialize manifest", source))?;
        let mut file = File::create(&temporary)
            .map_err(|source| error("Failed to create manifest checkpoint", source))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|source| error("Failed to persist manifest checkpoint", source))?;
        if target.exists() {
            fs::remove_file(&target)
                .map_err(|source| error("Failed to rotate manifest slot", source))?;
        }
        fs::rename(&temporary, &target)
            .map_err(|source| error("Failed to publish manifest checkpoint", source))?;
        Ok(())
    }
}

fn slot_path(workspace: &Path, slot: usize) -> PathBuf {
    workspace
        .join(".folzeur")
        .join(format!("manifest-{slot}.json"))
}

fn error(context: &str, source: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {source}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_previous_valid_slot() {
        let directory = tempfile::tempdir().unwrap();
        let mut manifest = Manifest::default();
        manifest.save(directory.path()).unwrap();
        manifest.files.insert(
            "file.rs".to_owned(),
            FileState {
                hash: 1,
                size: 2,
                modified_ns: 3,
            },
        );
        manifest.save(directory.path()).unwrap();
        std::fs::write(slot_path(directory.path(), 0), "broken").unwrap();

        let recovered = Manifest::load(directory.path());
        assert_eq!(recovered.generation, 1);
    }
}
