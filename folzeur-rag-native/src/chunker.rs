use napi::bindgen_prelude::*;
use std::collections::HashMap;
use tree_sitter::{Node, Parser};

/// Conservative character budget for Nomic's 512-token context window.
const MAX_CHUNK_CHARS: usize = 1_600;
const LINE_OVERLAP: usize = 8;
const TARGET_LINES: usize = 60;

#[derive(Clone, Debug)]
pub struct CodeChunk {
    pub stable_id: String,
    pub name: String,
    pub content: String,
    /// One-based inclusive line number.
    pub line_start: usize,
    /// One-based inclusive line number.
    pub line_end: usize,
}

fn node_name(node: Node<'_>, source: &[u8]) -> String {
    node.child_by_field_name("name")
        .and_then(|name| std::str::from_utf8(&source[name.start_byte()..name.end_byte()]).ok())
        .unwrap_or_else(|| node.kind())
        .to_owned()
}

fn imports(root: Node<'_>, source: &[u8]) -> String {
    let mut output = String::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        let kind = child.kind();
        let is_import = kind == "import_statement"
            || kind == "import_declaration"
            || (kind == "lexical_declaration"
                && std::str::from_utf8(&source[child.start_byte()..child.end_byte()])
                    .is_ok_and(|text| text.contains("require(")));
        if !is_import {
            continue;
        }
        if let Ok(text) = std::str::from_utf8(&source[child.start_byte()..child.end_byte()]) {
            if output.chars().count() + text.chars().count() + 1 > 320 {
                break;
            }
            output.push_str(text);
            output.push('\n');
        }
    }
    output
}

fn truncate_at_char_boundary(text: &str, max_chars: usize) -> &str {
    text.char_indices()
        .nth(max_chars)
        .map_or(text, |(byte_index, _)| &text[..byte_index])
}

fn push_windows(
    chunks: &mut Vec<CodeChunk>,
    name: &str,
    text: &str,
    first_line: usize,
    global_imports: &str,
) {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return;
    }

    let mut start = 0;
    let mut window_index = 1;
    while start < lines.len() {
        let mut end = start;
        let mut characters = global_imports.chars().count();
        while end < lines.len() && end - start < TARGET_LINES {
            let next = lines[end].chars().count() + 1;
            if end > start && characters + next > MAX_CHUNK_CHARS {
                break;
            }
            characters += next;
            end += 1;
        }
        if end == start {
            end += 1;
        }

        let body = lines[start..end].join("\n");
        let body_budget = MAX_CHUNK_CHARS.saturating_sub(global_imports.chars().count());
        let body = truncate_at_char_boundary(&body, body_budget.max(1));
        let content = if global_imports.is_empty() {
            body.to_owned()
        } else {
            format!("{global_imports}\n{body}")
        };
        chunks.push(CodeChunk {
            stable_id: String::new(),
            name: if lines.len() > TARGET_LINES {
                format!("{name}#{window_index}")
            } else {
                name.to_owned()
            },
            content,
            line_start: first_line + start,
            line_end: first_line + end - 1,
        });
        window_index += 1;

        if end == lines.len() {
            break;
        }
        start = end.saturating_sub(LINE_OVERLAP).max(start + 1);
    }
}

fn has_strategic_child(node: Node<'_>) -> bool {
    let mut cursor = node.walk();
    let found = node.children(&mut cursor).any(|child| {
        matches!(
            child.kind(),
            "function_declaration"
                | "method_definition"
                | "interface_declaration"
                | "arrow_function"
        ) || has_strategic_child(child)
    });
    found
}

fn walk_ast(node: Node<'_>, source: &[u8], chunks: &mut Vec<CodeChunk>, global_imports: &str) {
    let kind = node.kind();
    let strategic = matches!(
        kind,
        "function_declaration"
            | "class_declaration"
            | "method_definition"
            | "interface_declaration"
            | "arrow_function"
    );

    // A class containing methods is only a container. Index its methods to avoid
    // duplicating the same body at class and method granularity.
    let emit = strategic && !(kind == "class_declaration" && has_strategic_child(node));
    if emit {
        if let Ok(text) = std::str::from_utf8(&source[node.start_byte()..node.end_byte()]) {
            push_windows(
                chunks,
                &node_name(node, source),
                text,
                node.start_position().row + 1,
                global_imports,
            );
        }
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_ast(child, source, chunks, global_imports);
    }
}

fn module_scope_chunks(root: Node<'_>, source: &[u8], global_imports: &str) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    let mut cursor = root.walk();
    for child in root.named_children(&mut cursor) {
        if matches!(child.kind(), "import_statement" | "import_declaration")
            || matches!(
                child.kind(),
                "function_declaration" | "class_declaration" | "interface_declaration"
            )
            || has_strategic_child(child)
        {
            continue;
        }
        if let Ok(text) = std::str::from_utf8(&source[child.start_byte()..child.end_byte()]) {
            if !text.trim().is_empty() {
                push_windows(
                    &mut chunks,
                    &format!("module:{}", child.kind()),
                    text,
                    child.start_position().row + 1,
                    global_imports,
                );
            }
        }
    }
    chunks
}

