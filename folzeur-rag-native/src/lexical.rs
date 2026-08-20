use napi::{Error, Result, Status};
use serde_json::json;
use std::path::Path;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, Schema, Value, STORED, STRING, TEXT};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};

pub const LEXICAL_SCHEMA_VERSION: u32 = 3;
const INDEX_DIR: &str = "tantivy-v3";
const VERSION_FILE: &str = "schema-version";

#[derive(Clone)]
struct Fields {
    id: Field,
    file_path: Field,
    path_search: Field,
    line_start: Field,
    line_end: Field,
    content: Field,
    search_text: Field,
    name: Field,
}

fn error(context: &str, source: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {source}"))
}

fn open(generation_root: &str) -> Result<(Index, Fields)> {
    let directory = Path::new(generation_root).join(INDEX_DIR);
    std::fs::create_dir_all(&directory)
        .map_err(|source| error("Failed to create lexical index", source))?;
    let mut builder = Schema::builder();
    let id = builder.add_text_field("id", STRING | STORED);
    let file_path = builder.add_text_field("file_path", STRING | STORED);
    let path_search = builder.add_text_field("path_search", TEXT);
    let line_start = builder.add_u64_field("line_start", STORED);
    let line_end = builder.add_u64_field("line_end", STORED);
    let content = builder.add_text_field("content", STORED);
    let search_text = builder.add_text_field("search_text", TEXT);
    let name = builder.add_text_field("name", TEXT | STORED);
    let schema = builder.build();
    let index = if directory.join("meta.json").exists() {
        let version = std::fs::read_to_string(directory.join(VERSION_FILE)).map_err(|source| {
            error(
                "Missing lexical schema version; controlled rebuild required",
                source,
            )
        })?;
        if version.trim() != LEXICAL_SCHEMA_VERSION.to_string() {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unsupported lexical schema version {}; expected {LEXICAL_SCHEMA_VERSION}",
                    version.trim()
                ),
            ));
        }
        let index = Index::open_in_dir(&directory)
            .map_err(|source| error("Failed to open lexical index", source))?;
        if index.schema() != schema {
            return Err(Error::new(
                Status::GenericFailure,
                "Tantivy schema does not match the current lexical schema",
            ));
        }
        index
    } else {
        let index = Index::create_in_dir(&directory, schema)
            .map_err(|source| error("Failed to create lexical index", source))?;
        std::fs::write(
            directory.join(VERSION_FILE),
            LEXICAL_SCHEMA_VERSION.to_string(),
        )
        .map_err(|source| error("Failed to persist lexical schema version", source))?;
        index
    };
    Ok((
        index,
        Fields {
            id,
            file_path,
            path_search,
            line_start,
            line_end,
            content,
            search_text,
            name,
        },
    ))
}

/// Adds identifier components so camelCase and snake_case queries match code symbols.
fn expand_identifiers(text: &str) -> String {
    let mut output = String::with_capacity(text.len() + text.len() / 3);
    output.push_str(text);
    for token in text.split(|character: char| !character.is_alphanumeric() && character != '_') {
        if token.is_empty() {
            continue;
        }
        output.push(' ');
        let mut previous_was_lowercase = false;
        for character in token.chars() {
            if character == '_' {
                output.push(' ');
                previous_was_lowercase = false;
            } else {
                if character.is_uppercase() && previous_was_lowercase {
                    output.push(' ');
                }
                output.extend(character.to_lowercase());
                previous_was_lowercase = character.is_lowercase() || character.is_ascii_digit();
            }
        }
    }
    output
}

pub fn replace_file(
    workspace_path: &str,
    file_path: &str,
    chunks: &[crate::chunker::CodeChunk],
) -> Result<()> {
    let mut transaction = LexicalWriter::new(workspace_path)?;
    transaction.replace_file(file_path, chunks)?;
    transaction.commit()
}

pub struct LexicalWriter {
    writer: IndexWriter,
    fields: Fields,
}

impl LexicalWriter {
    pub fn new(workspace_path: &str) -> Result<Self> {
        let (index, fields) = open(workspace_path)?;
        let writer = index
            .writer(64 * 1024 * 1024)
            .map_err(|source| error("Failed to acquire lexical writer", source))?;
        Ok(Self { writer, fields })
    }

