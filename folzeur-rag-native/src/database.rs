use arrow_array::{
    Array, FixedSizeListArray, Float32Array, Int32Array, RecordBatch, RecordBatchIterator,
    StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use futures_util::StreamExt;
use lancedb::index::{scalar::BTreeIndexBuilder, vector::IvfHnswSqIndexBuilder, Index};
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::{connect, connection::Connection, DistanceType};
use napi::{Error, Result, Status};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

pub const RAG_SCHEMA_VERSION: u32 = 3;
const TABLE_NAME: &str = "code_chunks_v3";
const ANN_MIN_ROWS: usize = 256;
const VECTOR_DIMENSION: i32 = crate::embedder::EMBEDDING_DIMENSION;

fn error(context: &str, source: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{context}: {source}"))
}

fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("file_path", DataType::Utf8, false),
        Field::new("line_start", DataType::Int32, false),
        Field::new("line_end", DataType::Int32, false),
        Field::new("content", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                VECTOR_DIMENSION,
            ),
            false,
        ),
    ]))
}

pub async fn get_connection(generation_root: &str) -> Result<Connection> {
    let db_path = Path::new(generation_root).join("lancedb-v3");
    connect(db_path.to_string_lossy().as_ref())
        .execute()
        .await
        .map_err(|source| error("Failed to connect to LanceDB", source))
}

fn escape_sql(value: &str) -> String {
    value.replace('\'', "''")
}

pub fn chunk_id(file_path: &str, stable_id: &str) -> String {
    let id = xxhash_rust::xxh3::xxh3_64(format!("{file_path}\0{stable_id}").as_bytes());
    format!("{id:016x}")
}

pub async fn existing_embeddings(
    workspace_path: &str,
    file_path: &str,
) -> Result<HashMap<String, Vec<f32>>> {
    let connection = get_connection(workspace_path).await?;
    let table = match connection.open_table(TABLE_NAME).execute().await {
        Ok(table) => table,
        Err(lancedb::Error::TableNotFound { .. }) => return Ok(HashMap::new()),
        Err(source) => {
            return Err(error(
                "Failed to open vector table for cached embeddings",
                source,
            ))
        }
    };
    let mut stream = table
        .query()
        .only_if(format!("file_path = '{}'", escape_sql(file_path)))
        .execute()
        .await
        .map_err(|source| error("Failed to read cached embeddings", source))?;
    let mut embeddings = HashMap::new();
    while let Some(result) = stream.next().await {
        let batch = result.map_err(|source| error("Failed to decode cached embeddings", source))?;
        let Some(ids) = batch.column(0).as_any().downcast_ref::<StringArray>() else {
            return Err(Error::new(
                Status::GenericFailure,
                "Unexpected cached id column",
            ));
        };
        let Some(vectors) = batch
            .column(5)
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
        else {
            return Err(Error::new(
                Status::GenericFailure,
                "Unexpected cached vector column",
            ));
        };
        for row in 0..batch.num_rows() {
            let values = vectors.value(row);
            let Some(values) = values.as_any().downcast_ref::<Float32Array>() else {
                return Err(Error::new(
                    Status::GenericFailure,
                    "Unexpected cached vector values",
                ));
            };
            embeddings.insert(ids.value(row).to_owned(), values.values().to_vec());
        }
    }
    Ok(embeddings)
}

pub async fn delete_file_chunks(workspace_path: &str, file_path: &str) -> Result<()> {
    let connection = get_connection(workspace_path).await?;
    match connection.open_table(TABLE_NAME).execute().await {
        Ok(table) => {
            table
                .delete(&format!("file_path = '{}'", escape_sql(file_path)))
                .await
                .map_err(|source| error("Failed to delete stale vectors", source))?;
        }
        Err(lancedb::Error::TableNotFound { .. }) => {}
        Err(source) => return Err(error("Failed to open vector table for deletion", source)),
    }
    Ok(())
}

