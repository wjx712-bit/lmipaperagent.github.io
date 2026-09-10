import { buildClassificationPreview, PREVIEW_VERSION, PREVIEW_TOPICS } from './classificationPreview.js';

export const PREVIEW_SCHEMA = 'lmi-classification-preview/1';

// Whitelist classification inputs: no member identity, score, or review note crosses this boundary.
export function previewInputs(papers) {
  return papers.map((paper) => ({
    id: paper.id, doi: paper.doi || '', title: paper.title || '',
    journal: paper.journal || paper.journalShort || '', publishedAt: paper.publishedAt || '',
    abstract: paper.abstract || '', topics: Array.isArray(paper.topics) ? [...paper.topics] : [],
  }));
}

export function previewSummary(records) {
  const labels = [...new Set([...PREVIEW_TOPICS.map((topic) => topic.label), ...records.flatMap((row) => [...row.oldTopics, ...row.coreTopics, ...row.relatedTopics])])];
  return {
    total: records.length,
    changed: records.filter((row) => row.changed).length,
    needsReview: records.filter((row) => row.needsReview).length,
    noCore: records.filter((row) => !row.coreTopics.length).length,
    oldUnclassified: records.filter((row) => !row.oldTopics.length).length,
    topics: labels.map((label) => ({
      label, kind: PREVIEW_TOPICS.find((topic) => topic.label === label)?.kind || 'legacy',
      old: records.filter((row) => row.oldTopics.includes(label)).length,
      core: records.filter((row) => row.coreTopics.includes(label)).length,
      related: records.filter((row) => row.relatedTopics.includes(label)).length,
      added: records.filter((row) => row.addedTopics.includes(label)).length,
      removedFromCore: records.filter((row) => row.removedTopics.includes(label)).length,
    })),
  };
}

export async function makePreviewSnapshot(papers) {
  const inputs = previewInputs(papers);
  if (inputs.some((paper) => typeof paper.id !== 'string' || !paper.id.trim()) || new Set(inputs.map((paper) => paper.id)).size !== inputs.length) throw new Error('논문 ID가 없거나 중복되어 미리보기를 만들 수 없습니다.');
  const sorted = [...inputs].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const bytes = new TextEncoder().encode(JSON.stringify(sorted));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const inputHash = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
  const byId = new Map(inputs.map((paper) => [paper.id, paper]));
  const records = buildClassificationPreview(inputs).map((row) => {
    const paper = byId.get(row.paperId);
    return { ...row, oldTopics: [...paper.topics], title: paper.title, doi: paper.doi, journal: paper.journal, publishedAt: paper.publishedAt };
  });
  return {
    schema: PREVIEW_SCHEMA, version: PREVIEW_VERSION, generatedAt: new Date().toISOString(),
    inputHash, inputHashAlgorithm: 'SHA-256 of canonical previewInputs sorted by paper ID',
    applied: false, reviewDataIncluded: false, engine: 'deterministic-evidence-rules; no LLM or paid API',
    interpretation: 'Provisional core/related candidates, not verified classifications. Existing topics, assignments, progress and ratings are unchanged.',
    summary: previewSummary(records), records,
  };
}

export function previewExportRows(snapshot, records = snapshot.records) {
  return records.map((row) => ({
    paper_id: row.paperId, doi: row.doi, title: row.title, journal: row.journal,
    published_at: row.publishedAt,
    original_url: row.doi ? `https://doi.org/${encodeURIComponent(row.doi).replace(/%2F/gi, '/')}` : '',
    generated_at: snapshot.generatedAt,
    preview_version: snapshot.version, input_hash: snapshot.inputHash, applied: false,
    old_topics: row.oldTopics, core_candidates: row.coreTopics, related_candidates: row.relatedTopics,
    added_core_candidates: row.addedTopics, absent_from_core_candidates: row.removedTopics,
    method_tags: row.methodTags || [], needs_review: row.needsReview,
    review_reasons: row.reviewReasons, evidence: row.evidence,
    preview_decision: '', preview_note: '',
  }));
}
