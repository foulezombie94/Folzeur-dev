use std::collections::{HashMap, HashSet};

/// Deterministic code-aware reranking layered on top of RRF.  It intentionally
/// does not replace semantic/lexical retrieval: it only supplies small,
/// explainable boosts for identifier, definition and path matches.
pub fn code_score(query: &str, value: &serde_json::Value) -> f64 {
    let query_lower = query.to_lowercase();
    let identifiers: HashSet<_> = query_lower
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|token| token.len() > 1)
        .collect();
    if identifiers.is_empty() {
        return 0.0;
    }
    let content = value["content"].as_str().unwrap_or_default().to_lowercase();
    let path = value["file_path"]
        .as_str()
        .unwrap_or_default()
        .to_lowercase();
    let first_lines = content.lines().take(8).collect::<Vec<_>>().join(" ");
    let matched = identifiers
        .iter()
        .filter(|identifier| content.contains(**identifier))
        .count() as f64
        / identifiers.len() as f64;
    let path_match = identifiers
        .iter()
        .any(|identifier| path.contains(*identifier));
    let definition_match = identifiers.iter().any(|identifier| {
        [
            "fn ",
            "function ",
            "class ",
            "struct ",
            "trait ",
            "interface ",
            "def ",
        ]
        .iter()
        .any(|prefix| first_lines.contains(&format!("{prefix}{identifier}")))
    });
    let generated_or_vendor = path.contains("/node_modules/")
        || path.contains("\\node_modules\\")
        || path.contains("/target/")
        || path.contains("\\target\\")
        || path.ends_with(".min.js");

    // Keep explainable boosts on the same scale as one RRF contribution
    // (roughly 1 / 61). They refine retrieval and must never replace it.
    matched * 0.008
        + if path_match { 0.002 } else { 0.0 }
        + if definition_match { 0.004 } else { 0.0 }
        - if generated_or_vendor { 0.006 } else { 0.0 }
}

/// Expands code identifiers deterministically for lexical retrieval. Semantic
/// retrieval still embeds the original query to avoid changing its intent.
pub fn expand_lexical_query(query: &str) -> String {
    let mut terms = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    let mut push = |value: &str| {
        let normalized = value.trim().to_lowercase();
        if normalized.len() > 1 && seen.insert(normalized.clone()) {
            terms.push(normalized);
        }
    };
    for raw in query.split(|character: char| !character.is_alphanumeric() && character != '_') {
        push(raw);
        for snake in raw.split('_') {
            let mut current = String::new();
            for (index, character) in snake.chars().enumerate() {
                if index > 0 && character.is_uppercase() && !current.is_empty() {
                    push(&current);
                    current.clear();
                }
                current.push(character);
            }
            push(&current);
        }
    }
    terms.join(" ")
}

pub fn recall_at_k(ranked: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if relevant.is_empty() {
        return 1.0;
    }
    ranked
        .iter()
        .take(k)
        .filter(|id| relevant.contains(*id))
        .count() as f64
        / relevant.len() as f64
}

pub fn reciprocal_rank(ranked: &[String], relevant: &HashSet<String>) -> f64 {
    ranked
        .iter()
        .position(|id| relevant.contains(id))
        .map(|rank| 1.0 / (rank as f64 + 1.0))
        .unwrap_or(0.0)
}

pub fn ndcg_at_k(ranked: &[String], relevance: &HashMap<String, u32>, k: usize) -> f64 {
    let dcg = ranked
        .iter()
        .take(k)
        .enumerate()
        .fold(0.0, |score, (rank, id)| {
            let gain = *relevance.get(id).unwrap_or(&0) as f64;
            score + (2_f64.powf(gain) - 1.0) / (rank as f64 + 2.0).log2()
        });
    let mut ideal: Vec<_> = relevance.values().copied().collect();
    ideal.sort_unstable_by(|a, b| b.cmp(a));
    let idcg = ideal
        .iter()
        .take(k)
        .enumerate()
        .fold(0.0, |score, (rank, gain)| {
            score + (2_f64.powf(*gain as f64) - 1.0) / (rank as f64 + 2.0).log2()
        });
    if idcg == 0.0 {
        1.0
    } else {
        dcg / idcg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_are_boosted_over_incidental_mentions() {
        let definition = serde_json::json!({"file_path":"src/user.ts","content":"export function getUser(id: string) {"});
        let mention = serde_json::json!({"file_path":"README.md","content":"Call getUser in the application."});
        assert!(code_score("getUser", &definition) > code_score("getUser", &mention));
    }

    #[test]
    fn ranking_metrics_have_known_values() {
        let ranked = vec!["noise".into(), "target".into(), "other".into()];
        let relevant = HashSet::from(["target".into()]);
        assert_eq!(recall_at_k(&ranked, &relevant, 1), 0.0);
        assert_eq!(recall_at_k(&ranked, &relevant, 2), 1.0);
        assert_eq!(reciprocal_rank(&ranked, &relevant), 0.5);
        let relevance = HashMap::from([("target".into(), 3), ("other".into(), 1)]);
        let ndcg = ndcg_at_k(&ranked, &relevance, 3);
        assert!(ndcg > 0.6 && ndcg < 1.0);
    }

    #[test]
    fn lexical_expansion_splits_code_identifiers_without_duplicates() {
        assert_eq!(
            expand_lexical_query("getUser auth_token getUser"),
            "getuser get user auth_token auth token"
        );
    }

    #[test]
    fn heuristic_boost_remains_below_one_rrf_contribution() {
        let best = serde_json::json!({"file_path":"src/get_user.ts","content":"export function get_user() {}"});
        assert!(code_score("get_user", &best) < 1.0 / 60.0);
    }
}