fn build_batch(
    file_path: &str,
    chunks: &[crate::chunker::CodeChunk],
    embeddings: &[Vec<f32>],
) -> Result<RecordBatch> {
    if chunks.len() != embeddings.len() {
        return Err(Error::new(
            Status::InvalidArg,
            "Chunk and embedding counts differ",
        ));
    }

    let mut ids = arrow_array::builder::StringBuilder::new();
    let mut paths = arrow_array::builder::StringBuilder::new();
    let mut starts = arrow_array::builder::Int32Builder::new();
    let mut ends = arrow_array::builder::Int32Builder::new();
    let mut contents = arrow_array::builder::StringBuilder::new();
    let mut vectors = arrow_array::builder::FixedSizeListBuilder::new(
        arrow_array::builder::Float32Builder::new(),
        VECTOR_DIMENSION,
    );

    for (chunk, embedding) in chunks.iter().zip(embeddings) {
        if embedding.len() != VECTOR_DIMENSION as usize {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Embedding dimension {} does not match expected {VECTOR_DIMENSION}",
                    embedding.len()
                ),
            ));
        }
        ids.append_value(chunk_id(file_path, &chunk.stable_id));
        paths.append_value(file_path);
        starts.append_value(chunk.line_start as i32);
        ends.append_value(chunk.line_end as i32);
        contents.append_value(&chunk.content);
        for value in embedding {
            vectors.values().append_value(*value);
        }
        vectors.append(true);
    }

    RecordBatch::try_new(
        schema(),
        vec![
            Arc::new(ids.finish()) as Arc<dyn Array>,
            Arc::new(paths.finish()),
            Arc::new(starts.finish()),
            Arc::new(ends.finish()),
            Arc::new(contents.finish()),
            Arc::new(vectors.finish()),
        ],
    )
    .map_err(|source| error("Failed to create Arrow batch", source))
}

/// Replaces all chunks for one file in a single Lance transaction.
pub async fn upsert_chunks(
    workspace_path: &str,
    file_path: &str,
    chunks: Vec<crate::chunker::CodeChunk>,
    embeddings: Vec<Vec<f32>>,
) -> Result<()> {
    if chunks.is_empty() {
        return delete_file_chunks(workspace_path, file_path).await;
    }
    let batch = build_batch(file_path, &chunks, &embeddings)?;
    let batch_schema = batch.schema();
    let connection = get_connection(workspace_path).await?;

    match connection.open_table(TABLE_NAME).execute().await {
        Ok(table) => {
            let reader = RecordBatchIterator::new(vec![Ok(batch)], batch_schema);
            let mut merge = table.merge_insert(&["id"]);
            merge
                .when_matched_update_all(None)
                .when_not_matched_insert_all()
                .when_not_matched_by_source_delete(Some(format!(
                    "file_path = '{}'",
                    escape_sql(file_path)
                )));
            merge
                .execute(Box::new(reader))
                .await
                .map_err(|source| error("Atomic vector upsert failed", source))?;
        }
        Err(lancedb::Error::TableNotFound { .. }) => {
            connection
                .create_table(TABLE_NAME, vec![batch])
                .execute()
                .await
                .map_err(|source| error("Failed to create vector table", source))?;
        }
        Err(source) => return Err(error("Failed to open vector table for upsert", source)),
    }
    Ok(())
}

/// Creates scalar and ANN indices once enough vectors exist for useful training.
pub async fn ensure_indices(workspace_path: &str) -> Result<()> {
    let connection = get_connection(workspace_path).await?;
    let table = match connection.open_table(TABLE_NAME).execute().await {
        Ok(table) => table,
        Err(lancedb::Error::TableNotFound { .. }) => return Ok(()),
        Err(source) => {
            return Err(error(
                "Failed to open vector table while ensuring indices",
                source,
            ))
        }
    };
    let existing = table
        .list_indices()
        .await
        .map_err(|source| error("Failed to list Lance indices", source))?;
    if !existing.iter().any(|index| index.columns == ["file_path"]) {
        table
            .create_index(&["file_path"], Index::BTree(BTreeIndexBuilder::default()))
            .execute()
            .await
            .map_err(|source| error("Failed to create file path index", source))?;
    }
    if table
        .count_rows(None)
        .await
        .map_err(|source| error("Failed to count vector rows", source))?
        >= ANN_MIN_ROWS
        && !existing.iter().any(|index| index.columns == ["vector"])
    {
        let index = IvfHnswSqIndexBuilder::default().distance_type(DistanceType::Cosine);
        table
            .create_index(&["vector"], Index::IvfHnswSq(index))
            .execute()
            .await
            .map_err(|source| error("Failed to create vector ANN index", source))?;
    }
    Ok(())
}

