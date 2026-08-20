use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use napi::{Error, Result, Status};
use std::path::{Path, PathBuf};

const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;

const DEFAULT_EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    ".folzeur",
    ".hg",
    ".history",
    ".idea",
    ".svn",
    ".turbo",
    ".vscode",
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
    ".ds_store",
    ".env",
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "secrets.json",
    "thumbs.db",
];

const SECRET_EXTENSIONS: &[&str] = &[
    "db", "der", "dump", "jks", "key", "keystore", "log", "ovpn", "p12", "pfx", "pem", "sql",
    "sqlite", "sqlite3",
];

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

pub fn is_indexable_file(path: &Path) -> bool {
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

pub fn build_excludes(patterns: &[String]) -> Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for raw in patterns {
        let pattern = raw.trim().replace('\\', "/");
        if pattern.is_empty() {
            continue;
        }
        let pattern = pattern.trim_start_matches('/');
        let candidates = if pattern.contains('/')
            || pattern.contains('*')
            || pattern.contains('?')
            || pattern.contains('[')
        {
            vec![pattern.to_owned()]
        } else {
            vec![format!("**/{pattern}"), format!("**/{pattern}/**")]
        };
        for candidate in candidates {
            builder.add(Glob::new(&candidate).map_err(|source| {
                Error::new(
                    Status::InvalidArg,
                    format!("Invalid exclude glob '{raw}': {source}"),
                )
            })?);
        }
    }
    builder.build().map_err(|source| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid exclude glob set: {source}"),
        )
    })
}

pub fn is_within(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok()
}

fn relative_matches(root: &Path, path: &Path, excludes: &GlobSet) -> bool {
    path.strip_prefix(root)
        .ok()
        .is_some_and(|relative| excludes.is_match(relative.to_string_lossy().replace('\\', "/")))
}

pub fn is_explicit_file_allowed(root: &Path, path: &Path, excludes: &GlobSet) -> Result<bool> {
    let canonical_root = dunce::canonicalize(root).map_err(|source| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid workspace path: {source}"),
        )
    })?;
    let canonical_path = match dunce::canonicalize(path) {
        Ok(path) => path,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(source) => {
            return Err(Error::new(
                Status::GenericFailure,
                format!("Unable to canonicalize {}: {source}", path.display()),
            ))
        }
    };
    if !is_within(&canonical_root, &canonical_path) || !is_indexable_file(&canonical_path) {
        return Ok(false);
    }
    let metadata = std::fs::metadata(&canonical_path).map_err(|source| {
        Error::new(
            Status::GenericFailure,
            format!("Unable to inspect {}: {source}", canonical_path.display()),
        )
    })?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_SIZE {
        return Ok(false);
    }
    Ok(!relative_matches(
        &canonical_root,
        &canonical_path,
        excludes,
    ))
}

/// Detects credential material before code reaches either local index.
pub fn contains_secret_content(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    let unmistakable = [
        "-----begin private key-----",
        "-----begin rsa private key-----",
        "-----begin openssh private key-----",
        "aws_secret_access_key",
        "github_pat_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "xoxb-",
        "xoxp-",
        "sk-proj-",
        "AIzaSy",
        "private_key_id",
    ];
    if unmistakable
        .iter()
        .any(|needle| lower.contains(&needle.to_ascii_lowercase()))
    {
        return true;
    }
    for line in content.lines().take(20_000) {
        let trimmed = line.trim();
        let line_lower = trimmed.to_ascii_lowercase();
        let assignment = [
            "api_key",
            "apikey",
            "access_token",
            "auth_token",
            "client_secret",
            "password",
            "passwd",
            "secret_key",
        ]
        .iter()
        .any(|name| {
            line_lower.starts_with(name)
                || line_lower.contains(&format!("{name}:"))
                || line_lower.contains(&format!("{name} ="))
        });
        if assignment {
            let candidate = trimmed
                .split_once('=')
                .map(|(_, value)| value)
                .or_else(|| trimmed.split_once(':').map(|(_, value)| value))
                .unwrap_or_default()
                .trim()
                .trim_matches(|character| matches!(character, '\'' | '"' | ',' | ';'));
            if candidate.len() >= 12
                && candidate != "process.env"
                && !candidate.starts_with("process.env.")
                && !candidate.starts_with("std::env::")
                && !candidate.starts_with("os.environ")
                && !candidate.contains("${")
                && !candidate.contains("example")
                && !candidate.contains("placeholder")
            {
                return true;
            }
        }
        for token in trimmed.split(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    '\'' | '"' | '`' | ',' | ';' | '(' | ')' | '{' | '}'
                )
        }) {
            if token.len() >= 24
                && shannon_entropy(token) >= 4.2
                && token
                    .chars()
                    .any(|character| character.is_ascii_lowercase())
                && token
                    .chars()
                    .any(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
            {
                return true;
            }
        }
    }
    false
}

