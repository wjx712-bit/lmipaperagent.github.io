import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditClassification } from '../src/classificationAudit.js';
import { UNCLASSIFIED_TOPIC } from '../src/paperTopics.js';

const LIVER = 'Liver metabolism / MASLD';
const ADIPOSE = 'Adipose tissue / adipocyte biology';
const OMICS = 'Single-cell / spatial / atlas';
const AGING = 'Aging / senescence';
const IMMUNE = 'Inflammation / immune regulation';
const issue = (result, id) => result.issues.find((item) => item.id === id).papers;
const paper = (values = {}) => ({
  id: 'paper-1', doi: '10.1234/example', title: 'Study of biology',
  abstract: 'The study reports experimental results.', abstractKo: 'Translated abstract',
  url: 'https://doi.org/10.1234/example', abstractSourceUrl: 'https://example.org/abstract',
  topics: [], aiScore: 50, ...values,
});

test('empty input preserves a stable issue schema and zero totals', () => {
  const result = auditClassification([]);
  assert.equal(result.total, 0);
  assert.equal(result.multiTopicCount, 0);
  assert.equal(result.topicAssignments, 0);
  assert.equal(result.scoreSaturationCount, 0);
  assert.equal(new Set(result.issues.map(({ id }) => id)).size, result.issues.length);
  assert.ok(result.issues.every(({ label, description, papers }) => label && description && papers.length === 0));
  assert.deepEqual(auditClassification(), result);
});

test('explicit unclassified is a review bucket, not a scientific topic assignment', () => {
  const a = paper({ id: 'a', topics: [UNCLASSIFIED_TOPIC] });
  const b = paper({ id: 'b', topics: [' Unclassified '] });
  const c = paper({ id: 'c', topics: [UNCLASSIFIED_TOPIC, LIVER] });
  const result = auditClassification([a, b, c]);
  assert.deepEqual(issue(result, 'unclassified'), [a, b]);
  assert.equal(result.topicAssignments, 1);
  assert.equal(result.multiTopicCount, 0);
});

test('missing metadata is separate from content correctness and topic classification', () => {
  const p = paper({ title: ' ', doi: null, url: undefined, abstract: '', abstractKo: ' \n', abstractSourceUrl: 0, topics: [' '] });
  const result = auditClassification([p]);
  for (const id of ['unclassified', 'missing-title', 'missing-doi', 'missing-url', 'missing-abstract', 'missing-abstract-ko', 'missing-abstract-source']) {
    assert.deepEqual(issue(result, id), [p]);
  }
  assert.equal(issue(result, 'generic-only-context').length, 0);
});

test('all duplicate DOI members are returned after conservative canonicalization', () => {
  const a = paper({ id: 'a', doi: ' 10.1234/ABC ' });
  const b = paper({ id: 'b', doi: 'https://doi.org/10.1234/abc' });
  const c = paper({ id: 'c', doi: 'DOI: 10.1234/Abc' });
  const d = paper({ id: 'd', doi: 'http://dx.doi.org/10.1234/abc' });
  const distinct = paper({ id: 'e', doi: '10.1234/abc.' });
  const result = auditClassification([a, b, c, d, distinct]);
  assert.deepEqual(issue(result, 'duplicate-doi'), [a, b, c, d]);
  assert.equal(issue(result, 'duplicate-id').length, 0);
});

test('duplicate IDs remain case-sensitive and blank DOI/IDs do not form duplicate groups', () => {
  const a = paper({ id: ' key ', doi: '' });
  const b = paper({ id: 'key', doi: ' ' });
  const c = paper({ id: 'KEY', doi: null });
  const d = paper({ id: '', doi: undefined });
  const e = paper({ id: ' ', doi: '' });
  const result = auditClassification([a, b, c, d, e]);
  assert.deepEqual(issue(result, 'duplicate-id'), [a, b]);
  assert.equal(issue(result, 'duplicate-doi').length, 0);
});

