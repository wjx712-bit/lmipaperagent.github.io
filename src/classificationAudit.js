const TOPICS = {
  liver: 'liver metabolism / masld',
  adipose: 'adipose tissue / adipocyte biology',
  immune: 'inflammation / immune regulation',
  aging: 'aging / senescence',
  omics: 'single-cell / spatial / atlas',
  therapy: 'cell targeting / therapy',
};

const LIVER = /\b(?:livers?|hepatic|hepatocytes?|hepatocellular|hepatobiliary|hepatosteatosis|masld|nafld|nash|mash|kupffer|steatosis|steatotic|steatohepatitis)\b/;
const ADIPOSE = /\b(?:adipose|(?:pre[ -]?)?adipocytes?|adipogenesis|adipogenic|(?:brown|white|beige|visceral|subcutaneous|omental|perivascular|epicardial)[ -]+fat|fat[ -]+(?:tissue|depots?))\b/;
const ADIPOSE_SUPPORT = /\b(?:adipokines?|ucp1|uncoupling[ -]+protein[ -]+1|lipodystroph(?:y|ies|ic)|stromal[ -]+vascular[ -]+fraction)\b/;
const BODY_COMPOSITION = /\b(?:adiposity|fat[ -]+mass|body[ -]+fat)\b/;
const OMICS = /\b(?:single[ -]+(?:cell|nucleus|nuclei)[ -]+(?:rna[ -]*(?:sequencing|seq)|transcriptom(?:ics|ic|es?|e[ -]+sequencing)|sequencing|profiling|atlas)|spatial[ -]+transcriptom(?:ics|ic|es?)|s[cn](?:rna|atac)[ -]*seq|(?:white[ -]+)?adipose[ -]+tissue[ -]+atlas|watlas)\b/;
const AGING = /\b(?:aging|ageing|senescence|senescent|inflammaging)\b/;
const IMMUNE = /\b(?:inflammation|inflammatory|immune|immunity|macrophages?|tregs?|regulatory[ -]+t[ -]+cells?|t[ -]+(?:cells?|lymphocytes?))\b/;
const THERAPY = /\b(?:therapeutic[ -]+targets?|cell[ -]+target(?:ing|ed)[ -]+therap(?:y|ies)|targeted[ -]+delivery|metabolic[ -]+therap(?:y|ies))\b/;
const METABOLIC = /\b(?:metabol(?:ism|ic)|obes(?:ity|e)|diabet(?:es|ic)|insulin|lipids?|fatty[ -]+acids?|lipogenesis|lipolysis|dyslipid(?:emia|aemia)|triglycerides?|cholesterol|glucose|glyc(?:emic|aemic)|thermogenesis|acsl1|tbk1)\b/;
const GENERAL_TOPICS = new Set([TOPICS.immune, TOPICS.aging, TOPICS.omics, TOPICS.therapy]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalized(value) {
  return text(value).normalize('NFKC').toLowerCase().replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ');
}

function doiKey(value) {
  return text(value).toLowerCase().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/, '');
}