fn line_chunks(content: &str) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    push_windows(&mut chunks, "file_root", content, 1, "");
    chunks
}

fn assign_stable_ids(chunks: &mut [CodeChunk]) {
    let mut occurrences = HashMap::<u64, usize>::new();
    for chunk in chunks {
        let hash =
            xxhash_rust::xxh3::xxh3_64(format!("{}\0{}", chunk.name, chunk.content).as_bytes());
        let occurrence = occurrences.entry(hash).or_default();
        chunk.stable_id = format!("{hash:016x}:{occurrence}");
        *occurrence += 1;
    }
}

thread_local! {
    static JS_PARSER: std::cell::RefCell<Parser> = std::cell::RefCell::new({
        let mut parser = Parser::new();
        parser.set_language(&tree_sitter_javascript::LANGUAGE.into()).unwrap();
        parser
    });
    static TS_PARSER: std::cell::RefCell<Parser> = std::cell::RefCell::new({
        let mut parser = Parser::new();
        parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()).unwrap();
        parser
    });
    static TSX_PARSER: std::cell::RefCell<Parser> = std::cell::RefCell::new({
        let mut parser = Parser::new();
        parser.set_language(&tree_sitter_typescript::LANGUAGE_TSX.into()).unwrap();
        parser
    });
}

pub fn parse_and_chunk(file_path: &str, content: &str) -> Result<Vec<CodeChunk>> {
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let lower = file_path.to_ascii_lowercase();
    let tree = if lower.ends_with(".tsx") {
        TSX_PARSER.with(|parser| parser.borrow_mut().parse(content, None))
    } else if lower.ends_with(".ts") {
        TS_PARSER.with(|parser| parser.borrow_mut().parse(content, None))
    } else if [".js", ".jsx", ".mjs", ".cjs"]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        JS_PARSER.with(|parser| parser.borrow_mut().parse(content, None))
    } else {
        None
    };

    let mut chunks = if let Some(tree) = tree {
        let root = tree.root_node();
        let source = content.as_bytes();
        let global_imports = imports(root, source);
        let mut parsed = Vec::new();
        walk_ast(root, source, &mut parsed, &global_imports);
        parsed.extend(module_scope_chunks(root, source, &global_imports));
        if parsed.is_empty() {
            line_chunks(content)
        } else {
            parsed
        }
    } else {
        line_chunks(content)
    };
    assign_stable_ids(&mut chunks);
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_small_functions_and_uses_one_based_lines() {
        let chunks = parse_and_chunk(
            "small.ts",
            "const before = 1;\nfunction tiny() { return before; }",
        )
        .unwrap();
        assert!(chunks.iter().any(|chunk| chunk.name == "tiny"));
        assert_eq!(chunks[0].line_start, 2);
        assert_eq!(chunks[0].line_end, 2);
    }

    #[test]
    fn parses_tsx_with_tsx_grammar() {
        let chunks = parse_and_chunk(
            "component.tsx",
            "export function View() { return <section>Hello</section>; }",
        )
        .unwrap();
        assert!(chunks.iter().any(|chunk| chunk.name == "View"));
    }

    #[test]
    fn stable_id_survives_lines_inserted_before_symbol() {
        let original = parse_and_chunk("code.ts", "function same() { return 1; }").unwrap();
        let shifted = parse_and_chunk(
            "code.ts",
            "// an unrelated line\nfunction same() { return 1; }",
        )
        .unwrap();
        assert_eq!(original[0].stable_id, shifted[0].stable_id);
        assert_ne!(original[0].line_start, shifted[0].line_start);
    }

    #[test]
    fn chunks_fit_embedding_budget() {
        let content = (0..500)
            .map(|line| format!("let value_{line} = {line};"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = parse_and_chunk("large.rs", &content).unwrap();
        assert!(chunks
            .iter()
            .all(|chunk| chunk.content.chars().count() <= MAX_CHUNK_CHARS));
    }

    #[test]
    fn retains_top_level_module_code_alongside_functions() {
        let chunks = parse_and_chunk(
            "module.ts",
            "const API_URL = buildUrl();\nfunction load() { return API_URL; }\ninitialize();",
        )
        .unwrap();
        assert!(chunks
            .iter()
            .any(|chunk| chunk.content.contains("API_URL = buildUrl")));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.content.contains("initialize();")));
        assert!(chunks.iter().any(|chunk| chunk.name == "load"));
    }
}
