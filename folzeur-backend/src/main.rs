use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

#[derive(Deserialize)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct Response<'a> {
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default)]
struct RuntimeState {
    workspace: Option<PathBuf>,
    budget_limit: Option<f64>,
    spent: f64,
    requests: u64,
    methods: HashMap<String, u64>,
    started: Option<Instant>,
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut state = RuntimeState {
        started: Some(Instant::now()),
        ..RuntimeState::default()
    };

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(error) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    json!({ "ok": false, "error": error.to_string() })
                );
                continue;
            }
        };
        state.requests += 1;
        *state.methods.entry(request.method.clone()).or_default() += 1;
        let response = match dispatch(&mut state, &request) {
            Ok(result) => Response {
                id: &request.id,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Response {
                id: &request.id,
                ok: false,
                result: None,
                error: Some(error),
            },
        };
        let _ = serde_json::to_writer(&mut stdout, &response);
        let _ = writeln!(stdout);
        let _ = stdout.flush();
    }
}

fn dispatch(state: &mut RuntimeState, request: &Request) -> Result<String, String> {
    match request.method.as_str() {
		"initialize" => {
			state.workspace = request.params.get("workspacePath").and_then(Value::as_str).filter(|value| !value.is_empty()).map(PathBuf::from);
			Ok(json!({ "protocol": 1, "workspacePath": state.workspace }).to_string())
		}
		"health" => Ok(json!({ "status": "ok", "uptimeMs": state.started.map(|started| started.elapsed().as_millis()).unwrap_or(0) }).to_string()),
		"capabilities" => Ok(json!({
			"protocol": 1,
			"providers": false,
			"agents": false,
			"tools": ["grep_search", "apply_search_replace_blocks"],
			"permissions": false,
			"rag": false,
			"mcp": false,
			"telemetry": true,
			"budgets": true,
			"methods": ["initialize", "health", "capabilities", "grep_search", "apply_search_replace_blocks", "budget.set", "budget.consume", "budget.get", "telemetry.snapshot"]
		}).to_string()),
		"grep_search" => grep_search(state, &request.params),
		"apply_search_replace_blocks" => apply_search_replace_blocks(&request.params),
		"budget.set" => {
			let limit = request.params.get("limit").and_then(Value::as_f64).ok_or_else(|| "limit is required".to_string())?;
			if !limit.is_finite() || limit < 0.0 { return Err("limit must be a finite non-negative number".to_string()); }
			state.budget_limit = Some(limit);
			Ok(budget_snapshot(state))
		}
		"budget.consume" => {
			let amount = request.params.get("amount").and_then(Value::as_f64).ok_or_else(|| "amount is required".to_string())?;
			if !amount.is_finite() || amount < 0.0 { return Err("amount must be a finite non-negative number".to_string()); }
			if let Some(limit) = state.budget_limit && state.spent + amount > limit { return Err("BudgetExhausted".to_string()); }
			state.spent += amount;
			Ok(budget_snapshot(state))
		}
		"budget.get" => Ok(budget_snapshot(state)),
		"telemetry.snapshot" => Ok(json!({ "requests": state.requests, "methods": state.methods, "budget": serde_json::from_str::<Value>(&budget_snapshot(state)).unwrap_or(Value::Null) }).to_string()),
		method => Err(format!("Unknown Folzeur backend method: {method}")),
	}
}

