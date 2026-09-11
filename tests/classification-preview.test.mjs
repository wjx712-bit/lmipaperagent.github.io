import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PREVIEW_VERSION, PREVIEW_TOPICS, buildClassificationPreview } from '../src/classificationPreview.js';
import { UNCLASSIFIED_TOPIC } from '../src/paperTopics.js';

const label = (id) => PREVIEW_TOPICS.find((t) => t.id === id).label;
const preview = (values = {}) => buildClassificationPreview([{ id: 'p', title: '', abstract: '', topics: [], ...values }])[0];
const core = (record, id) => record.coreTopics.includes(label(id));
const related = (record, id) => record.relatedTopics.includes(label(id));
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function aligned(paper, record) {
  const identities = new Set();
  for (const e of record.evidence) {
    assert.ok(['title', 'abstract'].includes(e.field));
    assert.ok(['core', 'related'].includes(e.level));
    assert.ok(Number.isInteger(e.start) && e.start >= 0 && e.end > e.start && e.end <= paper[e.field].length);
    assert.equal(paper[e.field].slice(e.start, e.end), e.quote);
    assert.equal(e.quote, e.quote.trim());
    assert.ok(e.quote && e.terms.length && e.terms.every((term) => e.quote.includes(term)));
    assert.deepEqual(e.terms, [...new Set(e.terms)]);
    if (e.methodTags) assert.deepEqual(e.methodTags, [...new Set(e.methodTags)]);
    assert.equal(e.label, e.topic);
    assert.ok(PREVIEW_TOPICS.some((t) => t.label === e.topic));
    assert.ok(e.reason);
    const identity = JSON.stringify([e.topic, e.level, e.field, e.start, e.end, e.reason]);
    assert.equal(identities.has(identity), false, `Duplicate evidence: ${identity}`);
    identities.add(identity);
  }
}

test('stable preview schema and empty/invalid inputs', () => {
  assert.match(PREVIEW_VERSION, /draft/);
  assert.equal(PREVIEW_TOPICS.length, 7);
  assert.deepEqual(buildClassificationPreview(), []);
  assert.throws(() => buildClassificationPreview({}), TypeError);
  for (const p of [null, {}, { title: 42, abstract: null, topics: null }]) {
    const r = buildClassificationPreview([p])[0];
    assert.deepEqual(r.coreTopics, []);
    assert.deepEqual(r.relatedTopics, []);
    assert.ok(r.needsReview);
    assert.ok(r.reviewReasons.some((reason) => /No explicit topic evidence/.test(reason)));
  }
});

test('nonmutating, repeatable and detached from inputs and earlier outputs', () => {
  const input = freeze([{ id: 'b', title: 'Liver metabolism', abstract: 'We studied hepatocytes.', topics: [label('adipose')], reviews: [{ score: 1 }] }, { id: 'a', title: 'Ageing', topics: [] }]);
  const before = JSON.stringify(input);
  const first = buildClassificationPreview(input);
  assert.deepEqual(first, buildClassificationPreview(input));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(first.map((r) => r.paperId), ['b', 'a']);
  first[0].oldTopics.push('changed locally');
  first[0].evidence[0].terms.push('local');
  assert.equal(JSON.stringify(input), before);
  assert.notDeepEqual(first, buildClassificationPreview(input));
  assert.ok(Object.isFrozen(PREVIEW_TOPICS) && PREVIEW_TOPICS.every(Object.isFrozen));
});

test('generic metabolic and fibrosis contexts never invent liver/adipose cores', () => {
  for (const term of ['brain obesity', 'diabetes', 'lipid metabolism', 'cystic fibrosis', 'pulmonary fibrosis', 'adiposity', 'fat mass', 'bodyfat', 'body fat', 'BAT', 'WAT', 'mitochondria', 'steatosis']) {
    const r = preview({ title: term });
    assert.equal(core(r, 'liver'), false, term);
    assert.equal(core(r, 'adipose'), false, term);
    assert.ok(r.needsReview);
  }
  assert.ok(core(preview({ title: 'Brain obesity and insulin resistance' }), 'metabolism'));
  const organ = preview({ title: 'Liver glucose metabolism in obesity' });
  assert.ok(core(organ, 'liver'));
  assert.ok(related(organ, 'metabolism'));
  assert.equal(core(organ, 'metabolism'), false);
  assert.equal(core(preview({ title: 'Cystic fibrosis' }), 'metabolism'), false);
  const carrier = preview({ abstract: 'We tested pulmonary lipid nanoparticles for delivery.' });
  assert.equal(core(carrier, 'metabolism'), false);
  assert.ok(related(carrier, 'metabolism'));
});