pub async fn search_chunks(
    workspace_path: &str,
    query_embedding: Vec<f32>,
    top_k: u32,
    threshold: f32,
) -> Result<Vec<serde_json::Value>> {
    if query_embedding.len() != VECTOR_DIMENSION as usize {
        return Err(Error::new(
            Status::InvalidArg,
            "Invalid query embedding dimension",
        ));
    }
    let connection = get_connection(workspace_path).await?;
    let table = match connection.open_table(TABLE_NAME).execute().await {
        Ok(table) => table,
        Err(lancedb::Error::TableNotFound { .. }) => return Ok(Vec::new()),
        Err(source) => return Err(error("Failed to open vector table for search", source)),
    };
    let mut stream = table
        .query()
        .nearest_to(query_embedding)
        .map_err(|source| error("Failed to construct vector query", source))?
        .distance_type(DistanceType::Cosine)
        .limit(top_k as usize)
        .execute()
        .await
        .map_err(|source| error("Vector search failed", source))?;

    let mut output = Vec::new();
    while let Some(result) = stream.next().await {
        let batch = result.map_err(|source| error("Vector result read failed", source))?;
        let paths = batch.column(1).as_any().downcast_ref::<StringArray>();
        let starts = batch.column(2).as_any().downcast_ref::<Int32Array>();
        let ends = batch.column(3).as_any().downcast_ref::<Int32Array>();
        let contents = batch.column(4).as_any().downcast_ref::<StringArray>();
        let distances = batch
            .column(batch.num_columns() - 1)
            .as_any()
            .downcast_ref::<Float32Array>();
        let (Some(paths), Some(starts), Some(ends), Some(contents), Some(distances)) =
            (paths, starts, ends, contents, distances)
        else {
            return Err(Error::new(
                Status::GenericFailure,
                "Unexpected Lance result schema",
            ));
        };
        for row in 0..batch.num_rows() {
            let distance = distances.value(row);
            if distance <= threshold {
                output.push(serde_json::json!({
                    "file_path": paths.value(row),
                    "line_start": starts.value(row),
                    "line_end": ends.value(row),
                    "content": contents.value(row),
                    "distance": distance,
                }));
            }
        }
    }
    Ok(output)
}

pub async fn validate(generation_root: &str) -> Result<usize> {
    let connection = get_connection(generation_root).await?;
    let table = match connection.open_table(TABLE_NAME).execute().await {
        Ok(table) => table,
        Err(lancedb::Error::TableNotFound { .. }) => return Ok(0),
        Err(source) => {
            return Err(error(
                "Failed to open vector table during validation",
                source,
            ))
        }
    };
    let actual = table
        .schema()
        .await
        .map_err(|source| error("Failed to read vector schema", source))?;
    if actual.as_ref() != schema().as_ref() {
        return Err(Error::new(
            Status::GenericFailure,
            "LanceDB schema does not match the current RAG schema",
        ));
    }
    table
        .count_rows(None)
        .await
        .map_err(|source| error("Failed to count vectors during validation", source))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, line: usize) -> crate::chunker::CodeChunk {
        crate::chunker::CodeChunk {
            stable_id: id.to_owned(),
            name: id.to_owned(),
            content: format!("fn {id}() {{}}"),
            line_start: line,
            line_end: line,
        }
    }

    fn vector(axis: usize) -> Vec<f32> {
        let mut vector = vec![0.0; VECTOR_DIMENSION as usize];
        vector[axis] = 1.0;
        vector
    }

    #[test]
    fn atomically_replaces_all_chunks_for_a_file() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().to_string_lossy().into_owned();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            upsert_chunks(
                &workspace,
                "quoted'file.rs",
                vec![chunk("first", 1), chunk("second", 2)],
                vec![vector(0), vector(1)],
            )
            .await
            .unwrap();
            upsert_chunks(
                &workspace,
                "quoted'file.rs",
                vec![chunk("second", 20)],
                vec![vector(1)],
            )
            .await
            .unwrap();

            let results = search_chunks(&workspace, vector(1), 10, 2.0).await.unwrap();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0]["line_start"], 20);
        });
    }
}
