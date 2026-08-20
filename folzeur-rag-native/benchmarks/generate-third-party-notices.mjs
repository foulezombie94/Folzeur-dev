import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const { stdout } = await promisify(execFile)('cargo', ['metadata', '--format-version', '1', '--locked'], { maxBuffer: 64 * 1024 * 1024 });
const metadata = JSON.parse(stdout);
const root = metadata.resolve.root;
const dependencies = metadata.packages
  .filter(pkg => pkg.id !== root)
  .map(pkg => ({ name: pkg.name, version: pkg.version, license: pkg.license || 'UNKNOWN', repository: pkg.repository || pkg.homepage || '' }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const lines = [
  '# Folzeur RAG Native — Third-Party Notices',
  '',
  'Generated from the locked Cargo dependency graph. License expressions are the declarations supplied by each package.',
  '',
  '| Package | Version | License | Source |',
  '| --- | --- | --- | --- |',
  ...dependencies.map(pkg => `| ${escapeCell(pkg.name)} | ${escapeCell(pkg.version)} | ${escapeCell(pkg.license)} | ${escapeCell(pkg.repository)} |`),
  '',
  ...dependencies.filter(pkg => pkg.license === 'UNKNOWN').map(pkg => `> ${pkg.name}@${pkg.version} does not expose an SPDX expression through Cargo metadata; its packaged license files remain authoritative and cargo-deny validates the resolved license policy.`),
  '',
];
await writeFile('THIRD_PARTY_NOTICES.md', lines.join('\n'));
console.log(`Wrote THIRD_PARTY_NOTICES.md for ${dependencies.length} locked dependencies.`);

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}
