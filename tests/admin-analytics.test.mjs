import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnalytics, reviewExportRows, toCsv } from '../src/adminAnalytics.js';

function paper(id, topics = ['Metabolism'], fields = {}) {
  return {
    id,
    doi: id,
    title: `Paper ${id}`,
    journal: 'Nature Communications',
    journalShort: 'Nat Commun',
    topics,
    ...fields,
  };
}

function review(paperId, userId, score, fields = {}) {
  return {
    paper_id: paperId,
    user_id: userId,
    score,
    note: '',
    updated_at: '2026-09-01T00:00:00Z',
    ...fields,
  };
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

const exportHeaders = [
  'paper_id', 'doi', 'title', 'journal', 'paper_topics', 'review_topic',
  'review_topic_status', 'reviewer_id', 'reviewer_name', 'reviewer_email',
  'score', 'note', 'updated_at', 'rubric_version',
];

test('multi-topic groups overlap while paper coverage and review counts stay unique', () => {
  const first = paper('p1', ['Metabolism', 'Aging', 'Metabolism']);
  const papers = [
    first,
    paper('p2', ['Aging']),
    paper('p3', [], { journal: 'Cell', journalShort: 'Cell' }),
    { ...first, topics: ['Duplicate record'] },
  ];
  const reviews = [review('p1', 'alice', 1), review('p1', 'bob', 5), review('p2', 'alice', 3)];
  const result = buildAnalytics(papers, reviews);

  assert.equal(result.papers.length, 3);
  assert.equal(result.papers[0].title, first.title);
  assert.equal(result.reviews.length, 3);
  assert.deepEqual(result.summary, {
    total: 3, reviewed: 2, pending: 1, reviewCount: 3, reviewerCount: 2,
    multiReviewed: 1, disagreements: 1,
  });
  assert.deepEqual(result.topics, [
    {
      name: 'Aging', total: 2, reviewed: 2, pending: 0, reviewCount: 3,
      reviewerCount: 2, progress: 100, scoreCounts: [1, 0, 1, 0, 1], disagreements: 1,
    },
    {
      name: 'Metabolism', total: 1, reviewed: 1, pending: 0, reviewCount: 2,
      reviewerCount: 2, progress: 100, scoreCounts: [1, 0, 0, 0, 1], disagreements: 1,
    },
    {
      name: 'Unclassified', total: 1, reviewed: 0, pending: 1, reviewCount: 0,
      reviewerCount: 0, progress: 0, scoreCounts: [0, 0, 0, 0, 0], disagreements: 0,
    },
  ]);
  assert.deepEqual(result.journals, [
    {
      name: 'Cell', total: 1, reviewed: 0, pending: 1, reviewCount: 0,
      reviewerCount: 0, progress: 0, scoreCounts: [0, 0, 0, 0, 0], disagreements: 0,
    },
    {
      name: 'Nat Commun', total: 2, reviewed: 2, pending: 0, reviewCount: 3,
      reviewerCount: 2, progress: 100, scoreCounts: [1, 0, 1, 0, 1], disagreements: 1,
    },
  ]);
  assert.deepEqual(result.reviewerStats, [
    { userId: 'alice', total: 3, reviewed: 2, reviewCount: 2, progress: 66.7, scoreCounts: [1, 0, 1, 0, 0] },
    { userId: 'bob', total: 3, reviewed: 1, reviewCount: 1, progress: 33.3, scoreCounts: [0, 0, 0, 0, 1] },
  ]);
});

test('progress uses unique paper coverage, not the number of reviews or assignments', () => {
  const papers = [paper('p1'), paper('p2'), paper('p3')];
  const result = buildAnalytics(papers, [
    review('p1', 'a', 2), review('p1', 'b', 3), review('p1', 'c', 4), review('p1', 'd', 5),
  ]);
  for (const group of [...result.topics, ...result.journals]) {
    assert.equal(group.total, 3);
    assert.equal(group.reviewed, 1);
    assert.equal(group.pending, 2);
    assert.equal(group.reviewCount, 4);
    assert.equal(group.progress, 33.3);
  }
  for (const stats of result.reviewerStats) {
    assert.equal(stats.total, 3);
    assert.equal(stats.reviewed, 1);
    assert.equal(stats.progress, 33.3);
  }
});

test('missing, empty, and malformed topics are Unclassified; journal falls back to full name', () => {
  const papers = [
    paper('p1', undefined, { topics: undefined, journalShort: undefined, journal: 'Full Journal' }),
    paper('p2', null, { journalShort: '  ', journal: '' }),
    paper('p3', [null, '', '  ', 5]),
    paper('p4', 'Not an array'),
    paper('p5', [' Aging ', 'Aging', '']),
  ];
  const result = buildAnalytics(papers, [review('p2', 'a', 1)]);
  assert.deepEqual(result.topics.map(({ name, total, reviewed, progress }) => (
    { name, total, reviewed, progress }
  )), [
    { name: 'Aging', total: 1, reviewed: 0, progress: 0 },
    { name: 'Unclassified', total: 4, reviewed: 1, progress: 25 },
  ]);
  assert.deepEqual(result.journals.map(({ name, total }) => ({ name, total })), [
    { name: 'Full Journal', total: 1 },
    { name: 'Nat Commun', total: 3 },
    { name: 'Unclassified', total: 1 },
  ]);
});

test('empty scope has finite zero counts and no active reviewers', () => {
  assert.deepEqual(buildAnalytics([], []), {
    papers: [], reviews: [], topics: [], journals: [], disagreements: [], reviewerStats: [],
    summary: { total: 0, reviewed: 0, pending: 0, reviewCount: 0, reviewerCount: 0, multiReviewed: 0, disagreements: 0 },
    excluded: { orphanReviews: 0, invalidReviews: 0, duplicateReviews: 0 },
  });
  assert.equal(buildAnalytics([paper('p1')], []).topics[0].progress, 0);
});

test('numeric string scores normalize to integers and score 1 remains a valid review', () => {
  const papers = [paper('p1')];
  const reviews = [1, ' 2 ', '3', 4, '5'].map((score, index) => review('p1', `u${index}`, score));
  const result = buildAnalytics(papers, reviews);
  assert.deepEqual(result.reviews.map(({ score }) => score), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.topics[0].scoreCounts, [1, 1, 1, 1, 1]);
  assert.deepEqual(result.journals[0].scoreCounts, [1, 1, 1, 1, 1]);
  assert.equal(result.summary.reviewed, 1);
  assert.equal(result.summary.reviewCount, 5);
  assert.deepEqual(reviewExportRows(papers, reviews).map(({ score }) => score), [1, 2, 3, 4, 5]);
});

test('rejects non-integers, out-of-range scores, coercion traps, and blank or invalid IDs', () => {
  const scores = [0, 6, -1, 2.5, '2.5', NaN, Infinity, -Infinity, '', ' ', null, undefined,
    true, false, [], [1], {}, '1point', 'NaN', 'Infinity'];
  const reviews = scores.map((score, index) => review('p1', `u${index}`, score));
  reviews.push(
    ...['', '  ', null, undefined, 1, {}].map((id) => review('p1', id, 3)),
    ...['', '  ', null, undefined, 1].map((id) => review(id, 'a', 3)),
    null,
    undefined,
    {},
  );
  const result = buildAnalytics([paper('p1')], reviews);
  assert.equal(result.reviews.length, 0);
  assert.equal(result.summary.pending, 1);
  assert.deepEqual(result.excluded, { orphanReviews: 0, invalidReviews: reviews.length, duplicateReviews: 0 });
  assert.deepEqual(reviewExportRows([paper('p1')], reviews), []);
});

test('excludes orphans, invalid rows and older duplicates without double-counting exclusions', () => {
  const reviews = [
    review('p1', 'a', 5, { updated_at: '2026-09-01T00:00:00Z' }),
    review('p1', 'a', '1', { updated_at: '2026-09-03T00:00:00Z', note: 'latest valid' }),
    review('p1', 'a', 4, { updated_at: '2026-09-02T00:00:00Z' }),
    review('p1', 'a', 0, { updated_at: '2026-09-04T00:00:00Z' }),
    review('p1', 'b', 2),
    review('missing', 'a', 3),
    review('missing', 'a', 4),
    review('missing', '', 3),
  ];
  const result = buildAnalytics([paper('p1')], reviews);
  assert.deepEqual(result.excluded, { orphanReviews: 2, invalidReviews: 2, duplicateReviews: 2 });
  assert.equal(result.reviews.length, 2);
  assert.equal(result.reviews.find(({ user_id }) => user_id === 'a').score, 1);
  assert.equal(result.reviews.find(({ user_id }) => user_id === 'a').note, 'latest valid');
  assert.deepEqual(result.topics[0].scoreCounts, [1, 1, 0, 0, 0]);
  assert.equal(result.summary.multiReviewed, 1);
  assert.equal(result.disagreements.length, 0);
  assert.equal(result.reviews.length + Object.values(result.excluded).reduce((a, b) => a + b, 0), reviews.length);
});

test('orphan counts and reviewer denominators are relative to the current paper scope', () => {
  const papers = [paper('p1'), paper('p2')];
  const reviews = [review('p1', 'a', 1), review('p2', 'b', 5)];
  assert.equal(buildAnalytics(papers, reviews).excluded.orphanReviews, 0);
  const scoped = buildAnalytics([papers[0]], reviews);
  assert.equal(scoped.excluded.orphanReviews, 1);
  assert.equal(scoped.summary.total, 1);
  assert.deepEqual(scoped.reviewerStats, [
    { userId: 'a', total: 1, reviewed: 1, reviewCount: 1, progress: 100, scoreCounts: [1, 0, 0, 0, 0] },
  ]);
  assert.equal(reviewExportRows([papers[0]], reviews).length, 1);
  const empty = buildAnalytics([], reviews);
  assert.equal(empty.excluded.orphanReviews, 2);
  assert.equal(empty.summary.total, 0);
  assert.deepEqual(empty.reviewerStats, []);
});

test('same-author history never creates a disagreement or multiple coverage', () => {
  const result = buildAnalytics([paper('p1')], [
    review('p1', 'a', 1),
    review('p1', ' a ', 5, { updated_at: '2026-09-02T00:00:00Z' }),
  ]);
  assert.equal(result.summary.reviewCount, 1);
  assert.equal(result.summary.reviewerCount, 1);
  assert.equal(result.summary.multiReviewed, 0);
  assert.equal(result.summary.disagreements, 0);
  assert.equal(result.excluded.duplicateReviews, 1);
  assert.deepEqual(result.disagreements, []);
  assert.equal(result.reviews[0].user_id, 'a');
});

test('newest selection compares actual instants, not timestamp text or score', () => {
  const newer = review('p1', 'a', 1, { updated_at: '2026-09-02T00:00:00Z', note: 'newer' });
  const older = review('p1', 'a', 5, { updated_at: '2026-09-02T08:00:00+09:00' });
  for (const reviews of [[newer, older], [older, newer]]) {
    assert.equal(buildAnalytics([paper('p1')], reviews).reviews[0].score, 1);
    assert.equal(reviewExportRows([paper('p1')], reviews)[0].note, 'newer');
  }
});

test('missing timestamps sort oldest, created_at is a fallback, and equal timestamps favor the last row', () => {
  const undated = review('p1', 'a', 5, { updated_at: null });
  const dated = review('p1', 'a', 1);
  const created = review('p1', 'a', 2, { updated_at: 'invalid', created_at: '2026-09-03T00:00:00Z' });
  assert.equal(buildAnalytics([paper('p1')], [dated, undated]).reviews[0].score, 1);
  assert.equal(buildAnalytics([paper('p1')], [created, dated, undated]).reviews[0].score, 2);
  assert.equal(buildAnalytics([paper('p1')], [undated, { ...undated, score: 3 }]).reviews[0].score, 3);
  assert.equal(buildAnalytics([paper('p1')], [dated, { ...dated, score: 4 }]).reviews[0].score, 4);
});

test('author-paper pairs cannot collide through separators or object prototype keys', () => {
  const papers = [paper('a|b', ['__proto__']), paper('b', ['constructor']), paper('__proto__')];
  const result = buildAnalytics(papers, [
    review('a|b', 'c', 1),
    review('b', 'c|a', 5),
    review('__proto__', 'constructor', 3),
    review('__proto__', '__proto__', 4),
  ]);
  assert.equal(result.reviews.length, 4);
  assert.equal(result.summary.reviewed, 3);
  assert.equal(result.summary.reviewerCount, 4);
  assert.equal(result.excluded.duplicateReviews, 0);
});

test('disagreement and severe thresholds are inclusive for every score pair', () => {
  for (let min = 1; min <= 5; min += 1) {
    for (let max = min; max <= 5; max += 1) {
      const source = paper('p1', ['A', 'B']);
      const reviews = [review('p1', 'a', min), review('p1', 'b', max)];
      const result = buildAnalytics([source], reviews);
      const expected = max - min >= 2 ? 1 : 0;
      assert.equal(result.summary.multiReviewed, 1);
      assert.equal(result.summary.disagreements, expected, `${min}/${max}`);
      assert.equal(result.disagreements.length, expected, `${min}/${max}`);
      for (const group of [...result.topics, ...result.journals]) assert.equal(group.disagreements, expected);
      if (expected) {
        assert.deepEqual(result.disagreements[0], {
          paper: source, reviews, min, max, spread: max - min, severe: min <= 2 && max >= 4,
        });
      }
    }
  }
});

test('disagreement uses all distinct authors, not just the first pair', () => {
  const result = buildAnalytics([paper('p1')], [
    review('p1', 'a', 3), review('p1', 'b', 3), review('p1', 'c', 1), review('p1', 'd', 5),
  ]);
  const disagreement = result.disagreements[0];
  assert.equal(disagreement.reviews.length, 4);
  assert.equal(disagreement.min, 1);
  assert.equal(disagreement.max, 5);
  assert.equal(disagreement.spread, 4);
  assert.equal(disagreement.severe, true);
  assert.equal(result.summary.disagreements, 1);
});

test('export retains separate latest raw review scores and explicitly marks unrecorded metadata', () => {
  const papers = [paper('p1', ['Aging', 'Metabolism'])];
  const reviews = [
    review('p1', 'a', 5, { note: 'superseded' }),
    review('p1', 'a', '1', { note: 'raw note', updated_at: '2026-09-03T00:00:00Z' }),
    review('p1', 'b', 5, { note: 'other author' }),
    review('p1', 'a', 0, { updated_at: '2026-09-04T00:00:00Z' }),
    review('orphan', 'a', 4),
  ];
  const profiles = [{ id: 'a', display_name: 'Alice', email: 'alice@example.test' }];
  const rows = reviewExportRows(papers, reviews, profiles);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), exportHeaders);
  assert.deepEqual(rows[0], {
    paper_id: 'p1', doi: 'p1', title: 'Paper p1', journal: 'Nature Communications',
    paper_topics: ['Aging', 'Metabolism'], review_topic: null, review_topic_status: 'not_recorded',
    reviewer_id: 'a', reviewer_name: 'Alice', reviewer_email: 'alice@example.test',
    score: 1, note: 'raw note', updated_at: '2026-09-03T00:00:00Z', rubric_version: null,
  });
  assert.equal(rows[1].score, 5);
  assert.equal(rows[1].reviewer_name, 'b');
  assert.equal(rows[1].reviewer_email, '');
  assert.equal(rows[1].review_topic, null);
  assert.equal(rows[1].rubric_version, null);
  assert.notStrictEqual(rows[0].paper_topics, papers[0].topics);
  assert.notStrictEqual(rows[0].paper_topics, rows[1].paper_topics);
});

