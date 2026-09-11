import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCompletion, completionProgress, topicCompleted, resolveWorkTopic, reviewQueue, GENERAL_TOPIC, originLabel } from '../src/reviewCoordination.js';
import { buildAnalytics, reviewExportRows } from '../src/adminAnalytics.js';

const papers = [
  { id: 'a', topics: ['Liver', 'Adipose'], ownReviewScore: null },
  { id: 'b', topics: ['Adipose'], ownReviewScore: 2 },
  { id: 'c', topics: ['Liver'], ownReviewScore: null },
];
const snapshot = new Map([
  ['a', { topics: ['Liver'], otherTopics: ['Liver'], otherUnattributed: false }],
  ['b', { topics: [], otherTopics: [], otherUnattributed: true }],
]);

test('review origin follows sidebar selection without a second selector', () => {
  assert.equal(resolveWorkTopic([]), GENERAL_TOPIC);
  assert.equal(resolveWorkTopic([], 'Liver'), GENERAL_TOPIC);
  assert.equal(resolveWorkTopic(['Adipose']), 'Adipose');
  assert.equal(resolveWorkTopic(['Adipose'], 'Liver'), 'Adipose');
  assert.equal(resolveWorkTopic(['Adipose'], GENERAL_TOPIC), 'Adipose');
});

test('only multiple selected topics need a remembered explicit choice', () => {
  assert.equal(resolveWorkTopic(['Adipose', 'Liver']), '');
  assert.equal(resolveWorkTopic(['Adipose', 'Liver'], 'Liver'), 'Liver');
  assert.equal(resolveWorkTopic(['Adipose', 'Liver'], GENERAL_TOPIC), GENERAL_TOPIC);
  assert.equal(resolveWorkTopic(['Adipose', 'Liver'], 'Aging'), '');
});

test('unique-paper progress includes legacy and excludes orphan reviews; topics do not inherit coverage', () => {
  const data = new Map([...snapshot, ['not-in-catalog', { topics: [] }]]);
  assert.deepEqual(completionProgress([...papers, papers[0]], data), { total: 3, reviewed: 2, percent: 66.7 });
  assert.deepEqual(completionProgress(papers, data, {}, 'Liver'), { total: 2, reviewed: 1, percent: 50 });
  assert.deepEqual(completionProgress(papers, data, {}, 'Adipose'), { total: 2, reviewed: 0, percent: 0 });
  assert.deepEqual(completionProgress([], data), { total: 0, reviewed: 0, percent: 0 });
});

test('a successful own save immediately affects coverage without double counting', () => {
  const own = { a: { score: 5, reviewTopic: 'Adipose' }, c: { score: 1, reviewTopic: GENERAL_TOPIC } };
  assert.equal(completionProgress(papers, snapshot, own).reviewed, 3);
  assert.equal(completionProgress(papers, snapshot, own, 'Adipose').reviewed, 1);
  assert.equal(completionProgress(papers, snapshot, own, 'Liver').reviewed, 1);
  assert.equal(completionProgress(papers, snapshot, own, GENERAL_TOPIC).reviewed, 1);
  assert.equal(topicCompleted(papers[0], snapshot, own, 'Adipose'), true);
});

test('default own-pending queue retains other-member reviewed papers and honors topic intersection', () => {
  assert.deepEqual(reviewQueue(papers, 'Adipose').map(p => p.id), ['a']);
  assert.deepEqual(reviewQueue(papers, GENERAL_TOPIC).map(p => p.id), ['a', 'c']);
  assert.deepEqual(reviewQueue(papers, 'Adipose', false).map(p => p.id), ['a', 'b']);
  assert.equal(topicCompleted(papers[0], snapshot, {}, 'Adipose'), false);
  assert.equal(topicCompleted(papers[0], snapshot, {}, 'Liver'), true);
  assert.equal(topicCompleted(papers[1], snapshot, {}, 'Adipose'), false, 'unknown origin is not assigned to a topic');
});

test('snapshot API receives only requested IDs and keeps no private fields', async () => {
  const rows = await fetchCompletion({ rpc: async (name, args) => {
    assert.equal(name, 'review_completion');
    assert.deepEqual(args, { requested_paper_ids: ['a', 'b', 'c'] });
    return { data: { version: 1, papers: [{ paper_id: 'a', topics: ['Liver'], other_topics: ['Liver'], other_unattributed: false, note: 'must not retain', score: 5, user_id: 'hidden' }] } };
  } }, [...papers, papers[0]]);
  assert.deepEqual(rows, new Map([['a', { topics: ['Liver'], otherTopics: ['Liver'], otherUnattributed: false }]]));
});

test('JSON snapshot is not truncated at the usual 1000-row API limit', async () => {
  const many = Array.from({ length: 2700 }, (_, i) => ({ id: `p${i}` }));
  const rows = await fetchCompletion({ rpc: async () => ({ data: { version: 1, papers: many.map(paper => ({ paper_id: paper.id, topics: [], other_topics: [], other_unattributed: true })) } }) }, many);
  assert.equal(rows.size, 2700);
});

test('missing or invalid shared data fails closed, not zero-completed', async () => {
  for (const data of [null, [], { version: 2, papers: [] }, { version: 1, papers: [{ paper_id: 'unknown', topics: [], other_topics: [], other_unattributed: false }] }]) {
    await assert.rejects(fetchCompletion({ rpc: async () => ({ data }) }, papers));
  }
  await assert.rejects(fetchCompletion({ rpc: async () => ({ error: new Error('permission denied') }) }, papers));
});

test('admin exports preserve origins without inventing old origins or changing score meaning', () => {
  const reviews = [
    { paper_id: 'a', user_id: 'u1', score: 1, note: 'No lab relevance', review_topic: 'Liver' },
    { paper_id: 'a', user_id: 'u2', score: 5, note: 'Relevant', review_topic: 'Adipose' },
    { paper_id: 'b', user_id: 'u1', score: 3 },
  ];
  const rows = reviewExportRows(papers, reviews);
  assert.deepEqual(rows.map(row => row.review_topic), ['Liver', 'Adipose', null]);
  assert.equal(rows[2].review_topic_status, 'not_recorded');
  const stats = buildAnalytics(papers, reviews);
  assert.equal(stats.summary.reviewCount, 3);
  assert.equal(stats.summary.multiReviewed, 1);
  assert.equal(stats.disagreements.length, 1);
  assert.equal(stats.originTopics.find(row => row.name === 'Adipose').reviewed, 1);
  assert.equal(originLabel(null), '평가 경로 미기록');
  assert.equal(originLabel(GENERAL_TOPIC), '전체 목록');
});