fn apply_search_replace_blocks(params: &Value) -> Result<String, String> {
    let original = params
        .get("originalContent")
        .and_then(Value::as_str)
        .ok_or_else(|| "originalContent is required".to_string())?;
    let diff = params
        .get("diffContent")
        .and_then(Value::as_str)
        .ok_or_else(|| "diffContent is required".to_string())?;
    let file_path = params.get("filePath").and_then(Value::as_str);
    if original.len() > 10_000_000 || diff.len() > 4_000_000 {
        return Err("diff request exceeds size limits".to_string());
    }
    let line_ending = if original.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let normalized = diff.replace("\r\n", "\n");
    let mut cursor = 0usize;
    let mut blocks: Vec<(usize, usize, String)> = Vec::new();
    const START: &str = "<<<<<<< SEARCH\n";
    const MIDDLE: &str = "\n=======\n";
    const END: &str = "\n>>>>>>> REPLACE";
    while cursor < normalized.len() {
        if normalized[cursor..].trim().is_empty() {
            break;
        }
        let relative_start = normalized[cursor..]
            .find(START)
            .ok_or_else(|| "No valid SEARCH/REPLACE block found".to_string())?;
        let marker_start = cursor + relative_start;
        if !normalized[cursor..marker_start].trim().is_empty() {
            return Err("Malformed text outside SEARCH/REPLACE blocks".to_string());
        }
        let mut search_start = marker_start + START.len();
        loop {
            let rest = &normalized[search_start..];
            let Some(line_end) = rest.find('\n') else {
                break;
            };
            let line = &rest[..line_end];
            if line.starts_with(":start_line:")
                || line.starts_with(":end_line:")
                || line == "-------"
            {
                search_start += line_end + 1;
            } else {
                break;
            }
        }
        let relative_middle = normalized[search_start..]
            .find(MIDDLE)
            .ok_or_else(|| "SEARCH block is missing the replacement marker".to_string())?;
        let middle_start = search_start + relative_middle;
        let replacement_start = middle_start + MIDDLE.len();
        let relative_end = normalized[replacement_start..]
            .find(END)
            .ok_or_else(|| "Replacement block is not closed".to_string())?;
        let end_start = replacement_start + relative_end;
        let search = normalized[search_start..middle_start].replace('\n', line_ending);
        let replacement = normalized[replacement_start..end_start].replace('\n', line_ending);
        if search.is_empty() {
            return Err("Empty SEARCH content is not allowed".to_string());
        }
        let occurrences: Vec<usize> = original
            .match_indices(&search)
            .map(|(index, _)| index)
            .collect();
        if occurrences.len() != 1 {
            return Err(if occurrences.is_empty() {
                format!("Could not find exact SEARCH block:\n{search}")
            } else {
                format!("Ambiguous SEARCH block ({} matches)", occurrences.len())
            });
        }
        let start = occurrences[0];
        let end = start + search.len();
        if blocks
            .iter()
            .any(|(existing_start, existing_end, _)| start < *existing_end && end > *existing_start)
        {
            return Err("Overlapping SEARCH blocks detected".to_string());
        }
        blocks.push((start, end, replacement));
        cursor = end_start + END.len();
        if normalized[cursor..].starts_with('\n') {
            cursor += 1;
        }
    }
    if blocks.is_empty() {
        return Err("No valid SEARCH/REPLACE block found".to_string());
    }
    let mut content = original.to_string();
    blocks.sort_by_key(|block| std::cmp::Reverse(block.0));
    for (start, end, replacement) in blocks {
        content.replace_range(start..end, &replacement);
    }
    validate_syntax_regression(file_path, original, &content)?;
    Ok(json!({ "success": true, "content": content }).to_string())
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

fn budget_snapshot(state: &RuntimeState) -> String {
    json!({ "limit": state.budget_limit, "spent": state.spent, "remaining": state.budget_limit.map(|limit| (limit - state.spent).max(0.0)) }).to_string()
}

fn grep_search(state: &RuntimeState, params: &Value) -> Result<String, String> {
    let query = params
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| "query is required".to_string())?;
    if query.len() > 2_000 {
        return Err("query exceeds 2000 characters".to_string());
    }
    let workspace = state
        .workspace
        .clone()
        .ok_or_else(|| "workspacePath is required".to_string())?;
    let workspace = std::fs::canonicalize(workspace).map_err(|error| error.to_string())?;
    let output = Command::new("rg")
        .args([
            "--json",
            "--line-number",
            "--hidden",
            "--max-count",
            "100",
            "--max-filesize",
            "2M",
            "--glob",
            "!.git",
            "--glob",
            "!.folzeur",
            "--glob",
            "!node_modules",
            "--glob",
            "!.env*",
            "--glob",
            "!*.pem",
            "--glob",
            "!*.key",
            "--",
            query,
        ])
        .current_dir(workspace)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() || output.status.code() == Some(1) {
        let mut stdout = output.stdout;
        let truncated = stdout.len() > 2_000_000;
        stdout.truncate(2_000_000);
        let mut result = String::from_utf8(stdout).map_err(|error| error.to_string())?;
        if truncated {
            result.push_str(
                "\n{\"type\":\"truncated\",\"data\":{\"reason\":\"2MB output limit\"}}\n",
            );
        }
        return Ok(result);
    }
    Err(String::from_utf8_lossy(&output.stderr).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_unicode_diff_without_corruption() {
        let result = apply_search_replace_blocks(&json!({
			"originalContent": "const café = 1;",
			"diffContent": "<<<<<<< SEARCH\nconst café = 1;\n=======\nconst café = 2;\n>>>>>>> REPLACE"
		})).expect("diff should apply");
        let value: Value = serde_json::from_str(&result).expect("valid result JSON");
        assert_eq!(value["content"], "const café = 2;");
    }

    #[test]
    fn rejects_merged_token_search() {
        let result = apply_search_replace_blocks(&json!({
            "originalContent": "let a b = 1;",
            "diffContent": "<<<<<<< SEARCH\nlet ab = 1;\n=======\nlet c = 1;\n>>>>>>> REPLACE"
        }));
        assert!(result.is_err());
    }

    #[test]
    fn ast_validation_rejects_new_typescript_error() {
        let result = apply_search_replace_blocks(&json!({
            "filePath": "test.ts",
            "originalContent": "export const value = { ok: true };",
            "diffContent": "<<<<<<< SEARCH\n{ ok: true }\n=======\n{ ok: true\n>>>>>>> REPLACE"
        }));
        assert!(result.unwrap_err().contains("AST validation"));
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
            let result = apply_search_replace_blocks(&json!({
                "filePath": "generated.ts",
                "originalContent": before,
                "diffContent": diff
            }))
            .expect("generated diff should apply");
            let output: Value = serde_json::from_str(&result).expect("valid result JSON");
            let output = output["content"].as_str().expect("content string");
            assert!(output.contains(&format!("const prefix = {index};")));
            assert!(output.contains(&format!("const suffix = {};", index + 1)));
            assert_eq!(output.matches(&replacement).count(), 1);
        }
    }
}