test('direct organ and explicit immune/aging variants', () => {
  for (const term of ['liver', 'hepatic', 'hepatocytes', 'MASLD', 'NAFLD', 'steatohepatitis']) assert.ok(core(preview({ title: term }), 'liver'), term);
  for (const term of ['brown adipocyte', 'adipose', 'pre-adipocytes', 'adipogenesis', 'beige fat', 'fat depots']) assert.ok(core(preview({ title: term }), 'adipose'), term);
  for (const term of ['immune', 'immunity', 'immunological', 'inflammatory', 'macrophages', 'T cells']) assert.ok(core(preview({ title: term }), 'immune'), term);
  for (const term of ['aging', 'ageing', 'senescence', 'senescent', 'inflammaging', 'inflammageing']) assert.ok(core(preview({ title: term }), 'aging'), term);
  for (const term of ['aged 40', 'patient age', 'age-related', 'imaging', 'damaging']) assert.equal(core(preview({ title: term }), 'aging'), false, term);
});

test('method tags preserve single-cell, single-nucleus and spatial distinctions', () => {
  for (const [term, tag] of [
    ['scRNASeq', 'single-cell RNA'], ['scRNA-seq', 'single-cell RNA'], ['single-cell RNA sequencing', 'single-cell RNA'],
    ['single nuclei RNA sequencing', 'single-nucleus RNA'], ['single-nucleus RNA-seq', 'single-nucleus RNA'], ['snRNASeq', 'single-nucleus RNA'],
    ['spatial transcriptomics', 'spatial transcriptomics'], ['single\u2011cell\u00a0RNA\u2013sequencing', 'single-cell RNA'], ['snATAC-seq', 'single-nucleus ATAC'],
  ]) {
    const p = { title: 'Method study', abstract: `We performed ${term} on samples.`, topics: [] };
    const r = preview(p);
    assert.ok(core(r, 'omics'), term);
    const e = r.evidence.find((e) => e.topic === label('omics'));
    assert.ok(e.methodTags.includes(tag), term);
    assert.ok(r.methodTags.includes(tag), term);
    if (tag.startsWith('single-nucleus')) assert.equal(e.methodTags.some((t) => t.startsWith('single-cell')), false);
    assert.equal(e.quote, p.abstract);
    assert.deepEqual(e.terms, [term]);
    aligned(p, r);
  }
  for (const term of ['RNA sequencing', 'bulk RNA-seq', 'single-cell', 'spatial memory', 'atlas', 'single-cellular']) assert.equal(core(preview({ title: term }), 'omics'), false, term);
});

test('exact spans survive Unicode, repeated mentions, long text and field boundaries', () => {
  const p = { title: '\ud83e\uddec  Liver and liver', abstract: `  ${'Neutral text. '.repeat(150)}We performed single\u2011nuclei RNA\u2014seq on samples. We studied adipocytes.`, topics: [] };
  const r = preview(p);
  aligned(p, r);
  assert.equal(r.evidence.filter((e) => e.topic === label('liver')).length, 1);
  assert.deepEqual(r.evidence.find((e) => e.topic === label('liver')).terms, ['Liver', 'liver']);
  assert.equal(r.evidence.find((e) => e.topic === label('omics')).quote, 'We performed single\u2011nuclei RNA\u2014seq on samples.');
  assert.equal(core(preview({ title: 'single-cell', abstract: 'RNA sequencing was performed.' }), 'omics'), false);
  assert.equal(core(preview({ title: 'Study', abstract: 'We performed single-cell. RNA sequencing was available.' }), 'omics'), false);
  assert.deepEqual(preview({ title: 'Biology', abstract: '', abstractKo: 'liver adipose ageing', journal: 'Liver', aiReason: 'scRNASeq' }).coreTopics, []);
});

test('whole original sentences deduplicate terms and methods without collapsing distinct spans or fields', () => {
  const sentence = 'We performed single-cell RNA-seq and snRNA-seq and spatial transcriptomics and single-cell RNA-seq.';
  const p = { title: `  ${sentence}  `, abstract: `\u00a0 ${sentence} \r\n\t${sentence}\u00a0` };
  const r = preview(p);
  aligned(p, r);
  const methods = r.evidence.filter((e) => e.topic === label('omics'));
  assert.equal(methods.length, 3);
  assert.deepEqual(methods.map((e) => e.quote), [sentence, sentence, sentence]);
  for (const e of methods) {
    assert.deepEqual(e.terms, ['single-cell RNA-seq', 'snRNA-seq', 'spatial transcriptomics']);
    assert.deepEqual(e.methodTags, ['single-cell RNA', 'single-nucleus RNA', 'spatial transcriptomics']);
  }
  assert.deepEqual(r.methodTags, ['single-cell RNA', 'single-nucleus RNA', 'spatial transcriptomics']);
  assert.equal(methods[0].field, 'title');
  assert.notEqual(methods[1].start, methods[2].start);
  const longSentence = `We performed single-nucleus RNA sequencing ${'with additional samples '.repeat(200)}successfully.`;
  const longPaper = { title: '', abstract: `  ${longSentence}  ` };
  const longRecord = preview(longPaper);
  aligned(longPaper, longRecord);
  assert.equal(longRecord.evidence.find((e) => e.topic === label('omics')).quote, longSentence);
});

