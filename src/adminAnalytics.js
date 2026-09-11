import { topicNames } from './paperTopics.js';

const REVIEW_EXPORT_HEADERS = [
  'paper_id',
  'doi',
  'title',
  'journal',
  'paper_topics',
  'review_topic',
  'review_topic_status',
  'reviewer_id',
  'reviewer_name',
  'reviewer_email',
  'score',
  'note',
  'updated_at',
  'rubric_version',
];

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const emptyScores = () => [0, 0, 0, 0, 0];
const progress = (reviewed, total) => total ? Math.round((reviewed / total) * 1000) / 10 : 0;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function reviewTime(review) {
  const updated = Date.parse(review.updated_at);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(review.created_at);
  return Number.isFinite(created) ? created : -Infinity;
}

function normalizeScope(papers, reviews) {
  const paperById = new Map();
  for (const paper of papers) {
    if (hasText(paper?.id) && !paperById.has(paper.id)) paperById.set(paper.id, paper);
  }

  const latestByPaper = new Map();
  const excluded = { orphanReviews: 0, invalidReviews: 0, duplicateReviews: 0 };
  for (const review of reviews) {
    const score = typeof review?.score === 'number' || hasText(review?.score)
      ? Number(review.score)
      : NaN;
    // Exclusions are disjoint: malformed rows, then out-of-scope rows, then duplicates.
    if (!Number.isInteger(score) || score < 1 || score > 5
      || !hasText(review?.user_id) || !hasText(review?.paper_id)) {
      excluded.invalidReviews += 1;
      continue;
    }
    if (!paperById.has(review.paper_id)) {
      excluded.orphanReviews += 1;
      continue;
    }

    const normalized = { ...review, user_id: review.user_id.trim(), score };
    let byUser = latestByPaper.get(normalized.paper_id);
    if (!byUser) {
      byUser = new Map();
      latestByPaper.set(normalized.paper_id, byUser);
    }
    const previous = byUser.get(normalized.user_id);
    if (previous) excluded.duplicateReviews += 1;
    // Missing timestamps sort oldest; ties (including missing dates) favor the last row.
    if (!previous || reviewTime(normalized) >= reviewTime(previous)) {
      byUser.set(normalized.user_id, normalized);
    }
  }

  return {
    papers: [...paperById.values()],
    reviews: [...latestByPaper.values()].flatMap((byUser) => [...byUser.values()]),
    excluded,
  };
}

function journalName(paper) {
  if (hasText(paper.journalShort)) return paper.journalShort.trim();
  return hasText(paper.journal) ? paper.journal.trim() : 'Unclassified';
}

function groupStats(papers, reviewsByPaper, disagreementIds, namesForPaper) {
  const groups = new Map();
  for (const paper of papers) {
    const reviews = reviewsByPaper.get(paper.id) || [];
    for (const name of namesForPaper(paper)) {
      if (!groups.has(name)) {
        groups.set(name, {
          name,
          total: 0,
          reviewed: 0,
          pending: 0,
          reviewCount: 0,
          reviewerCount: 0,
          progress: 0,
          scoreCounts: emptyScores(),
          disagreements: 0,
          reviewers: new Set(),
        });
      }
      const group = groups.get(name);
      group.total += 1;
      if (reviews.length) group.reviewed += 1;
      group.reviewCount += reviews.length;
      if (disagreementIds.has(paper.id)) group.disagreements += 1;
      for (const review of reviews) {
        group.reviewers.add(review.user_id);
        group.scoreCounts[review.score - 1] += 1;
      }
    }
  }

  return [...groups.values()].map(({ reviewers, ...group }) => ({
    ...group,
    pending: group.total - group.reviewed,
    reviewerCount: reviewers.size,
    progress: progress(group.reviewed, group.total),
  })).sort((a, b) => compareText(a.name, b.name));
}

