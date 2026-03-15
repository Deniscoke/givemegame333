/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — GameEdit module (extracted from script.js Phase 2)

   Dependencies (globals resolved at call-time, not load-time):
     • currentGame        — var declared in script.js (top-level)
     • supabaseClient     — var declared in script.js (top-level)
     • ngrokHeaders()     — const declared in script.js (top-level)
     • GameUI             — const declared in script.js (top-level, shared global scope)

   Exposes: window.GameEdit  (also bridged inside App as `const GameEdit = window.GameEdit`)
   ═══════════════════════════════════════════════════════════════════ */

const GameEdit = (() => {
	const el = (id) => document.getElementById(id);
	const toArr = (txt) => (txt || '').split('\n').map(s => s.trim()).filter(Boolean);
	const arrStr = (a) => (a || []).join('\n');

	async function _headers() {
		try {
			const { data: { session } } = await supabaseClient.auth.getSession();
			if (!session?.access_token) return null;
			return { ...ngrokHeaders(), Authorization: `Bearer ${session.access_token}` };
		} catch { return null; }
	}

	function open() {
		if (!currentGame?._savedId) return;
		const g = currentGame;
		el('gedit-title').value           = g.title || '';
		el('gedit-pitch').value           = g.pitch || '';
		el('gedit-materials').value        = arrStr(g.materials);
		el('gedit-instructions').value     = arrStr(g.instructions);
		el('gedit-learningGoals').value    = arrStr(g.learningGoals);
		el('gedit-reflectionPrompts').value = arrStr(g.reflectionPrompts);
		el('gedit-safetyNotes').value      = arrStr(g.safetyNotes);
		el('gedit-adaptationTips').value   = arrStr(g.adaptationTips);
		el('gedit-facilitatorNotes').value = g.facilitatorNotes || '';
		el('game-edit-modal').style.display = 'flex';
	}

	async function save() {
		const title = el('gedit-title').value.trim();
		if (!title) { GameUI.toast('Názov nemôže byť prázdny'); return; }
		const patch = {
			title,
			pitch:             el('gedit-pitch').value.trim(),
			materials:         toArr(el('gedit-materials').value),
			instructions:      toArr(el('gedit-instructions').value),
			learningGoals:     toArr(el('gedit-learningGoals').value),
			reflectionPrompts: toArr(el('gedit-reflectionPrompts').value),
			safetyNotes:       toArr(el('gedit-safetyNotes').value),
			adaptationTips:    toArr(el('gedit-adaptationTips').value),
			facilitatorNotes:  el('gedit-facilitatorNotes').value.trim()
		};
		const saveBtn = el('btn-gedit-save');
		if (saveBtn) saveBtn.disabled = true;
		const headers = await _headers();
		if (!headers) { GameUI.toast('Prihlás sa pre ukladanie zmien'); if (saveBtn) saveBtn.disabled = false; return; }
		try {
			const resp = await fetch(`/api/games/${currentGame._savedId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify(patch)
			});
			if (!resp.ok) throw new Error('Nepodarilo sa uložiť');
			// Merge patch into currentGame and re-render
			Object.assign(currentGame, patch);
			GameUI.renderGame(currentGame);
			el('game-edit-modal').style.display = 'none';
			GameUI.toast('✅ Hra aktualizovaná');
		} catch (err) {
			GameUI.toast('Chyba: ' + err.message);
		} finally {
			if (saveBtn) saveBtn.disabled = false;
		}
	}

	function cancel() {
		el('game-edit-modal').style.display = 'none';
	}

	return { open, save, cancel };
})();

// Expose globally so App can bridge it as `const GameEdit = window.GameEdit`
window.GameEdit = GameEdit;