test('export does not turn missing paper topics into recorded review topics', () => {
  const rows = reviewExportRows(
    [paper('p1', null)],
    [review('p1', 'a', 1, { note: null, updated_at: undefined })],
    [{ id: 'a', display_name: '', email: 'alice@example.test' }],
  );
  assert.deepEqual(rows[0].paper_topics, []);
  assert.equal(rows[0].review_topic, null);
  assert.equal(rows[0].review_topic_status, 'not_recorded');
  assert.equal(rows[0].rubric_version, null);
  assert.equal(rows[0].reviewer_name, 'alice@example.test');
  assert.equal(rows[0].note, '');
  assert.equal(rows[0].updated_at, null);
});

test('CSV has a BOM, schema-ordered quoted headers, CRLF records, and escaped quotes', () => {
  const rows = [
    { note: 'A "quote", comma\nand newline', score: 1, paper_topics: ['A', 'B'], review_topic: null },
    { score: 5, note: '' },
  ];
  assert.equal(toCsv(rows), '\uFEFF"paper_topics","review_topic","score","note"\r\n'
    + '"[""A"",""B""]","","1","A ""quote"", comma\nand newline"\r\n'
    + '"","","5",""');
});

test('CSV header order is independent of object key order and includes later-row keys', () => {
  const first = [{ z: 'Z', note: 'N', a: 'A', score: 1 }, { extra: 'E', note: 'M' }];
  const reordered = [{ score: 1, a: 'A', note: 'N', z: 'Z' }, { note: 'M', extra: 'E' }];
  assert.equal(toCsv(first), toCsv(reordered));
  assert.equal(toCsv(first).split('\r\n')[0], '\uFEFF"score","note","a","extra","z"');
  assert.equal(toCsv([]), `\uFEFF${exportHeaders.map((key) => `"${key}"`).join(',')}`);
  const exported = reviewExportRows([paper('p1')], [review('p1', 'a', 1)]);
  assert.equal(toCsv(exported).split('\r\n')[0], toCsv([]));
});

