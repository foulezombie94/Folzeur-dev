#![deny(clippy::all)]
use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;
use napi_derive::napi;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

static WORKSPACE_FILES: Lazy<RwLock<HashMap<String, Arc<Vec<String>>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

static MATCHER: Lazy<SkimMatcherV2> = Lazy::new(SkimMatcherV2::default);

#[napi(object)]
pub struct DiffResult {
    pub success: bool,
    pub content: Option<String>,
    pub error: Option<String>,
}

#[napi(object)]
pub struct FuzzyMatchResult {
    pub file: String,
    pub score: i64,
}

#[derive(Debug, Clone)]
struct DiffBlock {
    start_line: Option<usize>,
    end_line: Option<usize>,
    search_content: String,
    replace_content: String,
}

#[derive(Debug, Clone)]
enum ParserState {
    Text,
    SearchMeta,
    SearchContent,
    ReplaceContent,
}

struct ValidatedBlock {
    start_offset: usize,
    end_offset: usize,
    replace_content: String,
}

fn find_whitespace_agnostic(original: &str, search: &str) -> Vec<(usize, usize)> {
    fn collapse(input: &str) -> Vec<(char, usize, usize)> {
        let mut result = Vec::with_capacity(input.chars().count());
        let mut chars = input.char_indices().peekable();
        while let Some((start, character)) = chars.next() {
            if character.is_whitespace() {
                let mut end = start + character.len_utf8();
                while let Some(&(next_start, next_character)) = chars.peek() {
                    if !next_character.is_whitespace() {
                        break;
                    }
                    chars.next();
                    end = next_start + next_character.len_utf8();
                }
                result.push((' ', start, end));
            } else {
                result.push((character, start, start + character.len_utf8()));
            }
        }
        result
    }

    let normalized_search = collapse(search);
    if normalized_search.is_empty() {
        return Vec::new();
    }
    let normalized_original = collapse(original);
    if normalized_search.len() > normalized_original.len() {
        return Vec::new();
    }
    let search_chars: Vec<char> = normalized_search.iter().map(|entry| entry.0).collect();
    normalized_original
        .windows(search_chars.len())
        .filter_map(|window| {
            if window
                .iter()
                .map(|entry| entry.0)
                .eq(search_chars.iter().copied())
            {
                Some((window[0].1, window[window.len() - 1].2))
            } else {
                None
            }
        })
        .collect()
}

