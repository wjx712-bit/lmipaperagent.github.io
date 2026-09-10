import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { makePreviewSnapshot, previewExportRows, previewInputs, previewSummary } from '../src/previewSnapshot.js';

const paper = (id, overrides = {}) => ({ id, doi: id, title: 'Adipocyte function in obesity', abstract: 'We measured adipocyte mitochondrial function in mice.', journal: 'Example', publishedAt: '2026-09-10', topics: ['Liver metabolism / MASLD'], ...overrides });

test('preview inputs whitelist public text and never include member ratings or notes', async () => {
  const papers = [paper('p1', { reviewNote: 'PRIVATE_REVIEW', ownReviewScore: 5, user_id: 'PRIVATE_ID', reviewerEmail: 'PRIVATE_EMAIL' })];
  assert.ok(!JSON.stringify(previewInputs(papers)).includes('PRIVATE_'));
  const snapshot = await makePreviewSnapshot(papers);
  assert.equal(snapshot.applied, false);
  assert.equal(snapshot.reviewDataIncluded, false);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
  assert.equal(snapshot.records[0].paperId, 'p1');
  assert.deepEqual(snapshot.records[0].oldTopics, papers[0].topics);
  assert.ok(!JSON.stringify(previewExportRows(snapshot)).includes('PRIVATE_'));
});

test('input hash is reproducible across input order and ignores review fields', async () => {
  const a = paper('p1'); const b = paper('p2');
  const first = await makePreviewSnapshot([a, b]);
  const second = await makePreviewSnapshot([{ ...b, reviewNote: 'different' }, a]);
  assert.equal(first.inputHash, second.inputHash);
  assert.match(first.inputHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.inputHash, (await makePreviewSnapshot([{ ...a, abstract: 'Different source' }, b])).inputHash);
  assert.notEqual(first.inputHash, (await makePreviewSnapshot([{ ...a, topics: [] }, b])).inputHash);
});

test('frozen original classification and scores cannot be modified by the preview', async () => {
  const original = Object.freeze([Object.freeze(paper('p1', { topics: Object.freeze(['Liver metabolism / MASLD']), aiScore: 99 }))]);
  const before = JSON.stringify(original);
  const snapshot = await makePreviewSnapshot(original);
  const exportRow = previewExportRows(snapshot)[0];
  assert.equal(JSON.stringify(original), before);
  assert.equal(exportRow.applied, false);
  assert.equal(exportRow.input_hash, snapshot.inputHash);
  assert.equal(exportRow.preview_version, snapshot.version);
  assert.equal(exportRow.generated_at, snapshot.generatedAt);
  assert.equal(exportRow.original_url, 'https://doi.org/p1');
  assert.equal(exportRow.preview_decision, '');
  assert.equal(exportRow.preview_note, '');
});

test('export uses a fixed DOI origin and never creates a URL for an absent DOI', async () => {
  const snapshot = await makePreviewSnapshot([paper('p1', { doi: '10.1000/odd?title#part' }), paper('p2', { doi: '' })]);
  const rows = previewExportRows(snapshot);
  assert.equal(rows[0].original_url, 'https://doi.org/10.1000/odd%3Ftitle%23part');
  assert.equal(rows[1].original_url, '');
});

test('preview refuses ambiguous identity instead of matching evidence to another paper', async () => {
  await assert.rejects(makePreviewSnapshot([paper('duplicate'), paper('duplicate')]), /ID/);
  await assert.rejects(makePreviewSnapshot([paper('')]), /ID/);
});

test('summary separates legacy membership from core and related proposals', () => {
  const rows = [
    { oldTopics: ['A'], coreTopics: ['B'], relatedTopics: ['A'], addedTopics: ['B'], removedTopics: ['A'], needsReview: true, changed: true },
    { oldTopics: ['A'], coreTopics: ['A'], relatedTopics: [], addedTopics: [], removedTopics: [], needsReview: false, changed: false },
  ];
  const summary = previewSummary(rows);
  assert.equal(summary.changed, 1);
  assert.equal(summary.needsReview, 1);
  assert.deepEqual(summary.topics.find(row => row.label === 'A'), { label: 'A', kind: 'legacy', old: 2, core: 1, related: 1, added: 0, removedFromCore: 1 });
});

test('all current public papers produce a complete isolated snapshot without network or source writes', async () => {
  const path = new URL('../public/data/papers.json', import.meta.url);
  const before = readFileSync(path, 'utf8');
  const papers = JSON.parse(before).papers;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Preview must not contact external services'); };
  try {
    const snapshot = await makePreviewSnapshot(papers);
    assert.equal(snapshot.records.length, papers.length);
    assert.equal(snapshot.summary.total, papers.length);
    assert.equal(readFileSync(path, 'utf8'), before);
    for (const row of snapshot.records) {
      const source = papers.find(paper => paper.id === row.paperId);
      assert.deepEqual(row.oldTopics, source.topics);
      for (const evidence of row.evidence) assert.equal(source[evidence.field].slice(evidence.start, evidence.end), evidence.quote);
    }
  } finally { globalThis.fetch = originalFetch; }
});
