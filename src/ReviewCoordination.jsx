import { useEffect, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { GENERAL_TOPIC, originLabel } from './reviewCoordination.js';

export function CompletionStatus({ status, topic }) {
  if (!status) return <div className="completion-status">다른 멤버 평가 없음</div>;
  const other = status.otherTopics;
  if (!other.length && !status.otherUnattributed) return <div className="completion-status">다른 멤버 평가 없음</div>;
  return <div className="completion-status" aria-label="다른 멤버 평가 현황">
    {topic && <span className={other.includes(topic) ? 'completed' : ''}>{originLabel(topic)} 경유 · {other.includes(topic) ? '다른 멤버 평가 있음' : '다른 멤버 평가 없음'}</span>}
    {other.filter((value) => value !== topic).map((value) => <span key={value}>{originLabel(value)} 경유 · 평가 있음</span>)}
    {status.otherUnattributed && <span>평가 경로 미기록 · 다른 멤버 평가 있음</span>}
  </div>;
}

export function ReviewStartDialog({ topics, onStart, onClose }) {
  const [topic, setTopic] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('select')?.focus();
    document.body.classList.add('modal-open');
    return () => { document.body.classList.remove('modal-open'); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="review-start-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="review-start-title" onKeyDown={(event) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const fields = [...ref.current.querySelectorAll('select, button:not(:disabled)')];
        if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
      }
    }}>
      <header><h2 id="review-start-title">이번 작업 주제</h2><button className="icon-button" aria-label="주제 선택 닫기" onClick={onClose}><X size={18} /></button></header>
      <label>평가 경로<select aria-label="검토 시작 주제" value={topic} onChange={(event) => setTopic(event.target.value)}>
        <option value="" disabled>주제 선택</option>
        {topics.map((value) => <option key={value} value={value}>{value}</option>)}
        <option value={GENERAL_TOPIC}>전체 목록</option>
      </select></label>
      <button className="primary-button" disabled={!topic} onClick={() => onStart(topic)}>검토 시작<ArrowRight size={16} /></button>
    </section>
  </div>;
}