/// Applies SEARCH/REPLACE blocks safely with line awareness, 2-pass atomicity, and ambiguity rejection.
#[napi]
pub fn apply_search_replace_blocks(
    original_content: String,
    diff_content: String,
    file_path: Option<String>,
) -> DiffResult {
    if original_content.len() > 10_000_000 || diff_content.len() > 4_000_000 {
        return DiffResult {
            success: false,
            content: None,
            error: Some("Diff request exceeds size limits.".to_string()),
        };
    }
    let line_ending = if original_content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };

    let mut blocks: Vec<DiffBlock> = Vec::new();
    let mut state = ParserState::Text;
    let mut current_block = DiffBlock {
        start_line: None,
        end_line: None,
        search_content: String::new(),
        replace_content: String::new(),
    };

    // Pass 1: Parse with a strict state machine
    for line in diff_content.split('\n') {
        let trimmed = line.trim_end_matches('\r');
        match state {
            ParserState::Text => {
                if trimmed == "<<<<<<< SEARCH" {
                    current_block = DiffBlock {
                        start_line: None,
                        end_line: None,
                        search_content: String::new(),
                        replace_content: String::new(),
                    };
                    state = ParserState::SearchMeta;
                } else if trimmed.starts_with("<<<<<<< SEARCH") {
                    return DiffResult {
                        success: false,
                        content: None,
                        error: Some(format!("Malformed marker: {}", trimmed)),
                    };
                } else if !trimmed.trim().is_empty() {
                    return DiffResult {
                        success: false,
                        content: None,
                        error: Some("Malformed text outside SEARCH/REPLACE blocks.".to_string()),
                    };
                }
            }
            ParserState::SearchMeta => {
                if let Some(num_str) = trimmed.strip_prefix(":start_line:") {
                    current_block.start_line = num_str.trim().parse().ok();
                } else if let Some(num_str) = trimmed.strip_prefix(":end_line:") {
                    current_block.end_line = num_str.trim().parse().ok();
                } else if trimmed == "-------" {
                    state = ParserState::SearchContent;
                } else if trimmed == "=======" {
                    state = ParserState::ReplaceContent;
                } else {
                    // Escaping markers
                    if trimmed.starts_with("\\<<<<<<< SEARCH")
                        || trimmed.starts_with("\\=======")
                        || trimmed.starts_with("\\>>>>>>> REPLACE")
                    {
                        current_block.search_content.push_str(&line[1..]);
                    } else {
                        current_block.search_content.push_str(line);
                    }
                    current_block.search_content.push('\n');
                    state = ParserState::SearchContent;
                }
            }
            ParserState::SearchContent => {
                if trimmed == "=======" {
                    state = ParserState::ReplaceContent;
                } else {
                    if trimmed.starts_with("\\<<<<<<< SEARCH")
                        || trimmed.starts_with("\\=======")
                        || trimmed.starts_with("\\>>>>>>> REPLACE")
                    {
                        current_block.search_content.push_str(&line[1..]);
                    } else {
                        current_block.search_content.push_str(line);
                    }
                    current_block.search_content.push('\n');
                }
            }
            ParserState::ReplaceContent => {
                if trimmed == ">>>>>>> REPLACE" {
                    if current_block.search_content.ends_with('\n') {
                        current_block.search_content.pop();
                    }
                    if current_block.search_content.ends_with('\r') {
                        current_block.search_content.pop();
                    }
                    if current_block.replace_content.ends_with('\n') {
                        current_block.replace_content.pop();
                    }
                    if current_block.replace_content.ends_with('\r') {
                        current_block.replace_content.pop();
                    }
                    blocks.push(current_block.clone());
                    state = ParserState::Text;
                } else {
                    if trimmed.starts_with("\\<<<<<<< SEARCH")
                        || trimmed.starts_with("\\=======")
                        || trimmed.starts_with("\\>>>>>>> REPLACE")
                    {
                        current_block.replace_content.push_str(&line[1..]);
                    } else {
                        current_block.replace_content.push_str(line);
                    }
                    current_block.replace_content.push('\n');
                }
            }
        }
    }

    if !matches!(state, ParserState::Text) {
        return DiffResult {
            success: false,
            content: None,
            error: Some("Orphaned or unclosed SEARCH block detected.".to_string()),
        };
    }

    if blocks.is_empty() {
        return DiffResult {
            success: false,
            content: None,
            error: Some(
                "No valid <<<<<<< SEARCH ======= >>>>>>> REPLACE blocks found.".to_string(),
            ),
        };
    }

    // Pass 2: Validate all blocks (Atomicity)
    let mut validated_blocks: Vec<ValidatedBlock> = Vec::new();

    for block in blocks {
        let search_normalized = block
            .search_content
            .replace("\r\n", "\n")
            .replace("\n", line_ending);
        let replace_normalized = block
            .replace_content
            .replace("\r\n", "\n")
            .replace("\n", line_ending);

        let mut occurrences: Vec<(usize, usize)> = original_content
            .match_indices(&search_normalized)
            .map(|(i, _)| (i, i + search_normalized.len()))
            .collect();
        if occurrences.is_empty() {
            occurrences = find_whitespace_agnostic(&original_content, &search_normalized);
        }

        if occurrences.is_empty() {
            return DiffResult {
                success: false,
                content: None,
                error: Some(format!(
                    "Could not find match for block:\n{}",
                    search_normalized
                )),
            };
        }

        let target = if occurrences.len() == 1 {
            occurrences[0]
        } else {
            if let Some(start_line) = block.start_line {
                let mut exact_matches = Vec::new();
                for &occ in &occurrences {
                    let offset = occ.0;
                    let line_number = original_content[..offset].matches(line_ending).count() + 1;
                    // Strict tolerance: must be within 2 lines of the stated start_line
                    if line_number.abs_diff(start_line) <= 2 {
                        exact_matches.push(occ);
                    }
                }
                if exact_matches.is_empty() {
                    return DiffResult {
                        success: false,
                        content: None,
                        error: Some(format!(
                            "Found ambiguous matches for block, but none near line {}",
                            start_line
                        )),
                    };
                } else if exact_matches.len() > 1 {
                    return DiffResult {
                        success: false,
                        content: None,
                        error: Some(format!(
                            "Found ambiguous matches for block even near line {}",
                            start_line
                        )),
                    };
                }
                exact_matches[0]
            } else {
                return DiffResult { success: false, content: None, error: Some(format!("Ambiguous block (found {} matches), and no line number provided to disambiguate.", occurrences.len())) };
            }
        };

        // Check for overlap
        for validated in &validated_blocks {
            if target.0 < validated.end_offset && target.1 > validated.start_offset {
                return DiffResult {
                    success: false,
                    content: None,
                    error: Some("Overlapping search blocks detected.".to_string()),
                };
            }
        }

        validated_blocks.push(ValidatedBlock {
            start_offset: target.0,
            end_offset: target.1,
            replace_content: replace_normalized,
        });
    }

    // Sort reverse to avoid shifting offsets
    validated_blocks.sort_by_key(|block| std::cmp::Reverse(block.start_offset));

    // Check overlaps
    for i in 0..validated_blocks.len().saturating_sub(1) {
        if validated_blocks[i].start_offset < validated_blocks[i + 1].end_offset {
            return DiffResult {
                success: false,
                content: None,
                error: Some("Overlapping SEARCH blocks detected.".to_string()),
            };
        }
    }

    fn strip_common_indentation(content: &str) -> String {
        let lines: Vec<&str> = content.split('\n').collect();

        // Find the minimum common indentation for non-empty lines
        let mut min_indent: Option<usize> = None;
        for line in &lines {
            let trimmed = line.trim_start();
            if trimmed.is_empty() {
                continue;
            }
            let indent_len = line.len() - trimmed.len();
            let leading_whitespace = &line[..indent_len];
            if leading_whitespace.chars().all(|c| c == ' ' || c == '\t') {
                min_indent = Some(match min_indent {
                    Some(min) => std::cmp::min(min, indent_len),
                    None => indent_len,
                });
            }
        }

        if let Some(indent) = min_indent {
            if indent > 0 {
                let mut result = String::with_capacity(content.len());
                for (idx, line) in lines.iter().enumerate() {
                    if idx > 0 {
                        result.push('\n');
                    }
                    if line.trim_start().is_empty() {
                        // Keep empty lines empty
                    } else if line.len() >= indent {
                        result.push_str(&line[indent..]);
                    } else {
                        result.push_str(line);
                    }
                }
                return result;
            }
        }
        content.to_string()
    }

    // Pass 3: Apply (God Tier Optimization: In-place mutation)
    let original_for_syntax = file_path.as_ref().map(|_| original_content.clone());
    let mut current_content = original_content;
    for block in validated_blocks {
        let mut line_start = block.start_offset;
        let mut original_indent = String::new();
        let bytes = current_content.as_bytes();
        while line_start > 0 {
            let c = bytes[line_start - 1];
            if c == b' ' || c == b'\t' {
                original_indent.push(c as char);
                line_start -= 1;
            } else if c == b'\n' || c == b'\r' {
                break;
            } else {
                original_indent.clear();
                break;
            }
        }
        let original_indent: String = original_indent.chars().rev().collect();

        let mut final_replace = strip_common_indentation(&block.replace_content);
        if !original_indent.is_empty() {
            final_replace = final_replace.replace('\n', &format!("\n{}", original_indent));
            if final_replace.ends_with(&format!("\n{}", original_indent)) {
                final_replace.truncate(final_replace.len() - original_indent.len());
            }
        }

        current_content.replace_range(block.start_offset..block.end_offset, &final_replace);
    }

    if let Err(error) = validate_syntax_regression(
        file_path.as_deref(),
        original_for_syntax.as_deref().unwrap_or_default(),
        &current_content,
    ) {
        return DiffResult {
            success: false,
            content: None,
            error: Some(error),
        };
    }

    DiffResult {
        success: true,
        content: Some(current_content),
        error: None,
    }
}

