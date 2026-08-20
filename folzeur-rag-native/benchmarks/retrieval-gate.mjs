import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rag = require('../index.js');
const fixtures = JSON.parse(await readFile(new URL('./retrieval-ground-truth.json', import.meta.url), 'utf8'));
const workspace = await mkdtemp(join(tmpdir(), 'folzeur-retrieval-gate-'));
const extensions = { typescript: 'ts', javascript: 'js', rust: 'rs', python: 'py', go: 'go' };

try {
  for (const fixture of fixtures) {
    const target = join(workspace, ...fixture.expected.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, fixture.source);
    const distractorDirectory = join(workspace, fixture.language, 'distractors');
    await mkdir(distractorDirectory, { recursive: true });
    for (let index = 0; index < 50; index++) {
      const extension = extensions[fixture.language];
      await writeFile(join(distractorDirectory, `module-${index}.${extension}`), distractorSource(fixture.language, index));
    }
  }

  await rag.installModel(true);
  const indexedChunks = await rag.indexProject(workspace, []);
  assert.ok(indexedChunks >= 255, `expected at least 255 indexed chunks, got ${indexedChunks}`);

  const metrics = [];
  for (const fixture of fixtures) {
    const results = JSON.parse(await rag.hybridSearch(workspace, fixture.query, { topK: 10, similarityThreshold: 0 }));
    const ranked = [...new Set(results.map(result => relativePath(workspace, result.file_path)))];
    const expected = fixture.expected.replaceAll('\\', '/');
    const rank = ranked.indexOf(expected);
    assert.ok(rank >= 0 && rank < 3, `${fixture.language}: ${expected} was ranked ${rank < 0 ? 'outside top 10' : rank + 1}`);
    const result = JSON.parse(rag.evaluateRanking(JSON.stringify(ranked), JSON.stringify({ [expected]: 3 }), 10));
    assert.ok(result.recall_at_k >= 1, `${fixture.language}: recall@10 regressed`);
    assert.ok(result.mrr >= 1 / 3, `${fixture.language}: MRR regressed`);
    metrics.push({ language: fixture.language, query: fixture.query, rank: rank + 1, ...result });
  }
  console.log(JSON.stringify({ corpusFiles: 255, indexedChunks, metrics }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function relativePath(root, file) {
  const normalizedRoot = normalize(root).replaceAll('\\', '/').replace(/\/$/, '');
  return normalize(file).replaceAll('\\', '/').slice(normalizedRoot.length + 1);
}

function distractorSource(language, index) {
  switch (language) {
    case 'typescript': return `export function mapAccount${index}(value: string) { return value.length + ${index}; }\n`;
    case 'javascript': return `export function renderWidget${index}(value) { return String(value) + '${index}'; }\n`;
    case 'rust': return `pub fn calculate_invoice_${index}(value: usize) -> usize { value + ${index} }\n`;
    case 'python': return `def format_report_${index}(value):\n    return str(value) + '${index}'\n`;
    case 'go': return `package distractors\nfunc CalculateInvoice${index}(value int) int { return value + ${index} }\n`;
    default: throw new Error(`unsupported language ${language}`);
  }
}