test('sentence evidence retains distinct local levels and reasons, including after organ demotion', () => {
  const p = { title: 'Liver metabolism', abstract: 'We analyzed liver, hepatic physiology is important. We tested lipid nanoparticles and glucose.' };
  const r = preview(p);
  aligned(p, r);
  const liver = r.evidence.filter((e) => e.field === 'abstract' && e.topic === label('liver'));
  assert.equal(liver.length, 2);
  assert.equal(liver[0].quote, 'We analyzed liver, hepatic physiology is important.');
  assert.equal(liver[0].quote, liver[1].quote);
  assert.deepEqual(liver.map((e) => e.level), ['core', 'related']);
  assert.deepEqual(liver.map((e) => e.terms), [['liver'], ['hepatic']]);
  const metabolism = r.evidence.filter((e) => e.field === 'abstract' && e.topic === label('metabolism'));
  assert.equal(metabolism.length, 2);
  assert.ok(metabolism.every((e) => e.level === 'related'));
  assert.notEqual(metabolism[0].reason, metabolism[1].reason);
  const merged = preview({ title: 'Liver glucose metabolism and glucose' }).evidence.filter((e) => e.topic === label('metabolism'));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].terms, ['glucose', 'metabolism']);
});

test('background, speculation and unrelated clauses cannot borrow current-study cues', () => {
  for (const abstract of [
    'Liver metabolism is important. We studied brain neurons.',
    'Liver metabolism is important; we studied brain neurons.',
    'We studied brain neurons, liver metabolism is important.',
    'We studied brain neurons while liver metabolism is important.',
    'We studied brain neurons whereas liver metabolism is important.',
    'We studied brain neurons although liver metabolism is important.',
    'We studied brain neurons and liver metabolism is important.',
    'We performed bulk sequencing and single-cell RNA-seq is a useful method.',
    'Previous studies showed liver inflammation. We measured brain activity.',
    'We previously performed single-cell RNA-seq.',
    'We may perform single-cell RNA-seq.',
    'Here, we may combine genetic lineage tracing and single-nucleus RNA sequencing to demonstrate that adult cells are previously unidentified progenitors.',
    'Here, we propose combining genetic lineage tracing and single-nucleus RNA sequencing to identify cells.',
    'Background: single-cell RNA-seq identifies cell types.',
    'We review liver metabolism.',
  ]) {
    const r = preview({ abstract });
    assert.equal(core(r, 'liver'), false, abstract);
    assert.equal(core(r, 'omics'), false, abstract);
    assert.ok(r.relatedTopics.length && r.needsReview, abstract);
  }
  assert.ok(core(preview({ abstract: 'Here, we show that ageing affects adipocytes.' }), 'aging'));
  assert.ok(core(preview({ abstract: 'Single nuclei RNA sequencing of aged mice identifies a population.' }), 'omics'));
  assert.ok(core(preview({ abstract: 'Using single-cell RNA-Seq analysis, we demonstrated an effect.' }), 'omics'));
  assert.ok(core(preview({ abstract: 'Here, we combine single-nucleus RNA sequencing to identify previously unidentified cells.' }), 'omics'));
});

test('negation scope survives commas, contractions, lists and false boundaries', () => {
  for (const abstract of [
    'We did not perform single-cell RNA sequencing.',
    'We did not perform sequencing, single-cell RNA-seq or spatial transcriptomics.',
    'We never used snRNA-seq.',
    'We did not, in this study, perform single-cell RNA sequencing.',
    'We didn\u2019t perform single-nucleus RNA sequencing.',
    'Without using single-cell RNA-seq we studied cells.',
    'No single-cell RNA-seq was performed.',
    'We were unable to perform spatial transcriptomics.',
    'We did not perform bulk sequencing but used single-cell RNA-seq.',
    'No profiling method (e.g. single-cell RNA-seq) was used.',
    'We did not perform the assay (i.e. single-nucleus RNA sequencing).',
  ]) {
    const r = preview({ abstract });
    assert.equal(core(r, 'omics'), false, abstract);
    assert.ok(related(r, 'omics') && r.needsReview, abstract);
    assert.deepEqual(r.methodTags, [], abstract);
    assert.ok(r.evidence.filter((e) => e.topic === label('omics')).every((e) => /Negated/.test(e.reason)));
  }
  assert.equal(core(preview({ title: 'Liver not examined' }), 'liver'), false);
  assert.equal(core(preview({ title: 'Non-hepatic metabolism' }), 'liver'), false);
  assert.equal(core(preview({ title: 'Liver metabolism?' }), 'liver'), false);
});

