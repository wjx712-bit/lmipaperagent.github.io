// Experimental rule draft / core candidates, not validated AI or scientific truth.
// No paid APIs, live classifier, assignment, routing or storage dependencies.
import { classifiedTopicLabels, isUnclassifiedTopic } from './paperTopics.js';

export const PREVIEW_VERSION = 'classification-preview-1.1.1-draft';
export const PREVIEW_TOPICS = Object.freeze([
  { id: 'liver', label: 'Liver metabolism / MASLD', kind: 'organ' },
  { id: 'adipose', label: 'Adipose tissue / adipocyte biology', kind: 'organ' },
  { id: 'immune', label: 'Inflammation / immune regulation', kind: 'biology' },
  { id: 'aging', label: 'Aging / senescence', kind: 'biology' },
  { id: 'omics', label: 'Single-cell / spatial / atlas', kind: 'method' },
  { id: 'therapy', label: 'Cell targeting / therapy', kind: 'intervention' },
  { id: 'metabolism', label: 'General metabolism / obesity / insulin resistance', kind: 'context' },
].map(Object.freeze));

// Match typography on the original string: offsets are JS UTF-16 slice offsets.
const SEP = String.raw`[\s\-\u00ad\u2010-\u2015\u2212]`;
const rx = (source, flags = 'iu') => new RegExp(source, flags);
const words = (source) => rx(String.raw`\b(?:${source})\b`, 'giu');
const RNA = String.raw`RNA${SEP}*(?:sequencing|seq)`;
const ATAC = String.raw`ATAC${SEP}*(?:sequencing|seq)`;
const PROFILE = String.raw`(?:${RNA}|${ATAC}|transcriptom(?:ics|ic|es?|e${SEP}+sequencing)|sequencing|profiling|atlas)`;
const RULES = [
  ['liver', words('livers?|hepatic|hepatocytes?|hepatocellular|hepatobiliary|hepatosteatosis|steatohepatitis|MASLD|NAFLD|NASH|MASH|Kupffer')],
  ['adipose', words(String.raw`adipose|(?:pre${SEP}*)?adipocytes?|adipogenesis|adipogenic|(?:brown|white|beige|visceral|subcutaneous|omental|perivascular|epicardial)${SEP}+fat|fat${SEP}+(?:tissue|depots?)`)],
  ['immune', words(String.raw`inflammat(?:ion|ory)|immun(?:e|ity|ological|ology)|macrophages?|monocytes?|neutrophils?|lymphocytes?|Tregs?|regulatory${SEP}+T${SEP}+cells?|[TB]${SEP}+cells?`)],
  ['aging', words(String.raw`ageing|aging|senescence|senescent|inflamm${SEP}*age?ing`)],
  ['omics', words(String.raw`single${SEP}+(?:cells?|nucleus|nuclei)${SEP}+${PROFILE}|spatial${SEP}+(?:transcriptom(?:ics|ic|es?)|${RNA}|proteomics)|s[cn]${SEP}*(?:${RNA}|${ATAC})|(?:white${SEP}+)?adipose${SEP}+tissue${SEP}+atlas|WATLAS`)],
  ['therapy', words(String.raw`therap(?:y|ies|eutic)|treatments?|interventions?|target(?:ing|ed|s?)|deliver(?:y|ed)|administer(?:ed|ing)|pharmacolog(?:ical|ically)|inhibit(?:or|ors|ion)|restoration|suppression`)],
  ['metabolism', words(String.raw`metabol(?:ism|ic)|obes(?:ity|e)|diabet(?:es|ic)|insulin|lipids?|fatty${SEP}+acids?|lipogenesis|lipolysis|dyslipid(?:emia|aemia)|triglycerides?|cholesterol|glucose|glyc(?:emic|aemic)|hyperglyc(?:emia|aemia)|thermogenesis|thermogenic|adiposity|fat${SEP}+mass|body${SEP}*fat`)],
];
const AMBIGUOUS_ORGAN = words(String.raw`BAT|WAT|UCP1|adipokines?|mitochondri(?:a|al)|steatosis|steatotic|adiposity|fat${SEP}+mass|body${SEP}*fat`);
const AMBIGUOUS_METHOD = words(String.raw`single${SEP}+(?:cells?|nucleus|nuclei)|spatial|atlas|${RNA}`);
const NEGATED = /\b(?:not|never|neither|without|unable|unperformed|unavailable|lack(?:s|ed|ing)?|no)\b|\bnon[-\u2010-\u2015]|\b(?:didn|wasn|weren|isn|aren|couldn|haven|hasn)['\u2019]t\b/iu;
const SPECULATIVE = /\b(?:may|might|could|would|potential(?:ly)?|putative|hypothes(?:is|ize|ized)|propos(?:e|ed)|speculat\w*|future|warrant\w*|should|planned|plan to|aim(?:s|ed)? to|whether|unclear|unknown|remain\w* to be)\b|\?/iu;
const BACKGROUND = /\b(?:background|previous(?:ly)?(?!\s+unidentified)|prior|earlier|known|traditionally|generally|typically|commonly|often|review|reviews|reviewed|perspective|we discuss|has been|have been)\b/iu;
const ACTIVE = /\b(?:we|our study|this study|the present study)\s+(?:(?:here|also|further|then|directly|experimentally)\s+)*(?:perform(?:ed)?|us(?:e|ed)|combin(?:e|ed)|conduct(?:ed)?|analy[sz](?:e|ed)|profil(?:e|ed)|sequenc(?:e|ed)|measur(?:e|ed)|test(?:ed)?|treat(?:ed)?|administer(?:ed)?|deliver(?:ed)?|investigat(?:e|ed)|examin(?:e|ed)|demonstrat(?:e|ed)|show(?:ed)?|found|find|identif(?:y|ied)|reveal(?:ed)?|report(?:ed)?|observ(?:e|ed)|establish(?:ed)?|map(?:ped)?|evaluat(?:e|ed)|develop(?:ed)?|generat(?:e|ed))\b/iu;
const PASSIVE = /\b(?:was|were)\s+(?:(?:also|experimentally)\s+)?(?:performed|used|conducted|analy[sz]ed|profiled|sequenced|measured|tested|treated|administered|delivered|evaluated)\b/iu;
const RESULTS = /\b(?:our results|our findings|these results|these findings|these data|results)\s+(?:show(?:ed)?|demonstrat(?:e|ed)|reveal(?:ed)?|indicat(?:e|ed))\b/iu;
const METHOD_USE = /\b(?:using|by applying|combined with)\b/iu;
const METHOD_RESULT = /\b(?:identif(?:y|ies|ied)|reveal(?:s|ed)?|uncover(?:s|ed)?|resolv(?:es|ed))\b/iu;
const TEST_ACTION = /\b(?:targeting|targeted|delivery|delivered|administered|treated|treatment|intervention|inhibitors?|inhibition|restoration|suppression)\b/iu;
const TEST_OUTCOME = /\b(?:rescu(?:es?|ed)|restor(?:es?|ed)|improv(?:es?|ed)|reduc(?:es?|ed)|suppress(?:es|ed)?|prevent(?:s|ed)?|protect(?:s|ed)?|alleviat(?:es?|ed)|ameliorat(?:es?|ed)|revers(?:es?|ed)|increas(?:es?|ed)|decreas(?:es?|ed))\b/iu;
const TEST_CONTEXT = /\b(?:mice|mouse|rats?|cells?|organoids?|patients?|participants?|trial|in vivo|in vitro|pharmacologically|drug|antibody|nanoparticles?|tRNA|mRNA|expression)\b/iu;
const INTERVENTION = /\b(?:delivery|delivered|administered|treated|treatment|intervention|inhibitors?|restoration|pharmacolog\w*|drug|antibody|nanoparticles?)\b/iu;

const string = (value) => typeof value === 'string' ? value : '';
const unique = (values) => [...new Set(values)];
const key = (value) => value.trim().toLowerCase();

function segments(raw, pattern, offset = 0, sentenceMode = false) {
  const result = [];
  let start = 0;
  for (const match of raw.matchAll(pattern)) {
    if (sentenceMode && match[0] === '.' && /(?:\b(?:e\.g|i\.e|et al|figs?|dr|vs|no|ref|approx)|\b[a-z])\.$/iu.test(raw.slice(start, match.index + 1))) continue;
    const end = match.index + (sentenceMode ? match[0].length : 0);
    if (end > start) result.push({ text: raw.slice(start, end), start: offset + start });
    start = match.index + match[0].length;
  }
  if (start < raw.length) result.push({ text: raw.slice(start), start: offset + start });
  return result;
}

function contexts(raw) {
  // Splitting uncertain punctuation is deliberately conservative. Commas in
  // numbers and hyphens within method names must not become clause boundaries.
  return segments(raw, /[.!?](?=\s|$)|[;\r\n]+/gu, 0, true).flatMap((sentence) =>
    segments(sentence.text, /,\s+|\s+(?:but|whereas|although|while|because|which|however|yet)\s+|\s+(?:and|or)\s+(?=(?:(?!\b(?:to|that)\b)[^,;.!?]){0,100}\b(?:is|are|was|were|has|have|can|may|might|could)\b)|\s+[\u2013\u2014]\s+/giu, sentence.start)
      .map((clause) => ({ ...clause, sentence: sentence.text, sentenceStart: sentence.start })));
}

function mergeEvidence(items) {
  const merged = new Map();
  for (const item of items) {
    const identity = JSON.stringify([item.topic, item.level, item.field, item.start, item.end, item.reason]);
    const existing = merged.get(identity);
    if (!existing) merged.set(identity, item);
    else {
      existing.terms = unique([...existing.terms, ...item.terms]);
      if (item.methodTags) existing.methodTags = unique([...(existing.methodTags || []), ...item.methodTags]);
    }
  }
  return [...merged.values()];
}

function methodTags(term) {
  const normalized = term.toLowerCase().replace(rx(`${SEP}+`, 'gu'), ' ');
  const tags = [];
  const assay = /rna\s*(?:seq|sequencing)/u.test(normalized) ? 'RNA'
    : /atac\s*(?:seq|sequencing)/u.test(normalized) ? 'ATAC'
      : /transcriptom/u.test(normalized) ? 'transcriptomics' : 'profiling';
  if (/single cells?\b|^sc\s*(?:rna|atac)/u.test(normalized)) tags.push(`single-cell ${assay}`);
  if (/single (?:nucleus|nuclei)\b|^sn\s*(?:rna|atac)/u.test(normalized)) tags.push(`single-nucleus ${assay}`);
  if (/^spatial\b/u.test(normalized)) tags.push(/proteomics/u.test(normalized) ? 'spatial proteomics' : 'spatial transcriptomics');
  if (/atlas|watlas/u.test(normalized)) tags.push('atlas');
  return tags;
}

function strength(topic, field, clause, term) {
  const local = clause.text;
  // Sentence-wide vetoes prevent scope loss in negated lists, reported prior
  // work and parentheticals. This can undercall mixed sentences, by design.
  if (NEGATED.test(clause.sentence)) return ['related', 'Negated or scope-unclear mention; not evidence of a performed study.'];
  if (SPECULATIVE.test(clause.sentence)) return ['related', 'Speculative or uncertain context; not confirmed study evidence.'];
  if (BACKGROUND.test(clause.sentence)) return ['related', 'Background or prior-work mention; current-study role needs review.'];
  if (topic === 'metabolism' && /^lipids?$/iu.test(term) && /\b(?:nanoparticles?|liposomes?|formulation|lipid screening|lipid carriers?)\b/iu.test(local)) {
    return ['related', 'Lipid delivery/material context does not by itself establish a metabolic study.'];
  }
  const study = ACTIVE.test(local) || PASSIVE.test(local) || RESULTS.test(local);
  if (topic === 'therapy') {
    const tested = TEST_ACTION.test(local) && ((study && /\b(?:test|tested|treat|treated|administer|administered|deliver|delivered|evaluat\w*)\b/iu.test(local))
      || (INTERVENTION.test(local) && TEST_OUTCOME.test(local) && TEST_CONTEXT.test(local)));
    return tested
      ? ['core', 'Provisional intervention/delivery evidence with a local test or outcome cue; not clinical efficacy.']
      : ['related', 'Target or therapy mention without a clear local intervention test; needs review.'];
  }
  if (field === 'title') return ['core', 'Explicit title context; provisional topic, not scientific certainty.'];
  if (study || (topic === 'omics' && (METHOD_USE.test(local) || METHOD_RESULT.test(local)))) {
    return ['core', 'Explicit term with a local performed-study or results cue; provisional evidence.'];
  }
  return ['related', 'Mention without a local performed-study/results cue; may be background.'];
}

/**
 * Pure preview only; callers must restrict any eventual UI to admins.
 * All topic arrays contain labels (oldTopics is a detached copy of input labels).
 * Evidence.topic and evidence.label are PREVIEW_TOPICS labels.
 * quote/start/end cover the complete trimmed original sentence (UTF-16 offsets),
 * while classification cues remain clause-local. Identical topic/level/field/
 * sentence-span/reason entries merge their raw matched terms and methodTags.
 * Sentence context is displayed, never synthesized or truncated. methodTags
 * describe evidence, including related/negated mentions, not confirmed method use.
 * Record-level methodTags summarize core method evidence only; they are still
 * rule-based candidates, not validated methods or an AI assessment.
 * added/removed/changed compare old labels with core candidates ONLY;
 * changed means that label set differs, not that a live classification was edited.
 * Related-only candidates must not be used for automatic main-system routing.
 * General metabolism requires explicit metabolic evidence, never a blind default
 * for unknown papers, and is related when a direct organ core exists.
 */
export function buildClassificationPreview(papers = []) {
  if (!Array.isArray(papers)) throw new TypeError('papers must be an array');
  return papers.map((input) => {
    const paper = input && typeof input === 'object' ? input : {};
    const oldTopics = Array.isArray(paper.topics) ? paper.topics.filter((value) => typeof value === 'string').slice() : [];
    let evidence = [];
    const reasons = new Set();
    const abstract = string(paper.abstract);
    if (!abstract.trim()) reasons.add('English abstract missing; title-only preview.');
    else if (abstract.trim().split(/\s+/u).length < 50) reasons.add('English abstract is short (fewer than 50 words).');
    if (!string(paper.title).trim()) reasons.add('Title missing.');
    for (const field of ['title', 'abstract']) {
      const raw = string(paper[field]);
      for (const clause of contexts(raw)) {
        const start = clause.sentenceStart + clause.sentence.length - clause.sentence.trimStart().length;
        const end = clause.sentenceStart + clause.sentence.trimEnd().length;
        for (const [topic, pattern] of RULES) {
          for (const match of clause.text.matchAll(pattern)) {
            const [level, reason] = strength(topic, field, clause, match[0]);
            const item = { topic, label: PREVIEW_TOPICS.find((t) => t.id === topic).label,
              level, field, start, end,
              quote: raw.slice(start, end), terms: [match[0]], reason };
            if (topic === 'omics') item.methodTags = methodTags(match[0]);
            evidence.push(item);
          }
        }
      }
    }
    const organCore = evidence.some((e) => ['liver', 'adipose'].includes(e.topic) && e.level === 'core');
    if (organCore) {
      for (const item of evidence.filter((e) => e.topic === 'metabolism' && e.level === 'core')) {
        item.level = 'related';
        item.reason = 'Metabolic context accompanying a direct organ core; provisional related topic.';
      }
    }
    // Merge after level adjustments so demoted metabolic entries deduplicate too.
    evidence = mergeEvidence(evidence);
    const coreTopics = PREVIEW_TOPICS.filter((t) => evidence.some((e) => e.topic === t.id && e.level === 'core')).map((t) => t.label);
    const relatedTopics = PREVIEW_TOPICS.filter((t) => !coreTopics.includes(t.label) && evidence.some((e) => e.topic === t.id)).map((t) => t.label);
    for (const topic of PREVIEW_TOPICS) {
      if (relatedTopics.includes(topic.label) && !(topic.id === 'metabolism' && organCore)) reasons.add(`${topic.label}: related evidence only; current-study role needs review.`);
    }
    if (evidence.some((e) => /Negated|Speculative|Background/.test(e.reason))) reasons.add('Negation, speculation or background scope requires manual review.');
    const fields = [string(paper.title), abstract];
    const has = (pattern) => fields.some((raw) => [...raw.matchAll(pattern)].length > 0);
    if (!organCore && has(AMBIGUOUS_ORGAN)) reasons.add('Organ context unclear: broad body-composition, mitochondrial or abbreviated terms do not establish liver/adipose core.');
    if (!coreTopics.includes(PREVIEW_TOPICS[4].label) && has(AMBIGUOUS_METHOD)) reasons.add('Method context unclear or unsupported; generic/bulk RNA sequencing is not single-cell evidence.');
    if (!evidence.length) reasons.add('No explicit topic evidence; unknown classification, not a general-metabolism default.');
    if (!coreTopics.length) reasons.add('No provisional core topic established.');
    const oldKeys = new Set(classifiedTopicLabels(oldTopics).map(key));
    const coreKeys = new Set(coreTopics.map(key));
    const addedTopics = coreTopics.filter((label) => !oldKeys.has(key(label)));
    const removedTopics = unique(oldTopics.filter((label) => key(label) && !isUnclassifiedTopic(label) && !coreKeys.has(key(label))));
    if ([...oldKeys].some((label) => !PREVIEW_TOPICS.some((t) => key(t.label) === label))) reasons.add('Unknown old topic label; inspect the proposed mapping manually.');
    const changed = addedTopics.length > 0 || removedTopics.length > 0;
    if (changed) reasons.add('Preview core candidates differ from the old assignments; admin review required before any adoption.');
    evidence.sort((a, b) => ['title', 'abstract'].indexOf(a.field) - ['title', 'abstract'].indexOf(b.field) || a.start - b.start || a.end - b.end || PREVIEW_TOPICS.findIndex((t) => t.id === a.topic) - PREVIEW_TOPICS.findIndex((t) => t.id === b.topic));
    return { paperId: typeof paper.id === 'string' || typeof paper.id === 'number' ? paper.id : string(paper.doi), version: PREVIEW_VERSION, oldTopics,
      coreTopics, relatedTopics, needsReview: reasons.size > 0, reviewReasons: [...reasons],
      evidence: evidence.map((item) => ({ ...item, topic: item.label })),
      methodTags: unique(evidence.filter((item) => item.level === 'core').flatMap((item) => item.methodTags || [])),
      addedTopics, removedTopics, changed };
  });
}
