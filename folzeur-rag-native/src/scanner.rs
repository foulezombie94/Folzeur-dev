use ignore::WalkBuilder;
use napi::{Error, Result, Status};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;

const DEFAULT_EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    ".folzeur",
    ".hg",
    ".svn",
    ".turbo",
    ".yarn",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "vendor",
];

const INDEXABLE_EXTENSIONS: &[&str] = &[
    "c", "cc", "cpp", "cs", "css", "cxx", "go", "h", "hpp", "html", "java", "js", "json", "jsx",
    "kt", "kts", "lua", "md", "mjs", "php", "proto", "py", "rb", "rs", "scss", "sh", "sql",
    "swift", "toml", "ts", "tsx", "vue", "xml", "yaml", "yml",
];

const SECRET_FILENAMES: &[&str] = &[
    ".env",
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "secrets.json",
];

const SECRET_EXTENSIONS: &[&str] = &["der", "jks", "key", "p12", "pfx", "pem"];

fn is_secret(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    SECRET_FILENAMES.contains(&name.as_str())
        || name.starts_with(".env.")
        || SECRET_EXTENSIONS.contains(&extension.as_str())
}

fn is_indexable_file(path: &Path) -> bool {
    if is_secret(path) {
        return false;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.ends_with(".min.js") || name.ends_with(".min.css") {
        return false;
    }
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| INDEXABLE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Collects all indexable files in a directory while strictly respecting .gitignore
/// and explicitly rejecting common heavy/build directories.
pub fn collect_files_to_index<P: AsRef<Path>>(
    root: P,
    exclude_patterns: &[String],
) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    visit_files_to_index(root, exclude_patterns, |path| {
        files.push(path);
        Ok(())
    })?;
    files.sort_unstable();
    Ok(files)
}

/// Visits indexable files incrementally so callers can apply bounded backpressure.
pub fn visit_files_to_index<P: AsRef<Path>, F: FnMut(PathBuf) -> Result<()>>(
    root: P,
    exclude_patterns: &[String],
    mut visitor: F,
) -> Result<()> {
    let canonical_root = std::fs::canonicalize(root.as_ref()).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid workspace path: {error}"),
        )
    })?;
    if !canonical_root.is_dir() {
        return Err(Error::new(
            Status::InvalidArg,
            "Workspace path is not a directory",
        ));
    }

    let mut builder = WalkBuilder::new(&canonical_root);
    builder.add_custom_ignore_filename(".folzeurignore");
    builder.follow_links(false);

    let excludes: HashSet<String> = exclude_patterns
        .iter()
        .filter_map(|pattern| {
            Path::new(pattern)
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
        })
        .collect();

    builder.filter_entry(move |entry| {
        let path = entry.path();
        if entry.file_type().is_some_and(|kind| kind.is_symlink()) {
            return false;
        }
        if entry.file_type().is_some_and(|kind| kind.is_dir()) {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            return !DEFAULT_EXCLUDED_DIRECTORIES.contains(&name.as_str())
                && !excludes.contains(&name);
        }
        is_indexable_file(path)
    });

    for result in builder.build() {
        match result {
            Ok(entry) => {
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    continue;
                }
                let path = entry.path();
                let metadata = entry.metadata().map_err(|source| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Unable to inspect {}: {source}", path.display()),
                    )
                })?;
                if metadata.len() > MAX_FILE_SIZE {
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }
                let canonical_path = std::fs::canonicalize(path).map_err(|source| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Unable to canonicalize {}: {source}", path.display()),
                    )
                })?;
                if !canonical_path.starts_with(&canonical_root) {
                    return Err(Error::new(
                        Status::GenericFailure,
                        format!("Scanner path escaped workspace: {}", path.display()),
                    ));
                }
                if canonical_path != canonical_root {
                    visitor(canonical_path)?;
                }
            }
            Err(err) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("Workspace scan failed: {err}"),
                ))
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_secrets_build_outputs_and_binaries() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("node_modules/pkg")).unwrap();
        std::fs::write(directory.path().join("main.rs"), "fn main() {}").unwrap();
        std::fs::write(directory.path().join(".env.local"), "TOKEN=secret").unwrap();
        std::fs::write(directory.path().join("private.pem"), "secret").unwrap();
        std::fs::write(directory.path().join("image.png"), b"binary").unwrap();
        std::fs::write(
            directory.path().join("node_modules/pkg/index.js"),
            "ignored",
        )
        .unwrap();

        let files = collect_files_to_index(directory.path(), &[]).unwrap();
        assert_eq!(
            files,
            vec![std::fs::canonicalize(directory.path().join("main.rs")).unwrap()]
        );
    }
}
