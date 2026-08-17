use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use napi::bindgen_prelude::*;
use std::sync::OnceLock;

pub const EMBEDDING_DIMENSION: i32 = 768;
pub const EMBEDDING_SIGNATURE: &str = "nomic-embed-text-v1.5|max_length=512|document-prefix=v1";
const MAX_MODEL_TOKENS: usize = 512;
const EMBEDDING_BATCH_SIZE: usize = 32;

// Singleton to avoid reloading the 130MB model on every call
static EMBEDDER: OnceLock<TextEmbedding> = OnceLock::new();

fn get_embedder() -> Result<&'static TextEmbedding> {
    if let Some(embedder) = EMBEDDER.get() {
        return Ok(embedder);
    }
    let embedder = TextEmbedding::try_new(InitOptions {
        model_name: EmbeddingModel::NomicEmbedTextV15,
        max_length: MAX_MODEL_TOKENS,
        show_download_progress: true,
        ..Default::default()
    })
    .map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to initialize FastEmbed: {}", e),
        )
    })?;
    let _ = EMBEDDER.set(embedder);
    EMBEDDER
        .get()
        .ok_or_else(|| Error::new(Status::GenericFailure, "FastEmbed initialization race"))
}

/// Enriches the code chunk with contextual metadata before embedding.
pub fn enrich_context(file_path: &str, node_name: &str, code: &str) -> String {
    format!("search_document: File: {file_path} | Symbol: {node_name} | Code:\n{code}")
}

/// Embeds multiple texts by batching them.
pub fn embed_texts(texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(vec![]);
    }

    let embedder = get_embedder()?;

    let texts_refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
    let embeddings = embedder
        .embed(texts_refs, Some(EMBEDDING_BATCH_SIZE))
        .map_err(|e| Error::new(Status::GenericFailure, format!("Embedding failed: {}", e)))?;

    Ok(embeddings)
}
