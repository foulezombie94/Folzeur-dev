# Folzeur Backend

Native Rust sidecar for the Folzeur VS Code workbench. It communicates with the TypeScript service through newline-delimited JSON over standard input/output.

RAG is provided exclusively by the local `folzeur-rag-native` engine (Tantivy, LanceDB, and FastEmbed).

```powershell
cargo build --manifest-path folzeur-backend/Cargo.toml --release
$env:FOLZEUR_BACKEND_PATH="$PWD\folzeur-backend\target\release\folzeur-backend.exe"
```