test('therapy requires a test or local intervention outcome, not a target conclusion', () => {
  for (const abstract of [
    'We identified a potential therapeutic target.',
    'These results demonstrate a therapeutic target.',
    'Targeting the protein could treat obesity.',
    'We tested neurons, targeting the protein may be useful.',
    'We did not test targeted delivery in mice.',
    'Previous studies showed treatment reduced obesity in mice.',
    'MicroRNA targeting suppresses gene expression in cells.',
    'We showed that microRNA targeting reduces gene expression in cells.',
    'Suppression of transcription reduces gene expression.',
  ]) assert.equal(core(preview({ abstract }), 'therapy'), false, abstract);
  assert.equal(core(preview({ title: 'A therapeutic target for obesity' }), 'therapy'), false);
  for (const abstract of [
    'We tested targeted delivery in mice.',
    'We administered an inhibitor to mice.',
    'Pharmacologically targeting Pdgfr signaling restores adipocyte development.',
    'Treatment reduced inflammation in mice.',
    'Targeted delivery restored expression in organoids.',
  ]) assert.ok(core(preview({ abstract }), 'therapy'), abstract);
});

test('scores, old assignments, translations, journal and reviews cannot supply evidence', () => {
  const text = { title: 'Brain obesity', abstract: 'We studied glucose sensing in neurons.' };
  const clean = preview(text);
  const noisy = preview({ ...text, topics: PREVIEW_TOPICS.map((t) => t.label), aiScore: 99,
    relevanceRaw: 99999, abstractKo: 'liver adipose single-cell RNA-seq',
    journal: 'Aging and Liver', aiReason: 'We tested targeted delivery.', reviews: [{ topic: label('liver') }] });
  assert.deepEqual(noisy.evidence, clean.evidence);
  assert.deepEqual(noisy.coreTopics, clean.coreTopics);
  assert.deepEqual(noisy.relatedTopics, clean.relatedTopics);
  const background = preview({ title: 'Background study', abstract: 'Liver physiology is important.', topics: [label('liver')] });
  assert.deepEqual(background.coreTopics, []);
  assert.deepEqual(background.relatedTopics, [label('liver')]);
  assert.equal(background.changed, true);
  assert.deepEqual(background.addedTopics, []);
  assert.deepEqual(background.removedTopics, [label('liver')]);
  assert.deepEqual(background.oldTopics, [label('liver')]);
  assert.ok(background.needsReview);
});

test('changes compare only old vs core labels and preserve unknown old labels for review', () => {
  const same = preview({ title: 'Liver', topics: [label('liver'), label('liver')] });
  assert.equal(same.changed, false);
  assert.deepEqual(same.addedTopics, []);
  assert.deepEqual(same.removedTopics, []);
  const r = preview({ title: 'Brain obesity', topics: [label('liver'), 'Legacy topic'] });
  assert.deepEqual(r.addedTopics, [label('metabolism')]);
  assert.deepEqual(r.removedTopics, [label('liver'), 'Legacy topic']);
  assert.ok(r.changed && r.needsReview);
  assert.ok(r.reviewReasons.some((reason) => /Unknown old topic/.test(reason)));
  assert.ok(preview({ abstract: Array(49).fill('word').join(' ') }).reviewReasons.some((r) => /short/.test(r)));
  assert.equal(preview({ abstract: Array(50).fill('word').join(' ') }).reviewReasons.some((r) => /short/.test(r)), false);
  const sufficient = preview({ title: 'Liver', abstract: Array(50).fill('word').join(' '), topics: [label('liver')] });
  assert.equal(sufficient.needsReview, false);
  assert.ok(sufficient.evidence.every((e) => /provisional/i.test(e.reason)));
  const extraRelated = preview({ title: 'Liver', abstract: 'Ageing is important.', topics: [label('liver')] });
  assert.deepEqual(extraRelated.relatedTopics, [label('aging')]);
  assert.deepEqual(extraRelated.addedTopics, []);
  assert.deepEqual(extraRelated.removedTopics, []);
  assert.equal(extraRelated.changed, false);
  const noOld = preview({ abstract: 'Liver physiology is important.' });
  assert.deepEqual(noOld.relatedTopics, [label('liver')]);
  assert.deepEqual(noOld.addedTopics, []);
  assert.equal(noOld.changed, false);
  const demoted = preview({ title: 'Liver metabolism', topics: [label('liver'), label('metabolism')] });
  assert.deepEqual(demoted.removedTopics, [label('metabolism')]);
  assert.ok(demoted.changed);
});

