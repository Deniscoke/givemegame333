(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PostLoginRouter = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const SCHOOL_ROLES = new Set(['student', 'teacher', 'admin']);

  function destinationFor({ pendingLobby = '', schoolRole = null } = {}) {
    const code = String(pendingLobby).trim().toUpperCase();
    if (/^[A-Z0-9]{6}$/.test(code)) return `/index.html?lobby=${encodeURIComponent(code)}`;
    if (schoolRole === 'student') return '/student/';
    if (schoolRole === 'teacher' || schoolRole === 'admin') return '/edu/';
    return '/index.html';
  }

  async function fetchSchoolRole(accessToken, fetchImpl) {
    if (!accessToken || typeof fetchImpl !== 'function') return null;

    try {
      const response = await fetchImpl('/api/edu/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return null;

      const payload = await response.json();
      return SCHOOL_ROLES.has(payload?.school?.role) ? payload.school.role : null;
    } catch {
      return null;
    }
  }

  return { destinationFor, fetchSchoolRole };
}));
