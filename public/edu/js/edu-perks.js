/**
 * gIVEMEEDU — Perk requests (teacher approval UI)
 * Uses GET /api/edu/perk-requests and POST /api/edu/perk-requests/:id/decide
 */
const EduPerks = (function () {
  'use strict';

  function esc(s) { const d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function alert(type, msg) {
    const box = document.getElementById('alerts');
    if (!box) return;
    box.innerHTML = `<div class="edu-alert edu-alert-${type}">${esc(msg)}</div>`;
    setTimeout(() => { box.innerHTML = ''; }, 4000);
  }

  async function init() {
    const role = EduApp.getRole && EduApp.getRole();
    if (role !== 'teacher' && role !== 'admin') {
      document.getElementById('perk-req-list').innerHTML =
        '<div class="empty-state"><div class="empty-state-icon">&#128274;</div>Len ucitelia a administratori vidia tuto stranku.</div>';
      return;
    }
    await load();
  }

  async function load() {
    const container = document.getElementById('perk-req-list');
    container.innerHTML = '<div class="edu-loading"><div class="edu-spinner"></div></div>';
    try {
      const data = await EduAuth.apiFetch('/perk-requests');
      render(data.requests || []);
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Chyba pri nacitani.</div>';
      alert('error', e.message || 'Chyba');
    }
  }

  function render(rows) {
    const container = document.getElementById('perk-req-list');
    if (!rows.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#10003;</div>Ziadne cakajuce ziadosti.</div>';
      return;
    }
    container.innerHTML = `<div class="perk-req-list">${rows.map(r => `
      <div class="perk-req-row" data-id="${esc(r.id)}">
        <div class="perk-req-icon">${esc(r.perk_icon || '🎁')}</div>
        <div class="perk-req-body">
          <div class="perk-req-title">${esc(r.perk_title || r.perk_key)} <span class="perk-req-level">Lv ${esc(r.perk_level || '')}${r.duration_minutes ? ' · ' + r.duration_minutes + ' min' : ''}</span></div>
          <div class="perk-req-meta">${esc(r.student_name || r.student_email || 'Ziak')} · ${fmtTime(r.claimed_at)}</div>
          <div class="perk-req-desc">${esc(r.perk_description || '')}</div>
        </div>
        <div class="perk-req-actions">
          <button class="btn-approve" data-act="approve">Schvalit</button>
          <button class="btn-reject" data-act="reject">Zamietnut</button>
        </div>
      </div>`).join('')}</div>`;

    container.querySelectorAll('.perk-req-row').forEach(row => {
      const id = row.dataset.id;
      row.querySelector('[data-act="approve"]').onclick = () => decide(id, 'approve', row);
      row.querySelector('[data-act="reject"]').onclick = () => decide(id, 'reject', row);
    });
  }

  async function decide(id, decision, row) {
    let note = null;
    if (decision === 'reject') {
      note = prompt('Dovod zamietnutia (nepovinne):') || null;
    }
    const btns = row.querySelectorAll('button');
    btns.forEach(b => b.disabled = true);
    try {
      await EduAuth.apiFetch(`/perk-requests/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        body: { decision, note }
      });
      alert('success', decision === 'approve' ? 'Schvalene.' : 'Zamietnute.');
      row.remove();
      const list = document.querySelector('.perk-req-list');
      if (list && !list.children.length) {
        document.getElementById('perk-req-list').innerHTML =
          '<div class="empty-state"><div class="empty-state-icon">&#10003;</div>Ziadne cakajuce ziadosti.</div>';
      }
    } catch (e) {
      alert('error', e.message || 'Chyba');
      btns.forEach(b => b.disabled = false);
    }
  }

  return { init, load };
})();
