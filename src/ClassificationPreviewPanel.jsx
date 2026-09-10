import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, ExternalLink, LoaderCircle, Search, ShieldCheck } from 'lucide-react';
import { makePreviewSnapshot, previewExportRows, previewSummary } from './previewSnapshot.js';
import { toCsv } from './adminAnalytics.js';

const PAGE_SIZE = 20;
const count = (value) => value.toLocaleString('ko-KR');
const compare = (a, b) => a.localeCompare(b);
const TOPIC_EMPTY = '__unclassified__';

function download(name, body, type) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ClassificationPreviewPanel({ papers }) {
  const [result, setResult] = useState(null);
  const snapshot = result?.source === papers ? result.snapshot : null;
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [oldTopic, setOldTopic] = useState('');
  const [newTopic, setNewTopic] = useState('');
  const [journal, setJournal] = useState('');
  const [scope, setScope] = useState('changed');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState('');
  const list = useRef(null);

  useEffect(() => {
    let active = true;
    setResult(null);
    setError('');
    const timer = window.setTimeout(() => {
      makePreviewSnapshot(papers).then((snapshot) => { if (active) setResult({ source: papers, snapshot }); })
        .catch((failure) => { if (active) setError(failure.message || '미리보기 계산에 실패했습니다.'); });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [papers, retry]);

  const paperById = useMemo(() => new Map(papers.map((paper) => [paper.id, paper])), [papers]);
  const oldTopics = useMemo(() => [...new Set(papers.flatMap((paper) => paper.topics || []))].sort(compare), [papers]);
  const journals = useMemo(() => [...new Set(papers.map((paper) => paper.journal || paper.journalShort || ''))].filter(Boolean).sort(compare), [papers]);
  const text = query.trim().toLowerCase();
  const filtered = useMemo(() => (snapshot?.records || []).filter((row) => (
    (!oldTopic || (oldTopic === TOPIC_EMPTY ? !row.oldTopics.length : row.oldTopics.includes(oldTopic)))
    && (!newTopic || (newTopic === TOPIC_EMPTY ? !row.coreTopics.length : row.coreTopics.includes(newTopic)))
    && (!journal || row.journal === journal)
    && (!text || `${row.title} ${row.doi}`.toLowerCase().includes(text))
    && (scope === 'all' || (scope === 'changed' && row.changed) || (scope === 'needs-review' && row.needsReview)
      || (scope === 'added' && row.addedTopics.length) || (scope === 'removed' && row.removedTopics.length))
  )), [snapshot, oldTopic, newTopic, journal, text, scope]);
  const summary = useMemo(() => previewSummary(filtered), [filtered]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => { setPage(0); setNotice(''); }, [oldTopic, newTopic, journal, scope, text]);

  function navigate(next) {
    setPage(next);
    list.current?.scrollIntoView({ block: 'start' });
  }

  function exportPreview(format) {
    const date = new Date().toISOString().slice(0, 10);
    const body = format === 'csv' ? toCsv(previewExportRows(snapshot, filtered)) : JSON.stringify({
      ...snapshot, exportedAt: new Date().toISOString(), filters: { oldTopic, newCoreTopic: newTopic, journal, scope, query },
      summary, fullSnapshotSummary: snapshot.summary, records: filtered,
    }, null, 2);
    download(`lmi-classification-preview-${date}.${format}`, body, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8');
    setNotice(`${count(filtered.length)}편의 미적용 분류 초안을 내려받았습니다.`);
  }

  return <section className="classification-preview" aria-label="새 분류 미리보기">
    <div className="preview-safety"><ShieldCheck size={19} /><div><strong>실험용 분류 초안 · 운영 미적용</strong><p>멤버의 기존 주제 목록·평가 점수·리뷰 노트·진행률은 변경되지 않습니다.</p></div></div>
    {error ? <div className="admin-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry((value) => value + 1)}>재시도</button></div>
      : !snapshot ? <div className="admin-loading" role="status"><LoaderCircle size={24} /><span>별도 분류 초안을 계산하고 있습니다</span></div>
      : <div data-preview-ready="true">
        <div className="analytics-heading"><h3>기존 분류와 새 후보 비교</h3><span>{snapshot.version} · 전체 {count(snapshot.summary.total)}편</span></div>
        <p className="analytics-note">제목·영문 초록의 용어와 연구 서술 신호로 생성한 규칙 기반 후보입니다. 핵심·연관 구분은 확정 판정이 아니며, 모호한 문맥과 부정 표현은 사람의 재검토가 필요합니다.</p>
        <div className="analytics-totals" aria-label="전체 미리보기 현황">
          <div><span>기존 태그와 핵심 후보가 다름</span><strong>{count(snapshot.summary.changed)}<small>편</small></strong></div>
          <div><span>핵심 후보 없음</span><strong>{count(snapshot.summary.noCore)}<small>편</small></strong></div>
          <div><span>검토 필요</span><strong>{count(snapshot.summary.needsReview)}<small>편</small></strong></div>
        </div>
        <div className="analytics-filters preview-filters">
          <label>기존 할당 기준<select aria-label="미리보기 기존 주제" value={oldTopic} onChange={(event) => setOldTopic(event.target.value)}><option value="">전체 기존 주제</option>{oldTopics.map((topic) => <option key={topic}>{topic}</option>)}<option value={TOPIC_EMPTY}>기존 미분류</option></select></label>
          <label>새 핵심 후보<select aria-label="미리보기 새 핵심 후보" value={newTopic} onChange={(event) => setNewTopic(event.target.value)}><option value="">전체 핵심 후보</option>{snapshot.summary.topics.map((topic) => <option key={topic.label}>{topic.label}</option>)}<option value={TOPIC_EMPTY}>핵심 후보 없음</option></select></label>
          <label>비교 범위<select aria-label="미리보기 비교 범위" value={scope} onChange={(event) => setScope(event.target.value)}><option value="changed">기존과 다른 후보</option><option value="all">전체 논문</option><option value="needs-review">검토 필요</option><option value="added">핵심 후보 추가</option><option value="removed">기존 태그가 핵심 후보에서 빠짐</option></select></label>
          <label>저널<select aria-label="미리보기 저널" value={journal} onChange={(event) => setJournal(event.target.value)}><option value="">전체 저널</option>{journals.map((name) => <option key={name}>{name}</option>)}</select></label>
          <label className="preview-search">논문 검색<span><Search size={16} /><input aria-label="미리보기 논문 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목 또는 DOI" /></span></label>
        </div>
        <div className="analytics-actions"><span>현재 범위 {count(filtered.length)}편</span><button type="button" disabled={!filtered.length} onClick={() => exportPreview('csv')}><Download size={15} />비교 CSV</button><button type="button" disabled={!filtered.length} onClick={() => exportPreview('json')}><Download size={15} />근거 포함 JSON</button></div>
        {notice && <p role="status" className="analytics-notice">{notice}</p>}
        <details className="preview-distribution"><summary>현재 범위의 주제별 비교</summary><p className="analytics-note">기존 분류는 핵심·연관을 구분하지 않은 태그입니다. ‘핵심 후보에서 빠짐’은 이 초안에서의 차이이며 실제 삭제가 아닙니다. 주제 수는 중복 집계입니다.</p>
          <div className="analytics-table-scroll" role="region" aria-label="미리보기 주제별 비교" tabIndex={0}><table className="analytics-table"><thead><tr><th>주제</th><th>기존 태그</th><th>핵심 후보</th><th>연관 후보</th><th>핵심 추가</th><th>핵심에서 빠짐</th></tr></thead><tbody>{summary.topics.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{count(row.old)}</td><td>{count(row.core)}</td><td>{count(row.related)}</td><td>{count(row.added)}</td><td>{count(row.removedFromCore)}</td></tr>)}</tbody></table></div>
        </details>
        <div className="preview-list" ref={list}>
          {!filtered.length && <p className="analytics-empty">조건에 맞는 미리보기 논문이 없습니다.</p>}
          {filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((record) => <PreviewPaper key={record.paperId} record={record} paper={paperById.get(record.paperId)} />)}
        </div>
        <nav className="analytics-pagination" aria-label="미리보기 페이지"><span>{count(filtered.length)}편 · {currentPage + 1} / {pageCount}</span><button className="icon-button" type="button" title="이전 페이지" aria-label="미리보기 이전 페이지" disabled={!currentPage} onClick={() => navigate(currentPage - 1)}><ArrowLeft size={16} /></button><button className="icon-button" type="button" title="다음 페이지" aria-label="미리보기 다음 페이지" disabled={currentPage + 1 >= pageCount} onClick={() => navigate(currentPage + 1)}><ArrowRight size={16} /></button></nav>
        <details className="preview-provenance"><summary>초안 버전·입력 정보</summary><dl><dt>분류 버전</dt><dd>{snapshot.version}</dd><dt>생성 시각</dt><dd>{snapshot.generatedAt}</dd><dt>분류 입력 SHA-256</dt><dd>{snapshot.inputHash}</dd><dt>개인 평가 포함</dt><dd>없음</dd><dt>운영 적용</dt><dd>미적용</dd></dl></details>
      </div>}
  </section>;
}

function TopicList({ topics, empty, tone = '' }) {
  return topics.length ? <ul className={`preview-topics ${tone}`}>{topics.map((topic) => <li key={topic}>{topic}</li>)}</ul> : <p className="preview-empty">{empty}</p>;
}

function PreviewPaper({ record, paper }) {
  const doiUrl = record.doi ? `https://doi.org/${encodeURIComponent(record.doi).replace(/%2F/gi, '/')}` : null;
  return <article className="preview-paper">
    <div className="preview-paper-meta"><span>{record.journal} · {record.publishedAt}</span><strong>{record.needsReview ? '검토 필요' : '규칙상 명시 근거 · 미확정'}</strong></div>
    <h4>{doiUrl ? <a href={doiUrl} target="_blank" rel="noreferrer">{record.title}<ExternalLink size={13} aria-label="원문 링크" /></a> : record.title}</h4>
    <div className="preview-comparison"><section><h5>기존 분류 · 유지</h5><TopicList topics={record.oldTopics} empty="기존 미분류" /></section><section><h5>새 핵심 후보 · 미적용</h5><TopicList topics={record.coreTopics} empty="핵심 후보 없음" tone="core" /></section><section><h5>연관 주제 · 미적용</h5><TopicList topics={record.relatedTopics} empty="연관 후보 없음" tone="related" /></section></div>
    {!!record.methodTags?.length && <p className="preview-methods"><strong>방법 후보</strong> {record.methodTags.join(' · ')}</p>}
    <details className="preview-evidence"><summary>분류 근거·검토 사유 ({record.evidence.length})</summary>
      {!!record.reviewReasons.length && <ul className="preview-reasons">{record.reviewReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
      {record.evidence.map((item, index) => <div className="preview-evidence-item" key={index}><div><strong>{item.topic}</strong><span>{item.level === 'core' ? '핵심 후보' : '연관 후보'} · {item.field === 'title' ? '제목' : '영문 초록'}</span></div><blockquote lang="en">{item.quote}</blockquote><p>{item.reason}</p>{!!item.terms?.length && <small>연결 용어: {item.terms.join(', ')}</small>}</div>)}
      {!record.evidence.length && <p className="analytics-note">이 규칙으로 명시 근거를 확보하지 못했습니다. 무관한 논문으로 확정한 것은 아닙니다.</p>}
    </details>
    <details className="preview-abstract"><summary>영문·한국어 초록</summary><h5>English</h5><p lang="en">{paper?.abstract || '초록 없음'}</p><h5>한국어</h5><p lang="ko">{paper?.abstractKo || '한국어 초록 없음'}</p></details>
  </article>;
}
