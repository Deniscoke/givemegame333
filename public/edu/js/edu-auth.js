/**
 * gIVEMEEDU — Auth module
 * Reuses Supabase session from login.html (stored by Supabase SDK in localStorage).
 */
const EduAuth = (function () {
  'use strict';

  const SUPABASE_URL = 'https://vhpkkbixshfyytohkruv.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZocGtrYml4c2hmeXl0b2hrcnV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMDAzNzcsImV4cCI6MjA4ODY3NjM3N30.umrrhSqC9LW2Wlcs5y4uCViVfZmqyHcMbaPQaQiMbR0';

  let _supabase = null;
  let _accessToken = null;
  let _eduProfile = null; // { user, school }

  function initSupabase() {
    if (_supabase) return _supabase;
    if (!window.supabase) return null;
    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { detectSessionInUrl: false, persistSession: true }
    });
    return _supabase;
  }

  async function getAccessToken() {
    if (_accessToken) return _accessToken;
    const sb = initSupabase();
    if (!sb) return null;
    const { data: { session } } = await sb.auth.getSession();
    if (session?.access_token) {
      _accessToken = session.access_token;
      return _accessToken;
    }
    return null;
  }

  async function apiFetch(path, opts = {}) {
    const token = await getAccessToken();
    if (!token) {
      window.location.href = '/';
      throw new Error('No auth token');
    }
    const res = await fetch(`/api/edu${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(opts.headers || {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401) {
      window.location.href = '/';
      throw new Error('Unauthorized');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API error');
    return data;
  }

  async function loadProfile() {
    if (_eduProfile) return _eduProfile;
    _eduProfile = await apiFetch('/me');
    return _eduProfile;
  }

  function getProfile() { return _eduProfile; }

  async function logout() {
    const sb = initSupabase();
    if (sb) await sb.auth.signOut();
    sessionStorage.removeItem('givemegame_user');
    window.location.href = '/';
  }

  return { initSupabase, getAccessToken, apiFetch, loadProfile, getProfile, logout };
})();