function duplicateKeys(papers, key) {
  const counts = new Map();
  for (const paper of papers) {
    const value = key(paper);
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

/**
 * Public-record QA candidates, not ground-truth errors or private review metrics.
 * Issue order is fixed; paper lists retain input order and original references.
 * Topic totals count distinct nonblank labels per paper, including unknown labels.
 * Evidence is matched independently in title and English abstract, never in Korean,
 * journal names, AI reasons, or across the boundary between title and abstract.
 */
export function auditClassification(papers = []) {
  const duplicateDois = duplicateKeys(papers, (paper) => doiKey(paper.doi));
  const duplicateIds = duplicateKeys(papers, (paper) => text(paper.id));
  const records = papers.map((paper) => {
    const topics = new Set((Array.isArray(paper.topics) ? paper.topics : []).map(normalized).filter(Boolean));
    const fields = [normalized(paper.title), normalized(paper.abstract)];
    const has = (pattern) => fields.some((field) => pattern.test(field));
    return { paper, topics, has };
  });
  const definitions = [
    ['unclassified', 'No topic assigned', 'No nonblank topic labels. This may be intentional; inspect the available title and English abstract.',
      ({ topics }) => topics.size === 0],
    ...[
      ['title', 'title'], ['doi', 'DOI'], ['url', 'paper URL'],
      ['abstract', 'English abstract'], ['abstractKo', 'Korean abstract'],
      ['abstractSourceUrl', 'abstract source URL'],
    ].map(([field, label]) => [
      { abstractKo: 'missing-abstract-ko', abstractSourceUrl: 'missing-abstract-source' }[field] || `missing-${field}`,
      `Missing ${label}`,
      `${field} is absent, non-string, empty, or whitespace-only. Presence does not establish correctness${field === 'abstractSourceUrl' ? '; a DOI URL is not evidence of abstract provenance' : ''}.`,
      ({ paper }) => !text(paper[field]),
    ]),
    ['duplicate-doi', 'Duplicate DOI', 'All records sharing a nonblank DOI after trim, lowercase, and removal of a leading doi: or http(s)://(dx.)doi.org/. No punctuation stripping or network validation.',
      ({ paper }) => duplicateDois.has(doiKey(paper.doi))],
    ['duplicate-id', 'Duplicate ID', 'All records sharing a nonblank trimmed ID. IDs are case-sensitive opaque keys; blank IDs are not grouped as duplicates.',
      ({ paper }) => duplicateIds.has(text(paper.id))],
    ['short-abstract', 'Short English abstract', 'Nonblank English abstract with fewer than 50 whitespace-separated words. Short commentary or editorial text can be legitimate; this is not proof of truncation.',
      ({ paper }) => Boolean(text(paper.abstract)) && text(paper.abstract).split(/\s+/u).length < 50],
    ['liver-without-specific-evidence', 'Liver tag without specific evidence', 'Liver metabolism / MASLD is assigned, but available title + English abstract lack whole-word liver(s), hepatic, hepatocyte(s), hepatocellular, hepatobiliary, hepatosteatosis, MASLD, NAFLD, NASH, MASH, Kupffer, steatosis, steatotic or steatohepatitis. Obesity, diabetes and fibrosis alone do not qualify. Review candidate, not proven error.',
      ({ topics, has }) => topics.has(TOPICS.liver) && !has(LIVER)],
    ['adipose-broad-only', 'Adipose tag with body-composition evidence only', 'Adipose topic plus adiposity, fat mass or body fat, without adipose, (pre-)adipocyte(s), adipogenesis, adipogenic, named adipose fat depots, fat tissue/depot, adipokine(s), UCP1, uncoupling protein 1, lipodystrophy or stromal vascular fraction. Broad-only refers to this lexical evidence, not the scientific conclusion.',
      ({ topics, has }) => topics.has(TOPICS.adipose) && has(BODY_COMPOSITION) && !has(ADIPOSE) && !has(ADIPOSE_SUPPORT)],
    ['untagged-adipose', 'Adipose evidence without adipose tag', 'No adipose topic, but title or English abstract explicitly mentions adipose, (pre-)adipocyte(s), adipogenesis, adipogenic, brown/white/beige/visceral/subcutaneous/omental/perivascular/epicardial fat, or fat tissue/depot(s). Adiposity, UCP1, BAT, mitochondria and thermogenesis alone are insufficient.',
      ({ topics, has }) => !topics.has(TOPICS.adipose) && has(ADIPOSE)],
    ['untagged-omics', 'Omics evidence without omics tag', 'No single-cell / spatial / atlas topic, but explicit single-cell/nucleus/nuclei RNA-seq, RNA sequencing, transcriptome/transcriptomics, sequencing, profiling or atlas; spatial transcriptomics/transcriptome; sc/snRNA-seq or sc/snATAC-seq; adipose tissue atlas or WATLAS. Generic single-cell, spatial or atlas alone is insufficient.',
      ({ topics, has }) => !topics.has(TOPICS.omics) && has(OMICS)],
    ['untagged-aging', 'Aging evidence without aging tag', 'No aging / senescence topic, but whole-word aging, ageing, senescence, senescent or inflammaging in title or English abstract. Age, aged, patient age and age-related alone are insufficient. Mentions can be background rather than the main topic.',
      ({ topics, has }) => !topics.has(TOPICS.aging) && has(AGING)],
    ['generic-only-context', 'General topics without a metabolic anchor', 'Only immune/inflammation, aging, omics or therapy topics, with explicit evidence for at least one assigned topic, but no liver/adipose/body-composition or metabolic anchor (metabolism/metabolic, obesity, diabetes, insulin, lipid, fatty acid, lipogenesis/lipolysis, dyslipidemia, triglyceride, cholesterol, glucose/glycemic, thermogenesis, ACSL1 or TBK1). Cross-domain relevance check only, not an exclusion recommendation.',
      ({ topics, has }) => topics.size > 0 && [...topics].every((topic) => GENERAL_TOPICS.has(topic))
        && [[TOPICS.immune, IMMUNE], [TOPICS.aging, AGING], [TOPICS.omics, OMICS], [TOPICS.therapy, THERAPY]]
          .some(([topic, pattern]) => topics.has(topic) && has(pattern))
        && ![LIVER, ADIPOSE, ADIPOSE_SUPPORT, BODY_COMPOSITION, METABOLIC].some(has)],
  ];
  return {
    total: papers.length,
    issues: definitions.map(([id, label, description, matches]) => ({
      id, label, description, papers: records.filter(matches).map(({ paper }) => paper),
    })),
    multiTopicCount: records.filter(({ topics }) => topics.size > 1).length,
    topicAssignments: records.reduce((total, { topics }) => total + topics.size, 0),
    scoreSaturationCount: papers.filter((paper) => paper.aiScore === 99).length,
  };
}