    pub fn replace_file(
        &mut self,
        file_path: &str,
        chunks: &[crate::chunker::CodeChunk],
    ) -> Result<()> {
        delete_file_inner(&mut self.writer, self.fields.file_path, file_path);
        for chunk in chunks {
            let id =
                xxhash_rust::xxh3::xxh3_64(format!("{file_path}\0{}", chunk.stable_id).as_bytes());
            self.writer
                .add_document(doc!(
                        self.fields.id => format!("{id:016x}"),
                        self.fields.file_path => file_path,
                        self.fields.path_search => expand_identifiers(file_path),
                        self.fields.line_start => chunk.line_start as u64,
                        self.fields.line_end => chunk.line_end as u64,
                        self.fields.content => chunk.content.clone(),
                        self.fields.search_text => expand_identifiers(&chunk.content),
                        self.fields.name => expand_identifiers(&chunk.name),
                ))
                .map_err(|source| error("Failed to add lexical document", source))?;
        }
        Ok(())
    }

    pub fn delete_file(&mut self, file_path: &str) {
        delete_file_inner(&mut self.writer, self.fields.file_path, file_path);
    }

    pub fn commit(&mut self) -> Result<()> {
        self.writer
            .commit()
            .map(|_| ())
            .map_err(|source| error("Failed to commit lexical index", source))
    }
}

pub fn delete_file(workspace_path: &str, file_path: &str) -> Result<()> {
    let mut transaction = LexicalWriter::new(workspace_path)?;
    transaction.delete_file(file_path);
    transaction.commit()
}

fn delete_file_inner(writer: &mut IndexWriter, file_field: Field, file_path: &str) {
    writer.delete_term(Term::from_field_text(file_field, file_path));
}

pub fn search(workspace_path: &str, query: &str, top_k: usize) -> Result<Vec<serde_json::Value>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let (index, fields) = open(workspace_path)?;
    let reader: IndexReader = index
        .reader_builder()
        .reload_policy(ReloadPolicy::OnCommitWithDelay)
        .try_into()
        .map_err(|source| error("Failed to open lexical reader", source))?;
    let searcher = reader.searcher();
    let mut parser = QueryParser::for_index(
        &index,
        vec![fields.search_text, fields.name, fields.path_search],
    );
    parser.set_field_boost(fields.name, 2.5);
    parser.set_field_boost(fields.path_search, 2.0);
    let (parsed, _) = parser.parse_query_lenient(&expand_identifiers(query));
    let documents = searcher
        .search(&parsed, &TopDocs::with_limit(top_k).order_by_score())
        .map_err(|source| error("Lexical search failed", source))?;
    Ok(documents
        .into_iter()
        .filter_map(|(score, address)| {
            let document: TantivyDocument = searcher.doc(address).ok()?;
            Some(json!({
                "file_path": document.get_first(fields.file_path)?.as_str()?,
                "line_start": document.get_first(fields.line_start)?.as_u64()?,
                "line_end": document.get_first(fields.line_end)?.as_u64()?,
                "content": document.get_first(fields.content)?.as_str()?,
                "score": score,
            }))
        })
        .collect())
}

pub fn validate(generation_root: &str) -> Result<usize> {
    let (index, _) = open(generation_root)?;
    let reader: IndexReader = index
        .reader()
        .map_err(|source| error("Failed to open lexical reader during validation", source))?;
    Ok(reader.searcher().num_docs() as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_code_identifiers() {
        let expanded = expand_identifiers("getUserBy_ID");
        assert!(expanded.contains("user"));
        assert!(expanded.contains("get user by id"));
    }

    #[test]
    fn retrieval_fixture_ranks_expected_symbol_first_and_tolerates_syntax() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().to_string_lossy();
        let chunks = vec![
            crate::chunker::CodeChunk {
                stable_id: "user".to_owned(),
                name: "getUserById".to_owned(),
                content: "function getUserById(id) { return users.get(id); }".to_owned(),
                line_start: 10,
                line_end: 10,
            },
            crate::chunker::CodeChunk {
                stable_id: "cache".to_owned(),
                name: "clearCache".to_owned(),
                content: "function clearCache() { cache.clear(); }".to_owned(),
                line_start: 20,
                line_end: 20,
            },
        ];
        replace_file(&workspace, "src/users.ts", &chunks).unwrap();

        let results = search(&workspace, "get user by id", 5).unwrap();
        assert_eq!(results[0]["line_start"], 10);
        assert!(search(&workspace, "unclosed:(", 5).is_ok());
    }
}
