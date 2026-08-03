import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownUp,
  BookOpen,
  Bookmark,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Filter,
  FlaskConical,
  Moon,
  Search,
  Sparkles,
  Star,
  Sun,
  X,
} from 'lucide-react';
import './styles.css';

const REVIEW_LABELS = {
  1: '제외',
  2: '보관',
  3: '검토',
  4: '우선 검토',
  5: '필독',
};

const TABS = [
  { id: 'all', label: '전체' },
  { id: 'must', label: '필독 후보' },
  { id: 'review', label: '검토 후보' },
  { id: 'new', label: '이번 주 신규' },
  { id: 'unlabeled', label: '평가 대기' },
];

const STORAGE_KEY = 'lmi-paper-reviews-v1';

function getStoredReviews() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function isWithinDays(date, days) {
  const elapsed = Date.now() - new Date(date).getTime();
  return elapsed >= 0 && elapsed <= days * 24 * 60 * 60 * 1000;
}

function formatDate(date, withYear = true) {
  return new Intl.DateTimeFormat('ko-KR', {
    year: withYear ? 'numeric' : undefined,
    month: 'short',
    day: 'numeric',
  }).format(new Date(date));
}

function scoreTone(score) {
  if (score >= 5) return 'must';
  if (score >= 3) return 'review';
  if (score) return 'archive';
  return 'none';
}

