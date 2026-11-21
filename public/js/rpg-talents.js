/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — RPG Talent Tree (client module)

   Handles loading, rendering, and unlocking of talent trees.
   Only available to school members who have selected an RPG avatar.

   Dependencies: supabaseClient (script.js), GameUI (game-ui.js)
   Exposes: window.RpgTalents
   ═══════════════════════════════════════════════════════════════════ */

const RpgTalents = (() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────
  let _data = null;   // { class_id, talents, unlocked[], coins }
  let _inflight = null;     // shared promise while GET /api/rpg/talents runs
  let _queued = null;       // one follow-up load requested during an in-flight load (HUD reload race)
  let _lastResult = null;   // { kind, status } of the last load

  // ─── Helpers (mirrored from rpg-avatar.js) ──────────────────────
  async function _token() {
    try {
      if (!window.supabaseClient) return null;
      const { data: { session } } = await Promise.race([
        window.supabaseClient.auth.getSession(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
      ]);
      return session?.access_token || null;
    } catch { return null; }
  }

  async function _fetch(url, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // ─── Load ───────────────────────────────────────────────────────
  /**
   * Load talents and remember why it failed, so the RPG screen can show
   * "offline" (retry), "login" (401 only) or the data. A call made while a
   * request is running waits for it and then fetches once more, so the HUD
   * sees XP awarded in between instead of stale data.
   * @returns {Promise<{ kind: 'ok'|'login'|'offline'|'error', status: number, data: object|null }>}
   */
  function loadResult() {
    if (_inflight) {
      if (!_queued) {
        _queued = _inflight.catch(() => null).then(() => { _queued = null; return loadResult(); });
      }
      return _queued;
    }
    _inflight = (async () => {
      let result;
      if (window.RpgNet) {
        result = await window.RpgNet.request('/api/rpg/talents');
      } else {
        result = { kind: 'offline', status: 0, data: null };
      }
      _lastResult = { kind: result.kind, status: result.status };
      _data = result.kind === 'ok' ? result.data : null;
      try { window.__lastRpgTalentsData = _data; } catch (_) {}
      return { ...result, data: _data };
    })().finally(() => { _inflight = null; });
    return _inflight;
  }

  /** Backwards-compatible: resolves with the data or null. */
  async function load() {
    const result = await loadResult();
    return result.data;
  }

  /** @returns {{ kind: string, status: number } | null} outcome of the last load */
  function getLastResult() { return _lastResult; }

  // ─── Unlock ─────────────────────────────────────────────────────
  async function unlock(talentId, onSuccess) {
    const token = await _token();
    if (!token) return;
    try {
      const res = await _fetch('/api/rpg/talents/unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ talent_id: talentId })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (window.GameUI?.toast) GameUI.toast(`❌ ${json.error || 'Chyba'}`);
        return;
      }
      // Update local state
      if (_data) {
        if (!_data.unlocked.includes(talentId)) _data.unlocked.push(talentId);
        _data.coins = json.coins_remaining;
        // Invalidate cached progression so stats panel refreshes on next open
        if (json.rpg_xp !== undefined && _data.progression) {
          _data.progression.xp = json.rpg_xp;
        }
      }
      // Sync coin displays
      if (window.Coins?.setBalance) Coins.setBalance(json.coins_remaining);
      const coinsEl = document.getElementById('profile-coins');
      if (coinsEl) coinsEl.textContent = json.coins_remaining;
      // Sync RPG screen sidebar
      if (window.RpgScreen?.updateCoinsDisplay) RpgScreen.updateCoinsDisplay(json.coins_remaining);

      // XP celebration effect
      if (json.rpg_xp_gained && window.RpgXpFx) {
        RpgXpFx.trigger(json.rpg_xp_gained, '⚔️ Talent odomknutý');
      }

      if (window.GameUI?.toast) GameUI.toast('⚡ Talent odomknutý!');
      if (onSuccess) onSuccess(json);
    } catch {
      if (window.GameUI?.toast) GameUI.toast('❌ Sieťová chyba');
    }
  }

  // ─── Branch label map ────────────────────────────────────────────
  const _BRANCH_LABELS = {
    2: ['Štúdium', 'Analýza'],
    3: ['Tvorba', 'Konštrukcia'],
    4: ['Empatia', 'Komunita'],
    5: ['Infiltrácia', 'Stratégia'],
    6: ['Experimenty', 'Transmutácia'],
    7: ['Múdrosť', 'Kultúra'],
    8: ['Ochrana', 'Vodcovstvo'],
  };

  const _CLASS_LABELS = {
    2: 'Scholar', 3: 'Builder', 4: 'Healer', 5: 'Shadow',
    6: 'Alchemist', 7: 'Sage', 8: 'Knight'
  };

  const _COMPETENCY_LABELS = {
    ucenie: 'K učeniu', problemy: 'K riešeniu problémov',
    komunikacia: 'Komunikatívna', socialna: 'Sociálna',
    obcianska: 'Občianska', pracovna: 'Pracovná',
    digitalna: 'Digitálna', kulturna: 'Kultúrna', matematika: 'Matematická',
  };

  // ─── Render ─────────────────────────────────────────────────────
  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    // No data: say why (offline / login only on 401), never a fake "not a member"
    if (!_data) {
      const kind = _lastResult?.kind || 'loading';
      if (window.RpgNet) {
        RpgNet.renderState(el, kind === 'ok' ? 'loading' : kind, {
          // Inside the RPG screen a retry must refresh the sidebar too, not only this panel.
          onRetry: () => {
            if (window.RpgScreen?.isOpen?.()) RpgScreen.refresh();
            else loadResult().then(() => render(containerId));
          },
          onLogin: () => { window.RpgScreen?.close?.(); window.App?.Profile?.open?.(); },
        });
      }
      return;
    }

    // Logged in, but no avatar yet
    if (!_data.class_id) {
      const tr = (k, f) => (window.RpgNet ? RpgNet.t(k, f) : f);
      el.innerHTML = `
        <div class="talent-empty px-state">
          <p class="talent-empty-title px-state__title">${_esc(tr('rpg_no_class', 'Bez avatara'))}</p>
          <p class="talent-empty-hint px-state__text">${_esc(tr('rpg_pick_avatar_hint', 'Vyber si avatara a uvidíš atribúty svojej postavy.'))}</p>
        </div>`;
      return;
    }

    const { class_id, talents, unlocked, coins } = _data;
    const classLabel = _CLASS_LABELS[class_id] || `Trieda ${class_id}`;
    const branchLabels = _BRANCH_LABELS[class_id] || ['Vetva A', 'Vetva B'];

    // Group talents: branch 0 (A) and branch 1 (B), each sorted by tier
    const branchA = talents.filter(t => t.class_id === class_id && t.branch === 0).sort((a, b) => a.tier - b.tier);
    const branchB = talents.filter(t => t.class_id === class_id && t.branch === 1).sort((a, b) => a.tier - b.tier);

    function nodeHTML(t) {
      const isUnlocked = unlocked.includes(t.id);
      const prereqId = t.tier > 1 ? t.id - 1 : null;
      const prereqMet = t.tier === 1 || unlocked.includes(prereqId);
      const canAfford = coins >= t.coin_cost;
      const isAvailable = !isUnlocked && prereqMet;

      let stateClass = 'locked';
      if (isUnlocked) stateClass = 'unlocked';
      else if (isAvailable && canAfford) stateClass = 'affordable';
      else if (isAvailable) stateClass = 'available';

      const compLabel = _COMPETENCY_LABELS[t.competency] || t.competency;

      return `
        <div class="rpg-talent-node ${stateClass}" data-talent-id="${t.id}" title="${_esc(t.name)}: ${_esc(t.description)}">
          <span class="rpg-talent-icon">${t.icon}</span>
          <span class="rpg-talent-name">${_esc(t.name)}</span>
          <span class="rpg-talent-desc">${_esc(t.description)}</span>
          <span class="rpg-talent-comp">📚 ${_esc(compLabel)}</span>
          ${isUnlocked
            ? `<span class="rpg-talent-status unlocked-badge">✓ Odomknuté</span>`
            : `<span class="rpg-talent-cost ${!canAfford ? 'unaffordable' : ''}">🪙 ${t.coin_cost.toLocaleString()}</span>`
          }
        </div>
        ${t.tier < 3 ? '<div class="rpg-talent-connector">▼</div>' : ''}`;
    }

    function branchHTML(talents, label) {
      return `
        <div class="rpg-talent-branch">
          <div class="rpg-talent-branch-label">${_esc(label)}</div>
          ${talents.map(nodeHTML).join('')}
        </div>`;
    }

    const memberNote = _data.is_school_member === false
      ? `<p class="rpg-talent-member-note px-badge px-badge--warning">${_esc(window.RpgNet ? RpgNet.t('rpg_not_member_text', 'Talenty a školské odmeny sa odomknú, keď ťa učiteľ pridá do triedy v gIVEMEEDU.') : 'Talenty a školské odmeny sa odomknú, keď ťa učiteľ pridá do triedy v gIVEMEEDU.')}</p>`
      : '';

    el.innerHTML = `
      ${memberNote}
      <p class="rpg-talent-hint">Odomkni talenty za coiny. Každá vetva má 3 stupne — odomkni postupne od Tier 1.</p>
      <div class="rpg-talent-tree" id="rpg-talent-tree-grid">
        ${branchHTML(branchA, branchLabels[0])}
        <div class="rpg-talent-divider"></div>
        ${branchHTML(branchB, branchLabels[1])}
      </div>`;

    // Bind click events
    el.querySelectorAll('.rpg-talent-node').forEach(node => {
      node.addEventListener('click', () => {
        const id = parseInt(node.dataset.talentId);
        if (isNaN(id)) return;
        if (node.classList.contains('unlocked')) {
          if (window.GameUI?.toast) GameUI.toast('✓ Tento talent už máš odomknutý');
          return;
        }
        if (node.classList.contains('locked')) {
          if (window.GameUI?.toast) GameUI.toast('🔒 Najprv odomkni predchádzajúci stupeň');
          return;
        }
        if (node.classList.contains('available')) {
          if (window.GameUI?.toast) GameUI.toast('🪙 Nedostatok coinov');
          return;
        }
        // affordable — confirm & unlock
        _showUnlockConfirm(id, el, containerId);
      });
    });
  }

  // ─── Unlock confirmation overlay ───────────────────────────────
  function _showUnlockConfirm(talentId, container, containerId) {
    const talent = (_data?.talents || []).find(t => t.id === talentId);
    if (!talent) return;

    let overlay = document.getElementById('rpg-talent-confirm');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'rpg-talent-confirm';
      overlay.className = 'rpg-talent-confirm-overlay';
      document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
      <div class="rpg-talent-confirm-box">
        <div class="rpg-talent-confirm-icon">${talent.icon}</div>
        <div class="rpg-talent-confirm-name">${_esc(talent.name)}</div>
        <div class="rpg-talent-confirm-desc">${_esc(talent.description)}</div>
        <div class="rpg-talent-confirm-cost">Cena: 🪙 ${talent.coin_cost.toLocaleString()} coinov</div>
        <div class="rpg-talent-confirm-actions">
          <button class="btn btn-retro" id="rpg-confirm-yes">⚡ Odomknúť</button>
          <button class="btn" id="rpg-confirm-no" style="opacity:0.7">Zrušiť</button>
        </div>
      </div>`;

    overlay.style.display = 'flex';

    overlay.querySelector('#rpg-confirm-yes').addEventListener('click', async () => {
      overlay.style.display = 'none';
      await unlock(talentId, () => render(containerId));
    });
    overlay.querySelector('#rpg-confirm-no').addEventListener('click', () => {
      overlay.style.display = 'none';
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  }

  /** Drop cached GET /api/rpg/talents payload (e.g. after avatar change). */
  function clearCache() {
    _data = null;
  }

  return { load, loadResult, getLastResult, unlock, render, clearCache };
})();

window.RpgTalents = RpgTalents;