// Input papers define the scope. Topic groups overlap; all coverage counts unique papers.
// Progress is a percentage to one decimal; scoreCounts[0..4] correspond to scores 1..5.
export function buildAnalytics(papers = [], reviews = []) {
  const scope = normalizeScope(papers, reviews);
  const reviewsByPaper = new Map();
  const reviewers = new Map();
  for (const review of scope.reviews) {
    if (!reviewsByPaper.has(review.paper_id)) reviewsByPaper.set(review.paper_id, []);
    reviewsByPaper.get(review.paper_id).push(review);
    if (!reviewers.has(review.user_id)) {
      reviewers.set(review.user_id, {
        userId: review.user_id,
        total: scope.papers.length,
        reviewed: 0,
        reviewCount: 0,
        progress: 0,
        scoreCounts: emptyScores(),
      });
    }
    const stats = reviewers.get(review.user_id);
    stats.reviewed += 1;
    stats.reviewCount += 1;
    stats.scoreCounts[review.score - 1] += 1;
  }

  let multiReviewed = 0;
  const disagreements = [];
  for (const paper of scope.papers) {
    const paperReviews = reviewsByPaper.get(paper.id) || [];
    if (paperReviews.length < 2) continue;
    multiReviewed += 1;
    let min = 5;
    let max = 1;
    for (const review of paperReviews) {
      min = Math.min(min, review.score);
      max = Math.max(max, review.score);
    }
    const spread = max - min;
    if (spread >= 2) {
      disagreements.push({ paper, reviews: paperReviews, min, max, spread, severe: min <= 2 && max >= 4 });
    }
  }

  const disagreementIds = new Set(disagreements.map(({ paper }) => paper.id));
  return {
    papers: scope.papers,
    reviews: scope.reviews,
    topics: groupStats(scope.papers, reviewsByPaper, disagreementIds, topicNames),
    journals: groupStats(scope.papers, reviewsByPaper, disagreementIds, (paper) => [journalName(paper)]),
    disagreements,
    reviewerStats: [...reviewers.values()].map((stats) => ({
      ...stats,
      progress: progress(stats.reviewed, stats.total),
    })).sort((a, b) => compareText(a.userId, b.userId)),
    summary: {
      total: scope.papers.length,
      reviewed: reviewsByPaper.size,
      pending: scope.papers.length - reviewsByPaper.size,
      reviewCount: scope.reviews.length,
      reviewerCount: reviewers.size,
      multiReviewed,
      disagreements: disagreements.length,
    },
    excluded: scope.excluded,
  };
}

export function reviewExportRows(papers = [], reviews = [], profiles = []) {
  const scope = normalizeScope(papers, reviews);
  const paperById = new Map(scope.papers.map((paper) => [paper.id, paper]));
  const profileById = new Map(profiles.filter((profile) => hasText(profile?.id))
    .map((profile) => [profile.id.trim(), profile]));

  return scope.reviews.map((review) => {
    const paper = paperById.get(review.paper_id);
    const profile = profileById.get(review.user_id);
    return {
      paper_id: paper.id,
      doi: paper.doi ?? review.doi ?? '',
      title: paper.title ?? '',
      journal: paper.journal || paper.journalShort || '',
      paper_topics: Array.isArray(paper.topics) ? [...paper.topics] : [],
      // Reviews do not record a topic or rubric version; never infer them from the paper.
      review_topic: null,
      review_topic_status: 'not_recorded',
      reviewer_id: review.user_id,
      reviewer_name: profile?.display_name || profile?.email || review.user_id,
      reviewer_email: profile?.email ?? '',
      score: review.score,
      note: review.note ?? '',
      updated_at: review.updated_at ?? null,
      rubric_version: null,
    };
  });
}

function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Quote alone does not stop formulas. Escape leading formulas/control whitespace only in CSV.
  if (/^(?:\s*[=+\-@]|\s*[\t\r\n])/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows = []) {
  const keys = new Set(rows.flatMap((row) => Object.keys(row)));
  const headers = rows.length
    ? [
      ...REVIEW_EXPORT_HEADERS.filter((key) => keys.has(key)),
      ...[...keys].filter((key) => !REVIEW_EXPORT_HEADERS.includes(key)).sort(compareText),
    ]
    : REVIEW_EXPORT_HEADERS;
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((key) => csvCell(Object.hasOwn(row, key) ? row[key] : null)).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}