test('obesity, diabetes, lipids and fibrosis alone do not support a liver label', () => {
  const p = paper({ topics: [LIVER], abstract: 'Obesity, diabetes, lipid metabolism and pulmonary fibrosis were studied.' });
  assert.deepEqual(issue(auditClassification([p]), 'liver-without-specific-evidence'), [p]);
});

test('short abstract check distinguishes missing, 49 words and 50 words', () => {
  const empty = paper({ abstract: ' ' });
  const short = paper({ abstract: Array(49).fill('word').join(' ') });
  const long = paper({ abstract: Array(50).fill('word').join(' ') });
  assert.deepEqual(issue(auditClassification([empty, short, long]), 'short-abstract'), [short]);
});

test('specific liver evidence and plural variants suppress the liver flag', () => {
  for (const term of ['liver', 'livers', 'hepatic', 'hepatocytes', 'hepatocellular', 'hepatobiliary', 'hepatosteatosis', 'MASLD', 'NAFLD', 'NASH', 'MASH', 'Kupffer', 'steatosis', 'steatotic', 'steatohepatitis']) {
    const result = auditClassification([paper({ topics: [LIVER], abstract: `We studied ${term}.` })]);
    assert.equal(issue(result, 'liver-without-specific-evidence').length, 0, term);
  }
});

test('evidence uses word boundaries, not journal, AI reason or translated abstract', () => {
  const p = paper({ topics: [LIVER], title: 'Delivery and Nashville', journal: 'Liver Research', aiReason: 'hepatic', abstractKo: 'liver MASLD' });
  assert.deepEqual(issue(auditClassification([p]), 'liver-without-specific-evidence'), [p]);
});

test('body composition alone is broad adipose support; direct or auxiliary support prevents that flag', () => {
  for (const term of ['adiposity', 'fat mass', 'body-fat']) {
    const p = paper({ topics: [ADIPOSE], abstract: `We measured ${term}.` });
    assert.deepEqual(issue(auditClassification([p]), 'adipose-broad-only'), [p]);
    for (const direct of ['adipose tissue', 'adipocytes', 'pre-adipocytes', 'adipogenesis', 'brown fat', 'fat depots', 'UCP1', 'adipokines', 'lipodystrophy', 'stromal vascular fraction']) {
      const result = auditClassification([paper({ topics: [ADIPOSE], abstract: `${term} and ${direct}.` })]);
      assert.equal(issue(result, 'adipose-broad-only').length, 0, direct);
    }
  }
});

test('untagged adipose candidates require direct evidence rather than ambiguous abbreviations', () => {
  for (const term of ['adipose', 'adipocytes', 'preadipocytes', 'pre-adipocytes', 'adipogenic', 'beige fat', 'subcutaneous fat']) {
    const p = paper({ title: `Analysis of ${term}` });
    assert.deepEqual(issue(auditClassification([p]), 'untagged-adipose'), [p], term);
  }
  for (const term of ['BAT', 'WAT', 'adiposity', 'fat mass', 'body fat', 'UCP1', 'mitochondria', 'thermogenesis']) {
    assert.equal(issue(auditClassification([paper({ title: term })]), 'untagged-adipose').length, 0, term);
  }
  assert.equal(issue(auditClassification([paper({ topics: [ADIPOSE], title: 'Adipose tissue' })]), 'untagged-adipose').length, 0);
});

test('omics candidates use explicit methods and normalize typography', () => {
  for (const term of ['single-cell RNA sequencing', 'single-nucleus RNA-seq', 'single-cell transcriptomics', 'single-cell profiling', 'spatial transcriptomics', 'snRNA-seq', 'scRNAseq', 'scATAC-seq', 'adipose tissue atlas', 'WATLAS', 'single\u2011cell RNA\u2013sequencing']) {
    const p = paper({ abstract: `We used ${term}.` });
    assert.deepEqual(issue(auditClassification([p]), 'untagged-omics'), [p], term);
  }
  for (const term of ['single-cell', 'spatial memory', 'atlas', 'single-cellular']) {
    assert.equal(issue(auditClassification([paper({ abstract: term })]), 'untagged-omics').length, 0, term);
  }
  assert.equal(issue(auditClassification([paper({ topics: [OMICS], abstract: 'scRNA-seq' })]), 'untagged-omics').length, 0);
});