test('CSV protects formula prefixes, whitespace-prefixed formulas, and leading tabs/newlines', () => {
  const dangerous = [
    '=1+1', '+SUM(1,2)', '-1+2', '@SUM(1,2)',
    ' =1+1', '   +1', '  -1', '  @SUM(A1)', '\u00A0=1', '\uFEFF=1',
    '\t=1', '\r=1', '\n=1', ' \t+1', ' \r\n @SUM(A1)',
    '\tplain', '\nplain', '\rplain', ' \tplain', ' \r\nplain',
  ];
  for (const value of dangerous) {
    assert.equal(toCsv([{ note: value }]), `\uFEFF"note"\r\n"'${value.replace(/"/g, '""')}"`, JSON.stringify(value));
  }
  for (const value of ['ordinary', ' leading space', 'C++', 'A-B', 'email@example.test', "'=already escaped"]) {
    assert.equal(toCsv([{ note: value }]), `\uFEFF"note"\r\n"${value}"`);
  }
  assert.equal(toCsv([{ '=heading': '=value' }]), '\uFEFF"\'=heading"\r\n"\'=value"');
});

test('CSV injection protection never changes raw JSON export values or the caller inputs', () => {
  const papers = freezeDeep([paper('p1', ['A', 'B'], { title: ' =HYPERLINK("x")' })]);
  const reviews = freezeDeep([
    review('p1', 'a', 5),
    review('p1', 'a', '1', { note: '\t=SUM(1,2)', updated_at: '2026-09-03T00:00:00Z' }),
    review('p1', 'b', 5),
  ]);
  const profiles = freezeDeep([{ id: 'a', display_name: '+name', email: 'alice@example.test' }]);
  const before = structuredClone({ papers, reviews, profiles });
  const analytics = buildAnalytics(papers, reviews);
  const rows = freezeDeep(reviewExportRows(papers, reviews, profiles));
  const jsonBefore = JSON.stringify(rows);
  const csv = toCsv(rows);
  assert.ok(csv.includes('"\' =HYPERLINK(""x"")"'));
  assert.ok(csv.includes('"\'\t=SUM(1,2)"'));
  assert.ok(csv.includes('"\'+name"'));
  assert.equal(JSON.stringify(rows), jsonBefore);
  assert.equal(JSON.parse(jsonBefore)[0].title, ' =HYPERLINK("x")');
  assert.equal(JSON.parse(jsonBefore)[0].note, '\t=SUM(1,2)');
  assert.equal(JSON.parse(jsonBefore)[0].reviewer_name, '+name');
  assert.deepEqual({ papers, reviews, profiles }, before);
  assert.notStrictEqual(analytics.reviews[0], reviews[1]);
  assert.deepEqual(buildAnalytics(papers, reviews), analytics);
});
