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
  let _loading = false;

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
  async function load() {
    if (_loading) return _data;
    _loading = true;
    try {
      const token = await _token();
      if (!token) { _data = null; return null; }
      const res = await _fetch('/api/rpg/talents', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) { _data = null; return null; }
      _data = await res.json();
      try { window.__lastRpgTalentsData = _data; } catch (_) {}
      return _data;
    } catch {
      _data = null;
      return null;
    } finally {
      _loading = false;
    }
  }

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

    // Not eligible (no avatar selected or not a school member)
    if (!_data || !_data.class_id) {
      el.innerHTML = `
        <div class="talent-empty">
          <div class="talent-empty-icon">🌱</div>
          <p class="talent-empty-title">Talent Tree</p>
          <p class="talent-empty-hint">Vyber si RPG avatara (musíš byť členom školy) a odomkni svoju triedu talentov.</p>
          <a href="/edu/index.html" class="btn btn-retro" style="text-decoration:none;font-size:10px">🏫 gIVEMEEDU</a>
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

    el.innerHTML = `
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

  return { load, unlock, render };
})();

window.RpgTalents = RpgTalents;
