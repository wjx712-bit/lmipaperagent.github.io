export const UNCLASSIFIED_TOPIC = '\uBBF8\uBD84\uB958';

export function isUnclassifiedTopic(value) {
  return typeof value === 'string' && [UNCLASSIFIED_TOPIC, 'unclassified'].includes(value.trim().toLowerCase());
}

export function classifiedTopicLabels(topics) {
  return [...new Set((Array.isArray(topics) ? topics : [])
    .filter((value) => typeof value === 'string' && value.trim() && !isUnclassifiedTopic(value))
    .map((value) => value.trim()))];
}

export function topicNames(paper) {
  const labels = classifiedTopicLabels(paper.topics);
  return labels.length ? labels : [UNCLASSIFIED_TOPIC];
}
