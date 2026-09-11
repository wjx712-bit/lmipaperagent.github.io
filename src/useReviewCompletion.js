import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCompletion } from './reviewCoordination.js';

export function useReviewCompletion(client, auth, papers) {
  const owner = auth.isApproved ? auth.user?.id : null;
  const [state, setState] = useState({ owner: null, rows: new Map(), error: false, loading: false });
  const request = useRef(0);
  const activeOwner = useRef(owner);
  activeOwner.current = owner;
  const refresh = useCallback(async () => {
    if (!client || !owner) return;
    const id = ++request.current;
    setState((old) => ({ ...old, loading: true }));
    try {
      const rows = await fetchCompletion(client, papers);
      if (id === request.current && activeOwner.current === owner) setState({ owner, rows, error: false, loading: false });
    } catch {
      if (id === request.current && activeOwner.current === owner) setState({ owner, rows: new Map(), error: true, loading: false });
    }
  }, [client, owner, papers]);
  useEffect(() => {
    refresh();
    const foregroundRefresh = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', foregroundRefresh);
    const timer = window.setInterval(foregroundRefresh, 60000);
    return () => { ++request.current; window.clearInterval(timer); window.removeEventListener('focus', foregroundRefresh); };
  }, [refresh]);
  const visible = Boolean(owner && state.owner === owner && !state.error);
  return { ...state, visible, rows: visible ? state.rows : new Map(), refresh };
}
