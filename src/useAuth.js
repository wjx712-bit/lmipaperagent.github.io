import { useCallback, useEffect, useState } from 'react';
import { isSupabaseConfigured, supabase } from './supabase';

function redirectUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

export function useAuth() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState('');

  const loadProfile = useCallback(async (userId) => {
    if (!supabase || !userId) {
      setProfile(null);
      return null;
    }
    const { data, error: profileError } = await supabase
      .from('profiles')
      .select('id,email,display_name,avatar_url,status,role,created_at,approved_at')
      .eq('id', userId)
      .single();
    if (profileError) throw profileError;
    setProfile(data);
    return data;
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    supabase.auth.getSession().then(async ({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) {
        setError(sessionError.message);
        setLoading(false);
        return;
      }
      setSession(data.session);
      try {
        if (data.session?.user) await loadProfile(data.session.user.id);
      } catch (profileError) {
        setError(profileError.message);
      } finally {
        if (active) setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setError('');
      if (!nextSession?.user) {
        setProfile(null);
        setLoading(false);
        return;
      }
      window.setTimeout(() => {
        loadProfile(nextSession.user.id).catch((profileError) => setError(profileError.message));
      }, 0);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [loadProfile]);

  async function signInWithGoogle() {
    if (!supabase) return;
    setError('');
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectUrl() },
    });
    if (signInError) setError(signInError.message);
  }

  async function signOut() {
    if (!supabase) return;
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) setError(signOutError.message);
  }

  return {
    configured: isSupabaseConfigured,
    session,
    user: session?.user ?? null,
    profile,
    loading,
    error,
    isApproved: profile?.status === 'approved',
    isAdmin: profile?.status === 'approved' && profile?.role === 'admin',
    signInWithGoogle,
    signOut,
    refreshProfile: () => loadProfile(session?.user?.id),
  };
}