function IconButton({ label, children, ...props }) {
  return (
    <button className="icon-button" type="button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

function App() {
  const [dataset, setDataset] = useState({ generatedAt: null, isDemo: false, papers: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [selectedJournals, setSelectedJournals] = useState([]);
  const [selectedTopics, setSelectedTopics] = useState([]);
  const [minimumAiScore, setMinimumAiScore] = useState(0);
  const [sort, setSort] = useState('added');
  const [reviews, setReviews] = useState(getStoredReviews);
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('lmi-theme') || 'light');

  useEffect(() => {
    fetch('./data/papers.json')
      .then((response) => {
        if (!response.ok) throw new Error('Data request failed');
        return response.json();
      })
      .then(setDataset)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('lmi-theme', theme);
  }, [theme]);

  const papers = useMemo(
    () => dataset.papers.map((paper) => ({
      ...paper,
      reviewScore: reviews[paper.id]?.score ?? paper.seedReviewScore ?? null,
      reviewNote: reviews[paper.id]?.note ?? '',
    })),
    [dataset.papers, reviews],
  );

  const journals = useMemo(() => [...new Set(papers.map((paper) => paper.journalShort))].sort(), [papers]);
  const topics = useMemo(() => [...new Set(papers.flatMap((paper) => paper.topics))].sort(), [papers]);

  const filteredPapers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const result = papers.filter((paper) => {
      const haystack = [paper.title, paper.journal, paper.authors.join(' '), paper.topics.join(' ')].join(' ').toLowerCase();
      const matchesQuery = !normalizedQuery || haystack.includes(normalizedQuery);
      const matchesJournal = !selectedJournals.length || selectedJournals.includes(paper.journalShort);
      const matchesTopic = !selectedTopics.length || selectedTopics.some((topic) => paper.topics.includes(topic));
      const matchesAi = paper.aiScore >= minimumAiScore;
      const matchesTab = activeTab === 'all'
        || (activeTab === 'must' && paper.reviewScore === 5)
        || (activeTab === 'review' && [3, 4].includes(paper.reviewScore))
        || (activeTab === 'new' && isWithinDays(paper.addedAt, 7))
        || (activeTab === 'unlabeled' && paper.reviewScore == null);
      return matchesQuery && matchesJournal && matchesTopic && matchesAi && matchesTab;
    });

    return result.sort((a, b) => {
      if (sort === 'published') return new Date(b.publishedAt) - new Date(a.publishedAt);
      if (sort === 'ai') return b.aiScore - a.aiScore;
      if (sort === 'score') return (b.reviewScore || 0) - (a.reviewScore || 0);
      return new Date(b.addedAt) - new Date(a.addedAt);
    });
  }, [papers, query, selectedJournals, selectedTopics, minimumAiScore, activeTab, sort]);

  const stats = useMemo(() => {
    const labeled = papers.filter((paper) => paper.reviewScore != null).length;
    return {
      total: papers.length,
      weekly: papers.filter((paper) => isWithinDays(paper.addedAt, 7)).length,
      must: papers.filter((paper) => paper.reviewScore === 5).length,
      review: papers.filter((paper) => [3, 4].includes(paper.reviewScore)).length,
      progress: papers.length ? Math.round((labeled / papers.length) * 100) : 0,
      labeled,
    };
  }, [papers]);

  const activeFilterCount = selectedJournals.length + selectedTopics.length + (minimumAiScore ? 1 : 0);

  function toggleItem(value, setter) {
    setter((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function resetFilters() {
    setSelectedJournals([]);
    setSelectedTopics([]);
    setMinimumAiScore(0);
  }

  function saveReview(paperId, score, note) {
    const next = { ...reviews, [paperId]: { score, note, updatedAt: new Date().toISOString() } };
    setReviews(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSelectedPaper((current) => current ? { ...current, reviewScore: score, reviewNote: note } : current);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="LMI Paper Agent 홈">
          <span className="brand-mark"><FlaskConical size={20} aria-hidden="true" /></span>
          <span><strong>LMI Paper Agent</strong><small>Metabolism & Immunology</small></span>
        </a>
        <nav className="desktop-nav" aria-label="주요 메뉴">
          <a className="active" href="#overview">대시보드</a>
          <a href="#papers">논문</a>
          <button type="button" onClick={() => { setActiveTab('new'); document.getElementById('papers')?.scrollIntoView(); }}>주간 업데이트</button>
        </nav>
        <div className="topbar-actions">
          <span className="sync-label"><Activity size={15} aria-hidden="true" /> {dataset.generatedAt ? `${formatDate(dataset.generatedAt)} 동기화` : '동기화 확인 중'}</span>
          <IconButton label={theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </IconButton>
        </div>
      </header>

      <main id="top">
        <section className="archive-banner" id="overview" aria-labelledby="archive-title">
          <div className="banner-copy">
            <span className="eyebrow">WEEKLY RESEARCH INTELLIGENCE</span>
            <h1 id="archive-title">이번 주 연구 흐름을<br />한눈에 검토하세요.</h1>
            <p>지정 저널에서 수집한 논문을 연구 관련도와 연구실 평가로 선별합니다.</p>
          </div>
          {dataset.isDemo && <span className="demo-badge">화면 검수용 샘플 데이터</span>}
        </section>

        <section className="stats-grid" aria-label="논문 통계">
          <StatCard icon={BookOpen} label="전체 논문" value={stats.total} meta="수집된 논문" />
          <StatCard icon={Star} label="필독 후보" value={stats.must} meta="평가 5점" accent="gold" />
          <StatCard icon={Sparkles} label="검토 후보" value={stats.review} meta="평가 3–4점" accent="teal" />
          <StatCard icon={CalendarDays} label="이번 주 신규" value={stats.weekly} meta="최근 7일" accent="coral" />
          <StatCard icon={Check} label="라벨링 진행률" value={`${stats.progress}%`} meta={`${stats.labeled} / ${stats.total}편`} progress={stats.progress} />
        </section>

        <section className="workspace" id="papers">
          <div className="section-heading">
            <div>
              <span className="eyebrow">PAPER LIBRARY</span>
              <h2>논문 검토함</h2>
            </div>
            <button className="filter-trigger" type="button" onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)} aria-expanded={mobileFiltersOpen}>
              <Filter size={17} aria-hidden="true" /> 필터 {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
            </button>
          </div>

          <div className="search-row">
            <div className="search-box">
              <Search size={19} aria-hidden="true" />
              <label className="sr-only" htmlFor="paper-search">논문 검색</label>
              <input id="paper-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목, 저자, 키워드, 저널 검색" />
              {query && <button type="button" onClick={() => setQuery('')} aria-label="검색어 지우기"><X size={16} /></button>}
            </div>
            <label className="sort-control">
              <ArrowDownUp size={17} aria-hidden="true" />
              <span className="sr-only">정렬</span>
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="added">최근 수집순</option>
                <option value="published">최신 발행순</option>
                <option value="ai">AI 관련도순</option>
                <option value="score">연구실 평가순</option>
              </select>
              <ChevronDown size={15} aria-hidden="true" />
            </label>
          </div>

          <div className="review-tabs" role="tablist" aria-label="논문 분류">
            {TABS.map((tab) => (
              <button key={tab.id} role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}>
                {tab.label}
                <span>{tabCount(tab.id, papers)}</span>
              </button>
            ))}
          </div>

          <div className="library-layout">
            <FilterPanel
              className={mobileFiltersOpen ? 'open' : ''}
              journals={journals}
              topics={topics}
              selectedJournals={selectedJournals}
              selectedTopics={selectedTopics}
              minimumAiScore={minimumAiScore}
              onJournal={(value) => toggleItem(value, setSelectedJournals)}
              onTopic={(value) => toggleItem(value, setSelectedTopics)}
              onMinimumAiScore={setMinimumAiScore}
              onReset={resetFilters}
              onClose={() => setMobileFiltersOpen(false)}
            />

            <div className="paper-results">
              <div className="results-meta">
                <span><strong>{filteredPapers.length}</strong>편 표시 중</span>
                {activeFilterCount > 0 && <button type="button" onClick={resetFilters}>필터 초기화</button>}
              </div>

              {loading && <LoadingRows />}
              {loadError && <EmptyState icon={CircleAlert} title="논문 데이터를 불러오지 못했습니다" detail="data/papers.json 파일을 확인해 주세요." />}
              {!loading && !loadError && filteredPapers.length === 0 && <EmptyState icon={Search} title="조건에 맞는 논문이 없습니다" detail="검색어 또는 필터를 변경해 보세요." />}
              {!loading && !loadError && filteredPapers.map((paper) => (
                <PaperRow key={paper.id} paper={paper} onOpen={() => setSelectedPaper(paper)} />
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer>
        <span>LMI Paper Agent</span>
        <span>GitHub Pages · 데이터 갱신 {dataset.generatedAt ? formatDate(dataset.generatedAt) : '확인 중'}</span>
      </footer>

      {selectedPaper && <ReviewDrawer paper={selectedPaper} onClose={() => setSelectedPaper(null)} onSave={saveReview} />}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, meta, accent = 'navy', progress }) {
  return (
    <article className={`stat-card ${accent}`}>
      <span className="stat-icon"><Icon size={18} aria-hidden="true" /></span>
      <div><span>{label}</span><strong>{value}</strong><small>{meta}</small></div>
      {progress != null && <span className="progress-track" aria-label={`라벨링 ${progress}%`}><span style={{ width: `${progress}%` }} /></span>}
    </article>
  );
}

function FilterPanel({ className, journals, topics, selectedJournals, selectedTopics, minimumAiScore, onJournal, onTopic, onMinimumAiScore, onReset, onClose }) {
  return (
    <aside className={`filter-panel ${className}`} aria-label="논문 필터">
      <div className="filter-header"><strong><Filter size={17} aria-hidden="true" /> 필터</strong><button type="button" onClick={onClose} aria-label="필터 닫기"><X size={18} /></button></div>
      <FilterGroup title="저널">
        {journals.map((journal) => <CheckOption key={journal} label={journal} checked={selectedJournals.includes(journal)} onChange={() => onJournal(journal)} />)}
      </FilterGroup>
      <FilterGroup title="연구 주제">
        {topics.map((topic) => <CheckOption key={topic} label={topic} checked={selectedTopics.includes(topic)} onChange={() => onTopic(topic)} />)}
      </FilterGroup>
      <FilterGroup title="AI 관련도">
        <div className="range-label"><span>최소 점수</span><strong>{minimumAiScore || '전체'}</strong></div>
        <input className="range" type="range" min="0" max="100" step="5" value={minimumAiScore} onChange={(event) => onMinimumAiScore(Number(event.target.value))} aria-label="최소 AI 관련도" />
      </FilterGroup>
      <button className="reset-button" type="button" onClick={onReset}>전체 필터 초기화</button>
    </aside>
  );
}

function FilterGroup({ title, children }) {
  return <section className="filter-group"><h3>{title}</h3><div>{children}</div></section>;
}

function CheckOption({ label, checked, onChange }) {
  return <label className="check-option"><input type="checkbox" checked={checked} onChange={onChange} /><span><Check size={13} /></span>{label}</label>;
}

function PaperRow({ paper, onOpen }) {
  return (
    <article className="paper-row">
      <button className="paper-main" type="button" onClick={onOpen} aria-label={`${paper.title} 검토 열기`}>
        <div className="paper-topline">
          <span className="journal-chip">{paper.journalShort}</span>
          <span>{formatDate(paper.publishedAt)}</span>
          {isWithinDays(paper.addedAt, 7) && <span className="new-chip">NEW</span>}
          {paper.recommendedBy && <span className="expert-chip"><Star size={12} /> {paper.recommendedBy.role} 추천</span>}
        </div>
        <h3>{paper.title}</h3>
        <p className="authors">{paper.authors.join(', ')}</p>
        <p className="abstract">{paper.abstract}</p>
        <div className="topic-list">{paper.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>
      </button>
      <div className="paper-metrics">
        <div className="metric ai"><span>AI 관련도</span><strong>{paper.aiScore}</strong><small>/ 100</small></div>
        <div className={`metric human ${scoreTone(paper.reviewScore)}`}>
          <span>연구실 평가</span>
          <strong>{paper.reviewScore ?? '–'}</strong>
          <small>{paper.reviewScore ? REVIEW_LABELS[paper.reviewScore] : '평가 대기'}</small>
        </div>
        <button className="review-button" type="button" onClick={onOpen}><FileText size={15} /> 검토</button>
      </div>
    </article>
  );
}

function ReviewDrawer({ paper, onClose, onSave }) {
  const [score, setScore] = useState(paper.reviewScore);
  const [note, setNote] = useState(paper.reviewNote || '');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('modal-open');
    };
  }, [onClose]);

  function handleSave() {
    if (!score) return;
    onSave(paper.id, score, note.trim());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="review-drawer" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <header className="drawer-header">
          <div><span className="eyebrow">PAPER REVIEW</span><h2 id="review-title">논문 검토</h2></div>
          <IconButton label="검토창 닫기" onClick={onClose}><X size={20} /></IconButton>
        </header>

        <div className="drawer-body">
          <div className="drawer-paper">
            <span className="journal-chip">{paper.journalShort}</span>
            <h3>{paper.title}</h3>
            <p>{paper.authors.join(', ')}</p>
          </div>

          <section className="ai-assessment">
            <div className="ai-score"><Sparkles size={18} /><strong>{paper.aiScore}</strong><span>/ 100</span></div>
            <div><h4>AI 선별 근거</h4><p>{paper.aiReason}</p></div>
          </section>

          {paper.recommendedBy && (
            <section className="expert-recommendation">
              <Star size={18} />
              <div><h4>전문가 추천</h4><p>{paper.recommendedBy.name} · {paper.recommendedBy.role}</p></div>
            </section>
          )}

          <fieldset className="score-fieldset">
            <legend>연구 관련성 점수</legend>
            <p>1점은 제외, 5점은 필독입니다.</p>
            <div className="score-options">
              {[1, 2, 3, 4, 5].map((value) => (
                <label key={value} className={score === value ? 'selected' : ''}>
                  <input type="radio" name="review-score" value={value} checked={score === value} onChange={() => setScore(value)} />
                  <strong>{value}</strong><span>{REVIEW_LABELS[value]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="note-field">
            <label htmlFor="review-note">리뷰 노트</label>
            <textarea id="review-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength="800" placeholder="연구실에서 다시 볼 포인트, 실험 아이디어, 제외 근거를 기록하세요." />
            <small>{note.length} / 800</small>
          </div>

          <section className="paper-details">
            <h4>기본 정보</h4>
            <dl>
              <div><dt>저널</dt><dd>{paper.journal}</dd></div>
              <div><dt>발행일</dt><dd>{formatDate(paper.publishedAt)}</dd></div>
              <div><dt>서지 정보</dt><dd>Vol. {paper.volume}, Iss. {paper.issue}, {paper.pages}</dd></div>
              <div><dt>주제</dt><dd>{paper.topics.join(', ')}</dd></div>
            </dl>
          </section>
        </div>

        <footer className="drawer-footer">
          <span className={saved ? 'save-status visible' : 'save-status'}><Check size={15} /> 저장되었습니다</span>
          <button className="secondary-button" type="button" onClick={onClose}>닫기</button>
          <button className="primary-button" type="button" disabled={!score} onClick={handleSave}><Bookmark size={16} /> 평가 저장</button>
        </footer>
      </section>
    </div>
  );
}

function EmptyState({ icon: Icon, title, detail }) {
  return <div className="empty-state"><Icon size={26} /><strong>{title}</strong><p>{detail}</p></div>;
}

function LoadingRows() {
  return <div aria-label="논문 불러오는 중">{[1, 2, 3].map((item) => <div className="loading-row" key={item}><span /><span /><span /></div>)}</div>;
}

function tabCount(id, papers) {
  if (id === 'must') return papers.filter((paper) => paper.reviewScore === 5).length;
  if (id === 'review') return papers.filter((paper) => [3, 4].includes(paper.reviewScore)).length;
  if (id === 'new') return papers.filter((paper) => isWithinDays(paper.addedAt, 7)).length;
  if (id === 'unlabeled') return papers.filter((paper) => paper.reviewScore == null).length;
  return papers.length;
}

const rootElement = document.getElementById('root');
const appRoot = globalThis.__lmiPaperAgentRoot ?? createRoot(rootElement);
globalThis.__lmiPaperAgentRoot = appRoot;
appRoot.render(<React.StrictMode><App /></React.StrictMode>);
