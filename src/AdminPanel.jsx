import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  Check,
  CircleAlert,
  ClipboardList,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { supabase } from './supabase';
import { fetchAdminData } from './adminData';
import { AdminInsights } from './AdminInsights';

const ANALYTICS_TABS = [
  ['distribution', '저널·주제 분포'],
  ['topics', '주제별 평가'],
  ['disagreements', '평가 불일치 후보'],
  ['quality', '분류 품질 보고서'],
];

const STATUS_LABELS = {
  pending: '승인 대기',
  approved: '승인됨',
  blocked: '차단됨',
};

export function AdminPanel({ papers, isAdmin, onClose }) {
  const [profiles, setProfiles] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [activeTab, setActiveTab] = useState('topics');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [workingUserId, setWorkingUserId] = useState('');
  const [fetchedAt, setFetchedAt] = useState(null);
  const request = useRef(0);
  const panel = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;

  const paperById = useMemo(() => new Map(papers.map((paper) => [paper.id, paper])), [papers]);
  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);

  const loadData = useCallback(async () => {
    const current = ++request.current;
    if (!isAdmin) return;
    setLoading(true);
    setError('');
    setProfiles([]);
    setReviews([]);
    setFetchedAt(null);
    try {
      const result = await fetchAdminData(supabase);
      if (current !== request.current) return;
      setProfiles(result.profiles);
      setReviews(result.reviews);
      setFetchedAt(result.fetchedAt);
    } catch (failure) {
      if (current === request.current) setError(failure.message || '관리 데이터를 불러오지 못했습니다.');
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    loadData();
    return () => { request.current += 1; };
  }, [loadData]);

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    function onKeyDown(event) {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab') return;
      const focusable = [...(panel.current?.querySelectorAll('button:not(:disabled),input,select,a[href],[tabindex="0"]') || [])].filter((element) => element.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('modal-open');
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  async function setMemberStatus(userId, status) {
    setWorkingUserId(userId);
    setError('');
    try {
      const { error: updateError } = await supabase.rpc('admin_set_member_status', {
        target_user: userId,
        new_status: status,
      });
      if (updateError) throw updateError;
      setProfiles((current) => current.map((profile) => (
        profile.id === userId ? { ...profile, status } : profile
      )));
    } catch (failure) { setError(failure.message); }
    finally { setWorkingUserId(''); }
  }

  const pending = profiles.filter((profile) => profile.status === 'pending');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredReviews = reviews.filter((review) => {
    const profile = profileById.get(review.user_id);
    const paper = paperById.get(review.paper_id);
    return !normalizedQuery || [
      profile?.display_name,
      profile?.email,
      paper?.title,
      paper?.doi,
      review.note,
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
  });

  if (!isAdmin) return null;

  return (
    <div className="admin-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={panel} tabIndex={-1} className="admin-panel" role="dialog" aria-modal="true" aria-labelledby="admin-title">
        <header className="admin-header">
          <div><span className="eyebrow">ADMIN CONTROL</span><h2 id="admin-title">연구실 평가 관리</h2></div>
          <div className="admin-header-actions">
            <button className="icon-button" type="button" aria-label="새로고침" title="새로고침" disabled={loading || Boolean(workingUserId)} onClick={loadData}><RefreshCw size={18} /></button>
            <button className="icon-button" type="button" aria-label="관리 화면 닫기" title="관리 화면 닫기" onClick={onClose}><X size={20} /></button>
          </div>
        </header>

        <div className="admin-summary" aria-label="관리 현황">
          <div><Users size={18} /><span>승인 구성원</span><strong>{fetchedAt ? profiles.filter((profile) => profile.status === 'approved').length : '—'}</strong></div>
          <div><UserCheck size={18} /><span>승인 대기</span><strong>{fetchedAt ? pending.length : '—'}</strong></div>
          <div><ClipboardList size={18} /><span>전체 평가 기록</span><strong>{fetchedAt ? reviews.length.toLocaleString() : '—'}</strong></div>
        </div>

        <div className="admin-tabs" role="tablist" aria-label="관리 항목">
          {ANALYTICS_TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={activeTab === id} className={activeTab === id ? 'active' : ''} onClick={() => setActiveTab(id)}>{label}</button>)}
          <button type="button" role="tab" aria-selected={activeTab === 'pending'} className={activeTab === 'pending' ? 'active' : ''} onClick={() => setActiveTab('pending')}>승인 대기 <span>{pending.length}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === 'reviews'} className={activeTab === 'reviews' ? 'active' : ''} onClick={() => setActiveTab('reviews')}>개인별 평가 <span>{reviews.length}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === 'members'} className={activeTab === 'members' ? 'active' : ''} onClick={() => setActiveTab('members')}>구성원 <span>{profiles.length}</span></button>
        </div>

        <div className="admin-body">
          {error && <div className="admin-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
          {loading ? (
            <div className="admin-loading"><LoaderCircle size={24} /><span>관리 데이터를 불러오는 중입니다</span></div>
          ) : !fetchedAt ? (
            <AdminEmpty icon={CircleAlert} title="관리 데이터 조회가 완료되지 않았습니다" />
          ) : ANALYTICS_TABS.some(([id]) => activeTab === id) ? (
            <AdminInsights papers={papers} reviews={reviews} profiles={profiles} activeTab={activeTab} fetchedAt={fetchedAt} />
          ) : activeTab === 'pending' ? (
            <PendingMembers members={pending} workingUserId={workingUserId} onStatus={setMemberStatus} />
          ) : activeTab === 'reviews' ? (
            <>
              <label className="admin-search"><Search size={17} /><span className="sr-only">평가 검색</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="평가자, 논문, DOI, 노트 검색" /></label>
              <ReviewTable reviews={filteredReviews} profileById={profileById} paperById={paperById} />
            </>
          ) : (
            <MemberTable members={profiles} workingUserId={workingUserId} onStatus={setMemberStatus} />
          )}
        </div>
      </section>
    </div>
  );
}

function PendingMembers({ members, workingUserId, onStatus }) {
  if (!members.length) return <AdminEmpty icon={ShieldCheck} title="승인 대기 중인 사용자가 없습니다" />;
  return (
    <div className="member-list">
      {members.map((member) => (
        <article key={member.id} className="member-row">
          <UserIdentity member={member} />
          <time dateTime={member.created_at}>{formatDateTime(member.created_at)} 가입</time>
          <div className="member-actions">
            <button type="button" className="approve-button" disabled={workingUserId === member.id} onClick={() => onStatus(member.id, 'approved')}><Check size={15} /> 승인</button>
            <button type="button" className="block-button" disabled={workingUserId === member.id} onClick={() => onStatus(member.id, 'blocked')}><Ban size={15} /> 차단</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function MemberTable({ members, workingUserId, onStatus }) {
  return (
    <div className="member-list">
      {members.map((member) => (
        <article key={member.id} className="member-row">
          <UserIdentity member={member} />
          <span className={`member-status ${member.status}`}>{member.role === 'admin' ? '관리자' : STATUS_LABELS[member.status]}</span>
          {member.role !== 'admin' && (
            <div className="member-actions">
              {member.status !== 'approved' && <button type="button" className="approve-button" disabled={workingUserId === member.id} onClick={() => onStatus(member.id, 'approved')}><Check size={15} /> 승인</button>}
              {member.status !== 'blocked' && <button type="button" className="block-button" disabled={workingUserId === member.id} onClick={() => onStatus(member.id, 'blocked')}><Ban size={15} /> 차단</button>}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function ReviewTable({ reviews, profileById, paperById }) {
  if (!reviews.length) return <AdminEmpty icon={ClipboardList} title="조건에 맞는 평가가 없습니다" />;
  return (
    <div className="admin-review-list">
      {reviews.map((review) => {
        const profile = profileById.get(review.user_id);
        const paper = paperById.get(review.paper_id);
        return (
          <article key={`${review.user_id}-${review.paper_id}`} className="admin-review-row">
            <div className="admin-review-score"><strong>{review.score}</strong><span>/ 5</span></div>
            <div className="admin-review-copy">
              <div><strong>{profile?.display_name || profile?.email || '알 수 없는 사용자'}</strong><span>{profile?.email}</span><time dateTime={review.updated_at}>{formatDateTime(review.updated_at)}</time></div>
              <h3>{paper?.title || review.paper_id}</h3>
              {review.note ? <p>{review.note}</p> : <p className="empty-note">작성된 리뷰 노트가 없습니다.</p>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function UserIdentity({ member }) {
  return (
    <div className="user-identity">
      {member.avatar_url ? <img src={member.avatar_url} alt="" referrerPolicy="no-referrer" /> : <span>{(member.display_name || member.email || '?')[0].toUpperCase()}</span>}
      <div><strong>{member.display_name || '이름 미등록'}</strong><small>{member.email}</small></div>
    </div>
  );
}

function AdminEmpty({ icon: Icon, title }) {
  return <div className="admin-empty"><Icon size={27} /><strong>{title}</strong></div>;
}

function formatDateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '시각 미기록';
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