test('real export: all spans align, totals cohere, six prior-audit examples are conservative', () => {
  const payload = JSON.parse(readFileSync(new URL('../public/data/papers.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(payload);
  const records = buildClassificationPreview(payload.papers);
  assert.equal(records.length, payload.papers.length);
  assert.deepEqual(records, buildClassificationPreview(payload.papers));
  assert.equal(JSON.stringify(payload), before);
  records.forEach((r, index) => {
    aligned(payload.papers[index], r);
    assert.equal(r.paperId, payload.papers[index].id);
    assert.equal(r.needsReview, r.reviewReasons.length > 0);
    assert.ok(r.coreTopics.every((t) => !r.relatedTopics.includes(t)));
    assert.ok(r.coreTopics.every((t) => r.evidence.some((e) => e.label === t && e.level === 'core')));
    assert.ok(r.relatedTopics.every((t) => r.evidence.some((e) => e.label === t && e.level === 'related')));
    assert.ok(r.methodTags.every((tag) => r.evidence.some((e) => e.level === 'core' && e.methodTags?.includes(tag))));
    assert.deepEqual(r.addedTopics, r.coreTopics.filter((topic) => !r.oldTopics.includes(topic)));
    assert.deepEqual(r.removedTopics, [...new Set(r.oldTopics.filter((topic) => topic !== UNCLASSIFIED_TOPIC && topic.toLowerCase() !== 'unclassified' && !r.coreTopics.includes(topic)))]);
    assert.equal(r.changed, r.addedTopics.length > 0 || r.removedTopics.length > 0);
  });
  const get = (doi) => {
    const index = payload.papers.findIndex((p) => p.doi?.toLowerCase() === doi);
    assert.ok(index >= 0, `Missing audit fixture: ${doi}`);
    return records[index];
  };
  const brain = get('10.1038/s41467-026-77116-9');
  assert.equal(core(brain, 'liver'), false);
  assert.equal(core(brain, 'adipose'), false);
  assert.ok(core(brain, 'metabolism'));
  const cf = get('10.1126/science.aeb0054');
  assert.equal(core(cf, 'liver'), false);
  assert.equal(core(cf, 'metabolism'), false);
  assert.ok(core(cf, 'therapy'));
  for (const [doi, tag] of [['10.1172/jci190635', 'single-cell RNA'], ['10.1038/s41467-024-46944-y', 'single-nucleus RNA']]) {
    assert.ok(get(doi).evidence.some((e) => e.topic === label('omics') && e.level === 'core' && e.methodTags.includes(tag)), doi);
  }
  assert.ok(core(get('10.1038/s41467-023-37386-z'), 'aging'));
  const brownAdipocyte = get('10.1038/s41467-025-60754-w');
  assert.ok(core(brownAdipocyte, 'adipose'));
  const method = brownAdipocyte.evidence.find((e) => e.methodTags?.includes('single-nucleus RNA'));
  assert.ok(method, 'The method phrase must be represented even if its context is related.');
  assert.match(method.quote, /Here, we combine genetic lineage tracing and single-nucleus RNA sequencing to demonstrate/);
  // The actual abstract describes performed work, not a proposed future method.
  assert.equal(method.level, 'core');
  assert.ok(brownAdipocyte.methodTags.includes('single-nucleus RNA'));
  assert.equal(core(brownAdipocyte, 'therapy'), false);
  console.log(JSON.stringify({ previewSummary: {
    total: records.length, changed: records.filter((r) => r.changed).length,
    needsReview: records.filter((r) => r.needsReview).length,
    noCore: records.filter((r) => !r.coreTopics.length).length,
    topics: Object.fromEntries(PREVIEW_TOPICS.map((t) => [t.label, {
      old: records.filter((r) => r.oldTopics.includes(t.label)).length,
      core: records.filter((r) => r.coreTopics.includes(t.label)).length,
      related: records.filter((r) => r.relatedTopics.includes(t.label)).length,
    }])),
  } }));
});