test('aging candidates include spelling and noun/adjective variants, not patient age alone', () => {
  for (const term of ['aging', 'ageing', 'senescence', 'senescent', 'inflammaging']) {
    const p = paper({ title: `The ${term} study` });
    assert.deepEqual(issue(auditClassification([p]), 'untagged-aging'), [p], term);
  }
  for (const term of ['patient age', 'aged 40', 'age-related', 'imaging', 'damaging']) {
    assert.equal(issue(auditClassification([paper({ title: term })]), 'untagged-aging').length, 0, term);
  }
  assert.equal(issue(auditClassification([paper({ topics: [AGING], title: 'Aging' })]), 'untagged-aging').length, 0);
});

test('general-only context requires observed evidence and no metabolic anchor', () => {
  const generic = paper({ topics: [IMMUNE, OMICS], abstract: 'Immune regulation mapped by single-cell profiling in lung infection.' });
  assert.deepEqual(issue(auditClassification([generic]), 'generic-only-context'), [generic]);
  for (const anchor of ['liver', 'adipose', 'adiposity', 'diabetes', 'lipid metabolism', 'insulin', 'glucose', 'TBK1', 'cholesterol']) {
    const result = auditClassification([paper({ ...generic, abstract: `${generic.abstract} ${anchor}` })]);
    assert.equal(issue(result, 'generic-only-context').length, 0, anchor);
  }
  assert.equal(issue(auditClassification([paper({ topics: [IMMUNE] })]), 'generic-only-context').length, 0);
  assert.equal(issue(auditClassification([paper({ ...generic, topics: [IMMUNE, 'Other'] })]), 'generic-only-context').length, 0);
});

test('title and abstract cannot manufacture a phrase across the field boundary', () => {
  const result = auditClassification([paper({ title: 'single-cell', abstract: 'profiling was used' })]);
  assert.equal(issue(result, 'untagged-omics').length, 0);
});

test('deterministic, nonmutating output keeps original references and input order', () => {
  const a = Object.freeze(paper({ id: 'z', topics: Object.freeze([LIVER, LIVER, ' ', ADIPOSE]), aiScore: 99 }));
  const b = Object.freeze(paper({ id: 'a', topics: Object.freeze([AGING]), aiScore: 98 }));
  const input = Object.freeze([a, b]);
  const before = JSON.stringify(input);
  const result = auditClassification(input);
  assert.deepEqual(result, auditClassification(input));
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.total, 2);
  assert.equal(result.topicAssignments, 3);
  assert.equal(result.multiTopicCount, 1);
  assert.equal(result.scoreSaturationCount, 1);
  assert.equal(issue(result, 'liver-without-specific-evidence')[0], a);
  assert.deepEqual(issue(result, 'duplicate-doi'), [a, b]);
});

test('real public export has coherent audit totals and no mutation', () => {
  const payload = JSON.parse(readFileSync(new URL('../public/data/papers.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(payload);
  const result = auditClassification(payload.papers);
  assert.equal(result.total, payload.papers.length);
  const substantiveTopics = (p) => new Set(p.topics.map((t) => t.trim().toLowerCase()).filter((t) => t && t !== UNCLASSIFIED_TOPIC && t !== 'unclassified'));
  assert.equal(result.topicAssignments, payload.papers.reduce((sum, p) => sum + substantiveTopics(p).size, 0));
  assert.equal(result.multiTopicCount, payload.papers.filter((p) => new Set(p.topics).size > 1).length);
  assert.equal(result.scoreSaturationCount, payload.papers.filter((p) => p.aiScore === 99).length);
  assert.equal(JSON.stringify(payload), before);
  const members = new Set(payload.papers);
  assert.ok(result.issues.every(({ papers }) => papers.every((p) => members.has(p))));
  console.log(JSON.stringify({ total: result.total, multiTopicCount: result.multiTopicCount, topicAssignments: result.topicAssignments, scoreSaturationCount: result.scoreSaturationCount, issues: Object.fromEntries(result.issues.map((i) => [i.id, i.papers.length])) }));
});
