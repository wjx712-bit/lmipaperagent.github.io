import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makePreviewSnapshot, previewExportRows } from '../src/previewSnapshot.js';
import { toCsv } from '../src/adminAnalytics.js';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output-dir')) throw new Error('Usage: node scripts/export_classification_preview.mjs [--output-dir DIRECTORY]');
const output = path.resolve(args[1] || '.cache/classification-preview');
// Never place an experimental artifact in the live catalog, configuration, or public website payload.
for (const directory of ['public', 'dist', 'data', 'config', 'src', '.github', '.git', 'supabase']) {
  const target = path.resolve(directory).toLowerCase();
  const candidate = output.toLowerCase();
  if (candidate === target || candidate.startsWith(`${target}${path.sep}`)) throw new Error('Preview output must remain outside production directories');
}
const source = await readFile('public/data/papers.json', 'utf8');
const dataset = JSON.parse(source);
const snapshot = await makePreviewSnapshot(dataset.papers);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'preview.json'), JSON.stringify(snapshot, null, 2), { encoding: 'utf8', flag: 'wx' });
await writeFile(path.join(output, 'preview.csv'), toCsv(previewExportRows(snapshot)), { encoding: 'utf8', flag: 'wx' });
if (source !== await readFile('public/data/papers.json', 'utf8')) throw new Error('The source catalog changed during export; inspect the snapshot before use');
console.log(JSON.stringify({ output, version: snapshot.version, inputHash: snapshot.inputHash, applied: snapshot.applied, summary: snapshot.summary }, null, 2));
