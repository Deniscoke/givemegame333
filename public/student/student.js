(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StudentHome = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const SUPABASE_URL = ((root.GMG_SUPABASE || {}).url) || 'https://vhpkkbixshfyytohkruv.supabase.co';
  const SUPABASE_ANON_KEY = ((root.GMG_SUPABASE || {}).anonKey) || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZocGtrYml4c2hmeXl0b2hrcnV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMDAzNzcsImV4cCI6MjA4ODY3NjM3N30.umrrhSqC9LW2Wlcs5y4uCViVfZmqyHcMbaPQaQiMbR0';
  let client;

  function normalizeJoinCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function joinDestination(value) {
    const code = normalizeJoinCode(value);
    return code.length === 6 ? `/index.html?lobby=${code}` : null;
  }

  function setState(id, message, state) {
    const element = root.document && root.document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    if (state) element.dataset.state = state;
  }

  function setJoinError(message) {
    const element = root.document && root.document.getElementById('join-code-error');
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
    if (message) element.focus();
  }

  function getSupabaseClient() {
    if (client) return client;
    if (!root.supabase || typeof root.supabase.createClient !== 'function') return null;
    client = root.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { detectSessionInUrl: false, persistSession: true },
    });
    return client;
  }

  async function getAccessToken() {
    const supabase = getSupabaseClient();
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data && data.session ? data.session.access_token || null : null;
  }

  async function fetchJson(url, token) {
    if (!token) return null;
    const response = await root.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function renderSession() {
    try {
      const saved = JSON.parse(root.localStorage.getItem('givemegame_active_session') || 'null');
      const code = saved && normalizeJoinCode(saved.code);
      if (code && code.length === 6) setState('active-session', `Máš rozbehnutú hru s kódom ${code}.`, 'success');
    } catch (_) {
      // A malformed local record is not an active session.
    }
  }

  function renderProfile(profile) {
    const user = profile && profile.user;
    if (!user) return;
    const name = user.display_name || user.email || 'žiak';
    const element = root.document.getElementById('student-profile');
    if (!element) return;
    element.textContent = `Prihlásený ako ${name}.`;
    element.hidden = false;
  }

  function summarizeAssessmentResults(results) {
    const attempts = Array.isArray(results && results.attempts) ? results.attempts : [];
    const deltas = results && results.deltas;
    return {
      completedActivities: attempts.filter((attempt) => attempt && attempt.status === 'submitted').length,
      progressAreas: deltas && typeof deltas === 'object' && !Array.isArray(deltas)
        ? Object.keys(deltas).length
        : 0,
    };
  }

  function renderResults(results) {
    const summary = summarizeAssessmentResults(results);
    setState('activity-state', summary.completedActivities
      ? `Máš ${summary.completedActivities} dokončených aktivít.`
      : 'Zatiaľ nemáš dokončené aktivity.', summary.completedActivities ? 'success' : '');
    setState('progress-state', summary.progressAreas
      ? `Sleduješ pokrok v ${summary.progressAreas} oblastiach.`
      : 'Pokrok sa ukáže po prvých aktivitách.', summary.progressAreas ? 'success' : '');
  }

  async function loadRemoteState() {
    let token;
    try {
      token = await getAccessToken();
    } catch (_) {
      token = null;
    }
    if (!token) {
      setState('activity-state', 'Prihlás sa, aby si videl svoje aktivity.');
      setState('progress-state', 'Prihlás sa, aby si videl svoj pokrok.');
      return;
    }
    try {
      const [profile, results] = await Promise.all([
        fetchJson('/api/edu/me', token),
        fetchJson('/api/assessment-results/me', token),
      ]);
      renderProfile(profile);
      renderResults(results);
    } catch (_) {
      setState('activity-state', 'Aktivity sa teraz nepodarilo načítať.', 'error');
      setState('progress-state', 'Pokrok sa teraz nepodarilo načítať.', 'error');
    }
  }

  function bindPage() {
    const document = root.document;
    if (!document) return;
    root.ProductShell && root.ProductShell.setActiveNavigation(document, root.location.pathname);
    const moreButton = document.querySelector('.student-nav__more');
    const moreMenu = document.getElementById('student-more-menu');
    if (moreButton && moreMenu) moreButton.addEventListener('click', () => {
      root.ProductShell && root.ProductShell.toggleMenu(moreButton, moreMenu);
    });
    const form = document.getElementById('join-game-form');
    const input = document.getElementById('join-game-code');
    if (input) input.addEventListener('input', () => {
      input.value = normalizeJoinCode(input.value);
      setJoinError('');
    });
    if (form && input) form.addEventListener('submit', (event) => {
      event.preventDefault();
      const destination = joinDestination(input.value);
      if (!destination) {
        setJoinError('Zadaj úplný 6-znakový kód hry.');
        return;
      }
      root.location.assign(destination);
    });
    renderSession();
    loadRemoteState();
  }

  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', bindPage);
    else bindPage();
  }

  return { normalizeJoinCode, joinDestination, summarizeAssessmentResults };
});
