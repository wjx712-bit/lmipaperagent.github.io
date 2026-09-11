import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, ExternalLink, FileText } from 'lucide-react';
import { buildAnalytics, reviewExportRows, toCsv } from './adminAnalytics';
import { auditClassification } from './classificationAudit';
import { topicNames } from './paperTopics.js';
import { originLabel } from './reviewCoordination.js';

const PAGE_SIZE = 30;
const QA_COPY = {
  unclassified: ['미분류', '주제가 비어 있거나 미분류로 묶인 논문. 평가 대상이며, 무관한 논문으로 확정한 것은 아닙니다.'],
  'missing-title': ['제목 누락', '제목 필드가 비어 있거나 텍스트가 아닌 논문.'],
  'missing-doi': ['DOI 누락', 'DOI 필드가 비어 있거나 텍스트가 아닌 논문.'],
  'missing-url': ['원문 링크 누락', '원문 URL 필드가 비어 있는 논문. 링크 접속 성공 여부는 별도 점검 대상입니다.'],
  'missing-abstract': ['영문 초록 누락', '영문 초록 필드가 비어 있는 논문.'],
  'missing-abstract-ko': ['한국어 초록 누락', '한국어 초록 필드가 비어 있는 논문. 번역 정확도 검사는 별도입니다.'],
  'missing-abstract-source': ['초록 출처 URL 누락', '초록 출처 URL이 없는 논문. DOI 원문 링크와 초록 출처 추적 정보는 별개입니다.'],
  'duplicate-doi': ['DOI 중복', '접두어·대소문자를 정규화한 DOI가 같은 모든 레코드.'],
  'duplicate-id': ['논문 ID 중복', '공백을 제거한 ID가 같은 모든 레코드.'],
  'short-abstract': ['짧은 초록 재확인', '영문 초록이 공백 기준 50단어 미만인 논문. 짧은 논평일 수도 있어 누락으로 단정하지 않습니다.'],
  'liver-without-specific-evidence': ['간 주제 근거 재확인', '간 주제는 있으나 간·간세포·지방간 관련 명시 용어가 없는 후보. 비만·당뇨·섬유화만으로는 간 근거로 세지 않습니다.'],
  'adipose-broad-only': ['지방량 중심 분류 재확인', '지방 주제에 adiposity·fat mass·body fat만 있고, 직접 지방조직·지방세포 용어나 보조 근거가 없는 후보.'],
  'untagged-adipose': ['지방 주제 추가 검토', '제목·초록에 지방조직/지방세포 관련 명시 용어가 있지만 해당 주제가 없는 후보.'],
  'untagged-omics': ['오믹스 주제 추가 검토', '단일세포·단일핵 분석 또는 공간 전사체 관련 명시 용어가 있지만 해당 주제가 없는 후보.'],
  'untagged-aging': ['노화 주제 추가 검토', 'aging·ageing·senescence 등의 용어가 있지만 노화 주제가 없는 후보. 배경 언급일 수도 있습니다.'],
  'generic-only-context': ['연구실 관련성 재확인', '일반 면역·노화·오믹스·치료 주제만 있고 간·지방·대사 연결 용어가 없는 후보. 제외 권고는 아닙니다.'],
};
const number = (value) => Number(value || 0).toLocaleString('ko-KR');
const percent = (value) => `${Number(value || 0).toFixed(1)}%`;
const nameOf = (profile, userId) => profile?.display_name || profile?.email || userId;
const timestamp = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR') : '미기록';
const safeUrl = (paper) => {
  if (paper.doi) return `https://doi.org/${encodeURIComponent(paper.doi).replace(/%2F/gi, '/')}`;
  try { const url = new URL(paper.url); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AdminInsights({ papers, reviews, profiles, activeTab, fetchedAt }) {
  const [topic, setTopic] = useState('');
  const [journal, setJournal] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [onlySevere, setOnlySevere] = useState(false);
  const [issueId, setIssueId] = useState('');
  const [notice, setNotice] = useState('');
  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const all = useMemo(() => buildAnalytics(papers, reviews), [papers, reviews]);
  const scopedPapers = useMemo(() => papers.filter((paper) => (!topic || topicNames(paper).includes(topic)) && (!journal || (paper.journalShort || paper.journal || 'Unclassified') === journal)), [papers, topic, journal]);
  const scopedReviews = useMemo(() => {
    const ids = new Set(scopedPapers.map((paper) => paper.id));
    return reviews.filter((review) => ids.has(review.paper_id) && (!reviewer || review.user_id === reviewer));
  }, [scopedPapers, reviews, reviewer]);
  const analytics = useMemo(() => buildAnalytics(scopedPapers, scopedReviews), [scopedPapers, scopedReviews]);
  // Disagreement is always across authors, even when the progress filter selects one author.
  const comparison = useMemo(() => buildAnalytics(scopedPapers, reviews), [scopedPapers, reviews]);
  const audit = useMemo(() => {
    const result = auditClassification(scopedPapers);
    return { ...result, issues: result.issues.map((item) => ({ ...item, label: QA_COPY[item.id]?.[0] || item.label, description: QA_COPY[item.id]?.[1] || item.description, ruleDetails: item.description })) };
  }, [scopedPapers]);
  const disagreements = comparison.disagreements.filter((item) => !onlySevere || item.severe).sort((a, b) => b.spread - a.spread);
  const exportRows = useMemo(() => reviewExportRows(scopedPapers, scopedReviews, profiles), [scopedPapers, scopedReviews, profiles]);
  const issue = audit.issues.find((item) => item.id === issueId) || audit.issues.find((item) => item.papers.length) || audit.issues[0];
  const filterKey = `${topic}|${journal}|${reviewer}|${onlySevere}`;
  const filterLabel = `${topic || '전체 주제'} · ${journal || '전체 저널'}`;
  const filenameDate = new Date().toISOString().slice(0, 10);

  function exportReviews(format) {
    const content = format === 'csv' ? toCsv(exportRows) : JSON.stringify({
      exported_at: new Date().toISOString(), fetched_at: fetchedAt,
      filters: { paper_topic: topic || null, journal: journal || null, reviewer_id: reviewer || null },
      topic_basis: 'current_paper_classification_not_review_context',
      rubric_version_status: 'not_recorded', records: exportRows,
    }, null, 2);
    download(`lmi-reviews-${filenameDate}.${format}`, content, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8');
    setNotice(`${number(exportRows.length)}건의 개인별 평가를 내보냈습니다.`);
  }

  function exportReport() {
    const lines = [
      '# 연구실 평가 및 분류 품질 점검 보고서', '',
      `작성 시각: ${new Date().toISOString()}`, `평가 조회 시각: ${fetchedAt}`, `논문 범위: ${filterLabel}`,
      `평가자 범위(진행률/원점수): ${reviewer ? nameOf(profileById.get(reviewer), reviewer) : '전체 평가자'}`, '',
      '## 해석 기준', '',
      '- 논문 주제와 최초 평가 경로는 별개입니다. 새 평가만 경로를 기록하며 기존 평가 경로와 기준 버전은 추정하지 않습니다.',
      '- 모든 점수는 연구실 전체 관련성입니다. 경로는 작업 분담 정보이며 주제별 적합성 점수가 아닙니다.',
      '- 진행률 = 평가가 1건 이상인 고유 논문 수 / 현재 범위 논문 수. 담당자 배정 대비 완료율은 아닙니다.',
      '- 다중 주제 논문은 주제별로 중복 포함됩니다. 미평가는 0점/1점으로 대체하지 않습니다.',
      '- 평가 조회는 고유 키 기반의 여러 DB 요청을 합친 결과이며, 단일 시점 트랜잭션 스냅샷은 아닙니다.',
      '- 불일치는 동일 논문을 평가한 서로 다른 평가자의 최고-최저가 2점 이상인 확인 후보입니다. 평가자 필터와 무관하게 전체 평가자를 비교합니다.',
      '- 1~2점과 4~5점이 공존하면 우선 확인합니다. 같은 주제로 평가한 사실이나 분류 오류를 확정하지 않습니다.',
      '- 분류 품질 규칙은 제목/영문 초록의 용어 기반 점검이며 정확도, 오분류율, 연구 가치 판정이 아닙니다.', '',
      '## 범위 요약', '',
      `- 논문 ${analytics.summary.total}편 / 평가된 논문 ${analytics.summary.reviewed}편 / 미평가 ${analytics.summary.pending}편`,
      `- 개인별 원점수 ${analytics.summary.reviewCount}건 / 평가자 ${analytics.summary.reviewerCount}명`,
      `- 전체 평가자 기준 불일치 후보 ${comparison.disagreements.length}편`, '',
      '## 주제별 집계', '',
      ...analytics.topics.map((row) => `- ${row.name}: ${row.total}편, 평가 ${row.reviewed}편, 진행률 ${percent(row.progress)}, 원점수 ${row.reviewCount}건, 점수1~5 ${row.scoreCounts.join('/')}`), '',
      '## 저널 분포', '', ...analytics.journals.map((row) => `- ${row.name}: ${row.total}편`), '',
      '## 평가 불일치 후보', '',
      ...comparison.disagreements.flatMap((item) => [
        `### ${item.paper.title}`, `DOI: ${item.paper.doi || '미기록'}`, `주제: ${topicNames(item.paper).join('; ')}`, `점수 범위: ${item.min}~${item.max}; 차이 ${item.spread}`, ...item.reviews.map((row) => `- ${nameOf(profileById.get(row.user_id), row.user_id)} (${row.user_id}): ${row.score}점; 경로: ${originLabel(row.review_topic)}; ${row.updated_at || '시각 미기록'}; 노트: ${row.note || '(없음)'}`), '',
      ]),
      '## 분류 품질', '',
      `- 다중 주제 ${audit.multiTopicCount}편 / 주제 배정 총 ${audit.topicAssignments}건`,
      `- 규칙 점수 상한(99점) ${audit.scoreSaturationCount}편. 확률이나 확신도로 해석하지 않음.`, '',
      ...audit.issues.flatMap((item) => [
        `### ${item.label}: ${item.papers.length}편`, item.description, `상세 규칙: ${item.ruleDetails}`,
        ...item.papers.slice(0, 10).map((paper) => `- ${paper.title} | ${paper.doi || paper.id} | ${topicNames(paper).join('; ')}`),
        item.papers.length > 10 ? `예시 10편만 수록. 후보 목록 CSV에서 전체 ${item.papers.length}편 확인 가능.` : '', '',
      ]),
      '## 조치', '',
      '- 이 보고서는 기존 논문, 주제, 점수, 리뷰 노트를 수정하지 않습니다.',
      '- 분류 후보를 사람이 검토한 뒤 버전을 붙여 교정합니다. 현재 분류는 학습 정답이 아닙니다.',
      '- 평가자별 원점수/노트를 보존하고 DOI 단위로 학습·검증·테스트를 분리합니다.',
      '- 이 파일에는 개인별 평가가 포함될 수 있습니다. 관리자용으로 보관하고 공개 저장소에는 올리지 않습니다.',
    ];
    download(`lmi-admin-report-${filenameDate}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
    setNotice('관리자 보고서를 내보냈습니다.');
  }

  return <div className="admin-analytics">
    <div className="analytics-filters">
      <label>논문 주제<select aria-label="관리자 주제 필터" value={topic} onChange={(event) => { setTopic(event.target.value); setNotice(''); }}><option value="">전체 주제</option>{all.topics.map((row) => <option key={row.name} value={row.name}>{row.name} ({row.total})</option>)}</select></label>
      <label>저널<select aria-label="관리자 저널 필터" value={journal} onChange={(event) => { setJournal(event.target.value); setNotice(''); }}><option value="">전체 저널</option>{all.journals.map((row) => <option key={row.name} value={row.name}>{row.name} ({row.total})</option>)}</select></label>
      <label>평가자<select aria-label="관리자 평가자 필터" value={reviewer} disabled={activeTab === 'disagreements' || activeTab === 'quality'} onChange={(event) => { setReviewer(event.target.value); setNotice(''); }}><option value="">전체 평가자</option>{all.reviewerStats.map((row) => <option key={row.userId} value={row.userId}>{nameOf(profileById.get(row.userId), row.userId)}</option>)}</select></label>
    </div>
    <div className="analytics-actions">
      <span>평가 조회 {timestamp(fetchedAt)}</span>
      <button type="button" disabled={!exportRows.length} onClick={() => exportReviews('csv')}><Download size={15} />원점수 CSV</button>
      <button type="button" disabled={!exportRows.length} onClick={() => exportReviews('json')}><Download size={15} />원점수 JSON</button>
      <button type="button" onClick={exportReport}><FileText size={15} />보고서</button>
    </div>
    {notice && <p role="status" className="analytics-notice">{notice}</p>}
    {(all.excluded.orphanReviews > 0 || all.excluded.invalidReviews > 0 || all.excluded.duplicateReviews > 0) && <p className="analytics-warning">집계 제외: 현재 목록에 없는 평가 {all.excluded.orphanReviews}건 · 유효하지 않은 평가 {all.excluded.invalidReviews}건 · 동일 평가자 중복 {all.excluded.duplicateReviews}건. 원본 기록은 유지됩니다.</p>}

    {activeTab === 'distribution' && <>
      <SectionHeading title="저널·주제별 분포" meta={`고유 논문 ${number(analytics.summary.total)}편`} />
      <div className="distribution-columns">
        <Distribution title="저널" rows={analytics.journals} total={analytics.summary.total} />
        <Distribution title="논문 주제" rows={analytics.topics} total={analytics.summary.total} />
      </div>
      <p className="analytics-note">주제는 중복 분류입니다. 비율의 분모는 현재 범위의 고유 논문 수이며, 주제별 합계는 전체 편수·100%를 넘을 수 있습니다.</p>
    </>}

    {activeTab === 'topics' && <>
      <SectionHeading title="주제별 평가 현황" meta={`${number(analytics.summary.reviewCount)}건의 개인별 평가`} />
      <div className="analytics-totals">
        <div><span>범위 논문</span><strong>{number(analytics.summary.total)}<small>편</small></strong></div>
        <div><span>평가된 논문</span><strong>{number(analytics.summary.reviewed)}<small>편</small></strong></div>
        <div><span>미평가</span><strong>{number(analytics.summary.pending)}<small>편</small></strong></div>
        <div><span>평가자</span><strong>{number(analytics.summary.reviewerCount)}<small>명</small></strong></div>
      </div>
      <p className="analytics-note">진행률 = 평가가 1건 이상 있는 논문 ÷ 해당 주제 논문. 현재 논문 분류 기준이며 담당자 배정 대비 완료율은 아닙니다. 점수 1~5는 개인별 원점수 건수입니다.</p>
      <Table label="주제별 진행률"><thead><tr><th>논문 주제</th><th>전체</th><th>평가 / 미평가</th><th>진행률</th><th>원점수 / 평가자</th><th>점수 1 · 2 · 3 · 4 · 5</th></tr></thead><tbody>{analytics.topics.map((row) => <tr key={row.name}><th scope="row">{row.name}</th><td>{number(row.total)}</td><td>{number(row.reviewed)} / {number(row.pending)}</td><td><Coverage value={row.progress} /></td><td>{number(row.reviewCount)} / {number(row.reviewerCount)}</td><td><ScoreCounts counts={row.scoreCounts} /></td></tr>)}</tbody></Table>
      <SectionHeading title="작업 주제 경유 진행률" meta={`평가 경로 미기록 ${analytics.reviews.filter((row) => !row.review_topic).length}건`} />
      <Table label="작업 주제 경유 진행률"><thead><tr><th>작업 주제</th><th>경유 평가 / 주제 논문</th><th>진행률</th></tr></thead><tbody>{analytics.originTopics.map((row) => <tr key={row.name}><th scope="row">{row.name}</th><td>{number(row.reviewed)} / {number(row.total)}</td><td><Coverage value={row.progress} /></td></tr>)}</tbody></Table>
      <SectionHeading title="평가자별 집계" meta={filterLabel} />
      <Table label="평가자별 집계"><thead><tr><th>평가자</th><th>평가 논문</th><th>범위 대비 비율</th><th>점수 1 · 2 · 3 · 4 · 5</th></tr></thead><tbody>{analytics.reviewerStats.map((row) => <tr key={row.userId}><th scope="row">{nameOf(profileById.get(row.userId), row.userId)}</th><td>{number(row.reviewed)} / {number(row.total)}</td><td><Coverage value={row.progress} /></td><td><ScoreCounts counts={row.scoreCounts} /></td></tr>)}</tbody></Table>
      {!analytics.reviewerStats.length && <Empty text="이 범위에 저장된 평가가 없습니다." />}
      <SectionHeading title="개인별 원점수·리뷰 노트" meta="연구실 전체 관련성 · 최초 평가 경로" />
      <Paged key={`raw-${filterKey}`} rows={exportRows} label="평가 기록">{(rows) => <div className="analytics-raw-list">{rows.map((row) => <article key={`${row.reviewer_id}-${row.paper_id}`} className="analytics-raw-row"><div><b>{row.score}점</b><strong>{row.reviewer_name || row.reviewer_email || row.reviewer_id}</strong><time>{timestamp(row.updated_at)}</time></div><h4><PaperLink paper={{ ...row, id: row.paper_id }} /></h4><small>{Array.isArray(row.paper_topics) ? row.paper_topics.join(' · ') : row.paper_topics}</small><small>최초 평가 경로 · {originLabel(row.review_topic)}</small><p>{row.note || '노트 없음'}</p></article>)}</div>}</Paged>
    </>}

    {activeTab === 'disagreements' && <>
      <SectionHeading title="평가 불일치 확인 후보" meta={`${number(disagreements.length)}편 / 복수 평가 ${number(comparison.summary.multiReviewed)}편`} />
      <p className="analytics-note">동일 논문을 평가한 서로 다른 평가자의 점수 차이가 2점 이상인 확인 후보입니다. 모든 점수는 연구실 전체 관련성이며, 평가 경로는 작업 분담 정보입니다. 평가자 필터와 무관하게 전체 평가자를 비교합니다.</p>
      <label className="analytics-checkbox"><input type="checkbox" checked={onlySevere} onChange={(event) => setOnlySevere(event.target.checked)} />1~2점과 4~5점이 공존하는 후보만</label>
      <Paged key={`disagreement-${filterKey}`} rows={disagreements} label="불일치 후보">{(rows) => <div>{rows.map((item) => <article key={item.paper.id} className="disagreement-row"><div className="disagreement-title"><h4><PaperLink paper={item.paper} /></h4><strong className={item.severe ? 'severe' : ''}>{item.min}~{item.max}점 · 차이 {item.spread}{item.severe ? ' · 우선 확인' : ''}</strong></div><small>{topicNames(item.paper).join(' · ')}</small><Table label={`${item.paper.title} 평가 비교`}><thead><tr><th>평가자</th><th>최초 평가 경로</th><th>원점수</th><th>리뷰 노트</th><th>평가 시각</th></tr></thead><tbody>{item.reviews.map((row) => <tr key={row.user_id}><th scope="row">{nameOf(profileById.get(row.user_id), row.user_id)}</th><td>{originLabel(row.review_topic)}</td><td>{row.score}</td><td className="note-cell">{row.note || '노트 없음'}</td><td>{timestamp(row.updated_at)}</td></tr>)}</tbody></Table></article>)}</div>}</Paged>
    </>}

    {activeTab === 'quality' && <>
      <SectionHeading title="분류 품질 점검 보고서" meta={`현재 범위 ${number(audit.total)}편 · 제목·영문 초록 기준`} />
      <p className="analytics-note">아래 수치는 규칙 기반 확인 후보이며 오분류율이 아닙니다. 분류와 논문은 자동 수정·삭제하지 않았습니다. 평가 경로는 정답 주제가 아니며, 평가 불일치를 분류 오류의 정답으로 사용하지 않습니다.</p>
      <div className="analytics-totals">
        <div><span>다중 주제 논문</span><strong>{number(audit.multiTopicCount)}<small>편</small></strong></div>
        <div><span>주제 배정 합계</span><strong>{number(audit.topicAssignments)}<small>건</small></strong></div>
        <div><span>규칙 점수 상한 99</span><strong>{number(audit.scoreSaturationCount)}<small>편</small></strong></div>
      </div>
      <Table label="분류 품질 점검 항목"><thead><tr><th>점검 항목</th><th>후보</th><th>기준</th></tr></thead><tbody>{audit.issues.map((item) => <tr key={item.id} className={issue?.id === item.id ? 'selected-audit' : ''}><th scope="row"><button className="analytics-text-button" type="button" onClick={() => setIssueId(item.id)}>{item.label}</button></th><td>{number(item.papers.length)}</td><td className="audit-rule">{item.description}</td></tr>)}</tbody></Table>
      {issue && <>
        <SectionHeading title={issue.label} meta={`${number(issue.papers.length)}편`} />
        <details className="audit-rule-details"><summary>용어 판정 기준</summary><p>{issue.ruleDetails}</p></details>
        <div className="analytics-actions"><button type="button" disabled={!issue.papers.length} onClick={() => { download(`lmi-quality-${issue.id}-${filenameDate}.csv`, toCsv(issue.papers.map((paper) => ({ paper_id: paper.id, doi: paper.doi, title: paper.title, journal: paper.journal, topics: topicNames(paper), flag: issue.id, rule: issue.description, url: safeUrl(paper) }))), 'text/csv;charset=utf-8'); setNotice('분류 점검 후보 목록을 내보냈습니다.'); }}><Download size={15} />후보 목록 CSV</button></div>
        <Paged key={`quality-${topic}-${journal}-${issue.id}`} rows={issue.papers} label="분류 점검 후보">{(rows) => <div className="quality-candidates">{rows.map((paper, index) => <article key={`${paper.id}-${index}`}><h4><PaperLink paper={paper} /></h4><small>{paper.journal} · {paper.doi || 'DOI 없음'}</small><p>{topicNames(paper).join(' · ')}</p><details><summary>영문 초록</summary><p lang="en">{paper.abstract || '초록 없음'}</p></details></article>)}</div>}</Paged>
      </>}
    </>}
  </div>;
}

function SectionHeading({ title, meta }) { return <div className="analytics-heading"><h3>{title}</h3>{meta && <span>{meta}</span>}</div>; }
function Table({ children, label }) { return <div className="analytics-table-scroll" role="region" aria-label={label} tabIndex={0}><table className="analytics-table">{children}</table></div>; }
function Empty({ text = '조건에 맞는 기록이 없습니다.' }) { return <p className="analytics-empty">{text}</p>; }
function Coverage({ value }) { return <div className="analytics-coverage"><progress value={value} max={100} aria-label={`진행률 ${percent(value)}`} /><span>{percent(value)}</span></div>; }
function ScoreCounts({ counts }) { return <div className="score-counts">{counts.map((count, index) => <span key={index} title={`${index + 1}점: ${count}건`} aria-label={`${index + 1}점 ${count}건`}>{number(count)}</span>)}</div>; }
function PaperLink({ paper }) { const url = safeUrl(paper); return url ? <a href={url} target="_blank" rel="noreferrer">{paper.title}<ExternalLink size={13} aria-label="원문 링크" /></a> : <span>{paper.title || paper.id}</span>; }
function Distribution({ title, rows, total }) { return <section className="distribution-section"><h4>{title}</h4>{!rows.length && <Empty />}{[...rows].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).map((row) => <div key={row.name} className="distribution-row"><span>{row.name}</span><strong>{number(row.total)}<small>{percent(total ? row.total / total * 100 : 0)}</small></strong><meter min={0} max={total || 1} value={row.total} aria-label={`${row.name} ${row.total}편`} /></div>)}</section>; }
function Paged({ rows, children, label }) {
  const [page, setPage] = useState(0);
  const count = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, count - 1);
  if (!rows.length) return <Empty />;
  return <>{children(rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE))}<nav className="analytics-pagination" aria-label={`${label} 페이지`}><span>{number(rows.length)}건 · {current + 1} / {count}</span><button className="icon-button" type="button" disabled={current === 0} aria-label={`${label} 이전 페이지`} title="이전 페이지" onClick={() => setPage(current - 1)}><ArrowLeft size={16} /></button><button className="icon-button" type="button" disabled={current + 1 >= count} aria-label={`${label} 다음 페이지`} title="다음 페이지" onClick={() => setPage(current + 1)}><ArrowRight size={16} /></button></nav></>;
}
