import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const rag = require('../index.js');
const sizes = (process.argv.slice(2).length ? process.argv.slice(2) : ['1000', '10000', '100000']).map(Number);
const maxPeakRssBytes = Number(process.env.FOLZEUR_MAX_PEAK_RSS_BYTES || 4 * 1024 * 1024 * 1024);
const maxSearchP95Ms = Number(process.env.FOLZEUR_MAX_SEARCH_P95_MS || 2_000);
const reports = [];
await rag.installModel(true);
for (const size of sizes) {
  if (!Number.isInteger(size) || size < 1 || size > 100000) throw new Error(`Invalid corpus size: ${size}`);
  const workspace = await mkdtemp(join(tmpdir(), `folzeur-rag-${size}-`));
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25);
  try {
    for (let start = 0; start < size; start += 1000) {
      await Promise.all(Array.from({ length: Math.min(1000, size - start) }, async (_, offset) => {
        const id = start + offset;
        const directory = join(workspace, `pkg-${Math.floor(id / 1000)}`);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `module-${id}.ts`), `export function lookupUser${id}(id: string) { return { id, generation: ${id} }; }\n`);
      }));
    }
    const indexStarted = performance.now();
    const indexedChunks = await rag.indexProject(workspace, []);
    const indexMs = performance.now() - indexStarted;
    const latencies = [];
    for (let index = 0; index < 30; index++) {
      const started = performance.now();
      await rag.hybridSearch(workspace, `lookup user ${index % size}`, { topK: 10 });
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    const report = { files: size, indexedChunks, indexMs, searchP50Ms: percentile(latencies, 0.50), searchP95Ms: percentile(latencies, 0.95), peakRssBytes: peakRss };
    assert.ok(report.searchP95Ms <= maxSearchP95Ms, `${size} files: p95 ${report.searchP95Ms.toFixed(1)}ms exceeds ${maxSearchP95Ms}ms`);
    assert.ok(report.peakRssBytes <= maxPeakRssBytes, `${size} files: peak RSS ${report.peakRssBytes} exceeds ${maxPeakRssBytes}`);
    reports.push(report);
  } finally {
    clearInterval(sampler);
    await rm(workspace, { recursive: true, force: true });
  }
}
const output = JSON.stringify({ generatedAt: new Date().toISOString(), budgets: { maxPeakRssBytes, maxSearchP95Ms }, reports }, null, 2);
if (process.env.FOLZEUR_BENCH_REPORT) await writeFile(process.env.FOLZEUR_BENCH_REPORT, output);
console.log(output);

function percentile(values, fraction) { return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]; }
