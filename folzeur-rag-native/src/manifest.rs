use napi::{Error, Result, Status};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::time::UNIX_EPOCH;

pub const MANIFEST_SCHEMA_VERSION: u32 = 4;
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FileState {
    pub hash: String,
    pub size: u64,
    pub modified_ns: u128,
}

impl FileState {
    pub fn from_content(content: &[u8], metadata: &std::fs::Metadata) -> Self {
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_nanos());
        Self {
            hash: content_hash(content),
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

    pub fn content_matches(&self, path: &Path) -> Result<bool> {
        let content =
            fs::read(path).map_err(|source| error("Failed to hash unchanged file", source))?;
        Ok(self.hash == content_hash(&content))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub generation_id: u64,
    pub embedding_signature: String,
    pub files: HashMap<String, FileState>,
}

#[derive(Deserialize, Serialize)]
struct ManifestCheckpoint {
    manifest: Manifest,
    sha256: String,
}

#[derive(Serialize)]
struct CanonicalManifest<'a> {
    schema_version: u32,
    generation_id: u64,
    embedding_signature: &'a str,
    files: BTreeMap<&'a str, &'a FileState>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            generation_id: 0,
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

    pub fn load(generation_root: &Path) -> Result<Self> {
        let path = generation_root.join(MANIFEST_FILE);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(source) => return Err(error("Failed to read manifest", source)),
        };
        let value = serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|source| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Corrupt RAG manifest at {}: {source}; a controlled rebuild is required",
                    path.display()
                ),
            )
        })?;
        if value.get("manifest").is_some() {
            let checkpoint = serde_json::from_value::<ManifestCheckpoint>(value).map_err(|source| {
				Error::new(
					Status::GenericFailure,
					format!("Corrupt RAG manifest checkpoint at {}: {source}; a controlled rebuild is required", path.display()),
				)
			})?;
            if checkpoint.sha256 != manifest_integrity_hash(&checkpoint.manifest)? {
                return Err(Error::new(
                        Status::GenericFailure,
                        format!(
                            "RAG manifest integrity check failed at {}; a controlled rebuild is required",
                            path.display()
                        ),
                    ));
            }
            Ok(checkpoint.manifest)
        } else {
            serde_json::from_value::<Manifest>(value).map_err(|source| {
				Error::new(
					Status::GenericFailure,
					format!("Corrupt legacy RAG manifest at {}: {source}; a controlled rebuild is required", path.display()),
				)
			})
        }
    }

    pub fn save(&mut self, generation_root: &Path, generation_id: u64) -> Result<()> {
        self.schema_version = MANIFEST_SCHEMA_VERSION;
        self.embedding_signature = crate::embedder::EMBEDDING_SIGNATURE.to_owned();
        self.generation_id = generation_id;
        fs::create_dir_all(generation_root)
            .map_err(|source| error("Failed to create manifest directory", source))?;
        let target = generation_root.join(MANIFEST_FILE);
        let temporary = target.with_extension(format!("tmp-{}", std::process::id()));
        let bytes = serde_json::to_vec(&ManifestCheckpoint {
            sha256: manifest_integrity_hash(self)?,
            manifest: self.clone(),
        })
        .map_err(|source| error("Failed to serialize manifest checkpoint", source))?;
        let mut file = File::create(&temporary)
            .map_err(|source| error("Failed to create manifest checkpoint", source))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|source| error("Failed to persist manifest checkpoint", source))?;
        if target.exists() {
            fs::remove_file(&target)
                .map_err(|source| error("Failed to rotate manifest", source))?;
        }
        fs::rename(&temporary, &target)
            .map_err(|source| error("Failed to publish manifest checkpoint", source))
    }
}

pub fn content_hash(content: &[u8]) -> String {
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(content))
}

fn integrity_hash(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn manifest_integrity_hash(manifest: &Manifest) -> Result<String> {
    let canonical = CanonicalManifest {
        schema_version: manifest.schema_version,
        generation_id: manifest.generation_id,
        embedding_signature: &manifest.embedding_signature,
        files: manifest
            .files
            .iter()
            .map(|(path, state)| (path.as_str(), state))
            .collect(),
    };
    serde_json::to_vec(&canonical)
        .map(|bytes| integrity_hash(&bytes))
        .map_err(|source| error("Failed to hash manifest checkpoint", source))
}

fn error(context: &str, source: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {source}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corruption_is_reported_instead_of_silently_reset() {
        let directory = tempfile::tempdir().expect("temporary directory");
        fs::write(directory.path().join(MANIFEST_FILE), "broken").expect("write corrupt manifest");
        assert!(Manifest::load(directory.path()).is_err());
    }

    #[test]
    fn content_hash_detects_same_metadata_content_change() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("file.rs");
        fs::write(&path, "first").expect("write file");
        let metadata = fs::metadata(&path).expect("metadata");
        let state = FileState::from_content(b"first", &metadata);
        fs::write(&path, "other").expect("rewrite same-size file");
        assert!(!state.content_matches(&path).expect("hash file"));
    }

    #[test]
    fn manifest_checkpoint_detects_tampering() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let mut manifest = Manifest::default();
        manifest.save(directory.path(), 7).expect("save manifest");
        let path = directory.path().join(MANIFEST_FILE);
        let mut checkpoint: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("read manifest"))
                .expect("decode checkpoint");
        checkpoint["manifest"]["generation_id"] = 8.into();
        fs::write(
            path,
            serde_json::to_vec(&checkpoint).expect("encode tampering"),
        )
        .expect("tamper manifest");
        assert!(Manifest::load(directory.path()).is_err());
    }

    #[test]
    fn manifest_checkpoint_hash_is_stable_across_file_order() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let metadata_path = directory.path().join("metadata");
        fs::write(&metadata_path, "value").expect("write metadata file");
        let metadata = fs::metadata(metadata_path).expect("metadata");
        let mut first = Manifest::default();
        first
            .files
            .insert("b.rs".to_owned(), FileState::from_content(b"b", &metadata));
        first
            .files
            .insert("a.rs".to_owned(), FileState::from_content(b"a", &metadata));
        let mut second = Manifest::default();
        second
            .files
            .insert("a.rs".to_owned(), FileState::from_content(b"a", &metadata));
        second
            .files
            .insert("b.rs".to_owned(), FileState::from_content(b"b", &metadata));
        assert_eq!(
            manifest_integrity_hash(&first).expect("first hash"),
            manifest_integrity_hash(&second).expect("second hash")
        );
    }

    #[test]
    fn populated_manifest_round_trips_through_checkpoint() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let file = directory.path().join("source.rs");
        fs::write(&file, "fn main() {}").expect("write source");
        let mut manifest = Manifest::default();
        manifest.files.insert(
            file.to_string_lossy().into_owned(),
            FileState::from_content(b"fn main() {}", &fs::metadata(&file).expect("metadata")),
        );
        manifest
            .save(directory.path(), 9)
            .expect("save populated manifest");
        let loaded = Manifest::load(directory.path()).expect("load populated manifest");
        assert_eq!(loaded.generation_id, 9);
        assert_eq!(loaded.files.len(), 1);
    }
}