fn validate_syntax_regression(
    file_path: Option<&str>,
    original: &str,
    updated: &str,
) -> Result<(), String> {
    let Some(extension) = file_path
        .and_then(|path| std::path::Path::new(path).extension())
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
    else {
        return Ok(());
    };
    let language = match extension.as_str() {
        "ts" | "mts" | "cts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "js" | "mjs" | "cjs" | "jsx" => tree_sitter_javascript::LANGUAGE.into(),
        _ => return Ok(()),
    };
    let original_errors = syntax_error_count(&language, original)?;
    let updated_errors = syntax_error_count(&language, updated)?;
    if updated_errors > original_errors {
        return Err(format!(
            "AST validation rejected the patch: syntax errors increased from {original_errors} to {updated_errors}"
        ));
    }
    Ok(())
}

fn syntax_error_count(language: &tree_sitter::Language, source: &str) -> Result<usize, String> {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(language)
        .map_err(|error| format!("AST parser setup failed: {error}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "AST parser returned no tree".to_string())?;
    fn count(node: tree_sitter::Node<'_>) -> usize {
        let own = usize::from(node.is_error() || node.is_missing());
        let mut cursor = node.walk();
        own + node.children(&mut cursor).map(count).sum::<usize>()
    }
    Ok(count(tree.root_node()))
}

fn normalize_cwd(cwd: &str) -> String {
    // Basic normalization for Windows drive letters and separators
    cwd.to_lowercase().replace("\\", "/")
}

#[napi(js_name = "setWorkspaceFiles")]
pub fn set_workspace_files(cwd: String, files: Vec<String>) {
    let normalized = normalize_cwd(&cwd);
    if let Ok(mut map) = WORKSPACE_FILES.write() {
        map.insert(normalized, Arc::new(files));
    }
}

#[napi(js_name = "deleteWorkspaceFiles")]
pub fn delete_workspace_files(cwd: String) {
    let normalized = normalize_cwd(&cwd);
    if let Ok(mut map) = WORKSPACE_FILES.write() {
        map.remove(&normalized);
    }
}

#[napi(js_name = "updateWorkspaceCache")]
pub fn update_workspace_cache(cwd: String, added: Vec<String>, removed: Vec<String>) {
    let normalized = normalize_cwd(&cwd);
    if let Ok(mut map) = WORKSPACE_FILES.write() {
        if let Some(files) = map.get_mut(&normalized) {
            let mut current = files.as_ref().clone();
            current.retain(|f| !removed.contains(f));
            for a in added {
                if !current.contains(&a) {
                    current.push(a);
                }
            }
            *files = Arc::new(current);
        }
    }
}

#[napi(js_name = "fuzzySearch")]
pub fn fuzzy_search(query: String, cwd: String) -> Vec<FuzzyMatchResult> {
    let normalized = normalize_cwd(&cwd);

    let files = {
        let map = match WORKSPACE_FILES.read() {
            Ok(m) => m,
            Err(_) => return Vec::new(),
        };
        match map.get(&normalized) {
            Some(t) => Arc::clone(t), // Quick clone of Arc under read-lock
            None => return Vec::new(),
        }
    };

    let mut results: Vec<FuzzyMatchResult> = files
        .iter()
        .filter_map(|target| {
            // Score against full path instead of just basename to properly match folders
            MATCHER
                .fuzzy_match(target, &query)
                .map(|score| FuzzyMatchResult {
                    file: target.clone(),
                    score,
                })
        })
        .collect();

    results.sort_by_key(|result| std::cmp::Reverse(result.score));

    results.into_iter().take(50).collect()
}

#[napi(js_name = "hybridSearch")]
pub fn hybrid_search(_query: String, _cwd: String) -> Vec<String> {
    // Hybrid search is not yet implemented natively.
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_match_is_unicode_safe() {
        let matches = find_whitespace_agnostic("const café = 1;", "const\tcafé = 1;");
        assert_eq!(matches, vec![(0, "const café = 1;".len())]);
    }

    #[test]
    fn whitespace_match_does_not_merge_tokens() {
        assert!(find_whitespace_agnostic("let a b = 1;", "let ab = 1;").is_empty());
        assert!(find_whitespace_agnostic("let ab = 1;", "let a b = 1;").is_empty());
    }

    #[test]
    fn diff_rejects_token_boundary_changes() {
        let result = apply_search_replace_blocks(
            "let a b = 1;".to_string(),
            "<<<<<<< SEARCH\nlet ab = 1;\n=======\nlet c = 1;\n>>>>>>> REPLACE".to_string(),
            Some("test.ts".to_string()),
        );
        assert!(!result.success);
    }

    #[test]
    fn rejects_text_outside_blocks() {
        let result = apply_search_replace_blocks(
			"const value = 1;".to_string(),
			"ignore this\n<<<<<<< SEARCH\nconst value = 1;\n=======\nconst value = 2;\n>>>>>>> REPLACE".to_string(),
			Some("test.ts".to_string()),
		);
        assert!(!result.success);
    }

    #[test]
    fn ast_validation_rejects_new_syntax_errors() {
        let result = apply_search_replace_blocks(
            "export const value = { ok: true };".to_string(),
            "<<<<<<< SEARCH\n{ ok: true }\n=======\n{ ok: true\n>>>>>>> REPLACE".to_string(),
            Some("test.ts".to_string()),
        );
        assert!(!result.success);
        assert!(result.error.unwrap_or_default().contains("AST validation"));
    }

    #[test]
    fn generated_exact_replacements_preserve_unrelated_content() {
        for index in 0..512 {
            let before = format!(
                "const prefix = {index};\nconst target_{index} = {index};\nconst suffix = {};",
                index + 1
            );
            let search = format!("const target_{index} = {index};");
            let replacement = format!("const target_{index} = {};", index + 10);
            let diff = format!("<<<<<<< SEARCH\n{search}\n=======\n{replacement}\n>>>>>>> REPLACE");
            let result =
                apply_search_replace_blocks(before.clone(), diff, Some("generated.ts".to_string()));
            assert!(result.success, "generated case {index}: {:?}", result.error);
            let output = result.content.expect("successful diff has content");
            assert!(output.contains(&format!("const prefix = {index};")));
            assert!(output.contains(&format!("const suffix = {};", index + 1)));
            assert_eq!(output.matches(&replacement).count(), 1);
        }
    }
}