fn shannon_entropy(value: &str) -> f64 {
    let mut counts = [0usize; 128];
    let mut length = 0usize;
    for byte in value.bytes().filter(|byte| byte.is_ascii()) {
        counts[byte as usize] += 1;
        length += 1;
    }
    if length == 0 {
        return 0.0;
    }
    counts
        .into_iter()
        .filter(|count| *count > 0)
        .map(|count| {
            let probability = count as f64 / length as f64;
            -probability * probability.log2()
        })
        .sum()
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
    let canonical_root = dunce::canonicalize(root.as_ref()).map_err(|error| {
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

    let excludes = build_excludes(exclude_patterns)?;
    let filter_root = canonical_root.clone();

    builder.filter_entry(move |entry| {
        let path = entry.path();
        if relative_matches(&filter_root, path, &excludes) {
            return false;
        }
        if entry.file_type().is_some_and(|kind| kind.is_symlink()) {
            return false;
        }
        if entry.file_type().is_some_and(|kind| kind.is_dir()) {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            return !DEFAULT_EXCLUDED_DIRECTORIES.contains(&name.as_str());
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
                let canonical_path = dunce::canonicalize(path).map_err(|source| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Unable to canonicalize {}: {source}", path.display()),
                    )
                })?;
                if !is_within(&canonical_root, &canonical_path) {
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
        std::fs::create_dir_all(directory.path().join("config/ssl")).unwrap();
        std::fs::create_dir_all(directory.path().join("nested/.ssh")).unwrap();
        std::fs::create_dir_all(directory.path().join("nested/.history")).unwrap();
        std::fs::create_dir_all(directory.path().join("nested/.vscode")).unwrap();
        std::fs::create_dir_all(directory.path().join("nested/.idea")).unwrap();
        std::fs::write(directory.path().join("main.rs"), "fn main() {}").unwrap();
        std::fs::write(directory.path().join(".env.local"), "TOKEN=secret").unwrap();
        std::fs::write(directory.path().join("private.pem"), "secret").unwrap();
        for relative in [
            "config/ssl/server.key",
            "nested/.ssh/id_rsa",
            "nested/.ssh/id_ed25519",
            "nested/signing.jks",
            "nested/release.keystore",
            "nested/client.ovpn",
            "nested/users.sqlite",
            "nested/users.sqlite3",
            "nested/cache.db",
            "nested/backup.sql",
            "nested/backup.dump",
            "nested/debug.log",
            "nested/.history/private.ts",
            "nested/.vscode/settings.json",
            "nested/.idea/workspace.xml",
            "nested/.DS_Store",
            "nested/Thumbs.db",
        ] {
            std::fs::write(directory.path().join(relative), "sensitive").unwrap();
        }
        std::fs::write(directory.path().join("image.png"), b"binary").unwrap();
        std::fs::write(
            directory.path().join("node_modules/pkg/index.js"),
            "ignored",
        )
        .unwrap();

        let files = collect_files_to_index(directory.path(), &[]).unwrap();
        assert_eq!(
            files,
            vec![dunce::canonicalize(directory.path().join("main.rs")).unwrap()]
        );
    }

    #[test]
    fn supports_full_globs_and_detects_content_secrets() {
        let directory = tempfile::tempdir().expect("temporary directory");
        std::fs::create_dir_all(directory.path().join("src/generated"))
            .expect("create generated directory");
        std::fs::write(
            directory.path().join("src/generated/code.ts"),
            "export const value = 1",
        )
        .expect("write generated file");
        std::fs::write(
            directory.path().join("src/keep.ts"),
            "export const value = 1",
        )
        .expect("write kept file");
        let files = collect_files_to_index(directory.path(), &["**/generated/**".to_owned()])
            .expect("scan workspace");
        assert_eq!(
            files,
            vec![dunce::canonicalize(directory.path().join("src/keep.ts"))
                .expect("canonical kept file")]
        );
        assert!(contains_secret_content(
            "const api_key = 'AbCdEf0123456789GhIjKlMn';"
        ));
        assert!(!contains_secret_content(
            "const api_key = process.env.API_KEY;"
        ));

        let excludes =
            build_excludes(&["**/generated/**".to_owned()]).expect("compile exclude patterns");
        assert!(is_explicit_file_allowed(
            directory.path(),
            &directory.path().join("src/keep.ts"),
            &excludes
        )
        .expect("check explicit file"));
        assert!(!is_explicit_file_allowed(
            directory.path(),
            &directory.path().join("src/generated/code.ts"),
            &excludes
        )
        .expect("check excluded explicit file"));
        assert!(is_within(
            Path::new("workspace"),
            Path::new("workspace/src/main.rs")
        ));
        assert!(!is_within(
            Path::new("workspace"),
            Path::new("workspace-sibling/src/main.rs")
        ));
    }
}
