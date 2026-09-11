export const GENERAL_TOPIC = '__general__';
export const originLabel = (topic) => topic === GENERAL_TOPIC ? '전체 목록' : topic || '평가 경로 미기록';

export function resolveWorkTopic(selectedTopics, explicitWorkTopic = '') {
  if (!selectedTopics.length) return GENERAL_TOPIC;
  if (selectedTopics.length === 1) return selectedTopics[0];
  return explicitWorkTopic === GENERAL_TOPIC || selectedTopics.includes(explicitWorkTopic) ? explicitWorkTopic : '';
}

export async function fetchCompletion(client, papers) {
  const ids = [...new Set(papers.map((paper) => paper.id))];
  if (!ids.length) return new Map();
  const { data, error } = await client.rpc('review_completion', { requested_paper_ids: ids });
  if (error) throw error;
  if (data?.version !== 1 || !Array.isArray(data.papers)) throw new Error('Invalid completion response');
  const allowed = new Set(ids);
  const result = new Map();
  for (const row of data.papers) {
    if (!allowed.has(row.paper_id) || result.has(row.paper_id)
      || !Array.isArray(row.topics) || !Array.isArray(row.other_topics)
      || [...row.topics, ...row.other_topics].some((topic) => typeof topic !== 'string' || !topic)
      || row.other_topics.some((topic) => !row.topics.includes(topic))
      || typeof row.other_unattributed !== 'boolean') throw new Error('Invalid completion row');
    // Explicit projection is also a defense against accidental API field expansion.
    result.set(row.paper_id, { topics: [...new Set(row.topics)], otherTopics: [...new Set(row.other_topics)], otherUnattributed: row.other_unattributed });
  }
  return result;
}

export function topicCompleted(paper, completion, ownReviews, topic) {
  return Boolean(topic && (completion.get(paper.id)?.topics.includes(topic)
    || (ownReviews[paper.id]?.score != null && ownReviews[paper.id]?.reviewTopic === topic)));
}

export function completionProgress(papers, completion, ownReviews = {}, topic = null) {
  const scoped = [...new Map(papers.filter((paper) => !topic || topic === GENERAL_TOPIC || paper.topics.includes(topic)).map((paper) => [paper.id, paper])).values()];
  const reviewed = scoped.filter((paper) => topic
    ? topicCompleted(paper, completion, ownReviews, topic)
    : completion.has(paper.id) || ownReviews[paper.id]?.score != null).length;
  return { total: scoped.length, reviewed, percent: scoped.length ? Math.round(reviewed / scoped.length * 1000) / 10 : 0 };
}

export function reviewQueue(papers, topic, pendingOnly = true) {
  return papers.filter((paper) => (!pendingOnly || paper.ownReviewScore == null)
    && (!topic || topic === GENERAL_TOPIC || paper.topics.includes(topic)));
}
