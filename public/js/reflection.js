/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Reflection module (Phase 4)

   Shows a reflection form after a game/timer completes.
   Questions are generated from the game's RVP competency mapping.

   Dependencies (resolved at call-time):
     • supabaseClient     — var in script.js
     • GameUI.toast()     — global
     • window.currentGame — var in script.js

   Exposes: window.Reflection
   ═══════════════════════════════════════════════════════════════════ */

const Reflection = (() => {
	const MODAL_ID = 'reflection-modal';

	// Resolve translation at call-time so language changes are respected
	const _t = (key, fallback) => (window.givemegame_t || ((k, f) => f || k))(key, fallback);

	// Question labels per competency key — resolved via _t() at open() time
	function _kompQuestions() {
		return {
			'k-uceni':            _t('refl_q_k_uceni',       'Ako sa ti darilo učiť sa nové veci počas hry?'),
			'k-reseni-problemu':  _t('refl_q_k_reseni',      'Ako si riešil/a problémy počas aktivity?'),
			'komunikativni':      _t('refl_q_komunikativni', 'Ako sa ti darilo komunikovať so skupinou?'),
			'socialni-personalni':_t('refl_q_socialni',      'Ako si spolupracoval/a s ostatnými hráčmi?'),
			'obcanske':           _t('refl_q_obcanske',      'Ako si dodržiaval/a pravidlá a férovosť?'),
			'pracovni':           _t('refl_q_pracovni',      'Ako si pristupoval/a k zadanej úlohe?')
		};
	}

	// Build 5 questions: up to 3 competency ratings + 2 fixed open text
	function buildQuestions(game) {
		const kompQuestions = _kompQuestions();
		const questions = [];
		const komps = (game?.rvp?.kompetence || []).slice(0, 3);
		komps.forEach(key => {
			questions.push({
				id: key,
				type: 'rating',
				label: kompQuestions[key] || key
			});
		});
		// Pad to 3 items with DISTINCT fallback questions; skip any already shown via rvp.kompetence
		const usedKompKeys = new Set(komps);
		const FALLBACK_PADS = [
			{ id: 'pad_general',  label: () => _t('refl_q_aktivita',      'Ako hodnotíš svoju účasť na aktivite?') },
			{ id: 'pad_learning', label: () => _t('refl_q_k_uceni',       'Ako sa ti darilo učiť sa nové veci počas hry?'), skipIfUsed: 'k-uceni' },
			{ id: 'pad_social',   label: () => _t('refl_q_socialni',       'Ako si spolupracoval/a s ostatnými hráčmi?'),   skipIfUsed: 'socialni-personalni' },
			{ id: 'pad_comm',     label: () => _t('refl_q_komunikativni',  'Ako sa ti darilo komunikovať so skupinou?'),    skipIfUsed: 'komunikativni' },
		];
		let padPtr = 0;
		while (questions.length < 3 && padPtr < FALLBACK_PADS.length) {
			const fb = FALLBACK_PADS[padPtr++];
			if (fb.skipIfUsed && usedKompKeys.has(fb.skipIfUsed)) continue;
			questions.push({ id: fb.id, type: 'rating', label: fb.label() });
		}
		questions.push({ id: 'darilo',  type: 'text', label: _t('refl_q_darilo',  'Čo sa ti darilo?') });
		questions.push({ id: 'zlepsit', type: 'text', label: _t('refl_q_zlepsit', 'Čo by si zlepšil/a nabudúce?') });
		return questions;
	}

	let _pendingPhotoBase64 = null;
	let _currentGame = null;

	function open(game, sessionCode, onSubmitted) {
		const modal = document.getElementById(MODAL_ID);
		if (!modal) return;
		_pendingPhotoBase64 = null;
		_currentGame = game;

		const questions = buildQuestions(game);
		const form = modal.querySelector('#reflection-form');
		if (!form) return;
		form.innerHTML = '';

		// Photo verification section (if game has verificationChallenge)
		const vc = game?.verificationChallenge;
		if (vc && vc.description) {
			const photoDiv = document.createElement('div');
			photoDiv.className = 'reflection-photo-section';
			photoDiv.innerHTML = `
				<div class="reflection-photo-challenge">
					<div class="reflection-photo-icon">📸</div>
					<div class="reflection-photo-text">
						<strong>${_t('refl_photo_title', 'Foto dôkaz (bonus XP)')}</strong>
						<p>${vc.description}</p>
						${vc.hint ? `<small class="reflection-photo-hint">💡 ${vc.hint}</small>` : ''}
					</div>
				</div>
				<div class="reflection-photo-upload" id="reflection-photo-upload">
					<input type="file" accept="image/*" capture="environment" id="reflection-photo-input"
						style="display:none" onchange="Reflection._onPhotoSelected(this)">
					<button type="button" class="btn btn-retro reflection-photo-btn" onclick="document.getElementById('reflection-photo-input').click()">
						📷 ${_t('refl_photo_btn', 'Odfoť / Nahraj fotku')}
					</button>
					<div id="reflection-photo-preview" class="reflection-photo-preview" style="display:none"></div>
					<div id="reflection-photo-status" class="reflection-photo-status"></div>
				</div>`;
			form.appendChild(photoDiv);
		}

		questions.forEach(q => {
			const div = document.createElement('div');
			div.className = 'reflection-question';

			if (q.type === 'rating') {
				div.innerHTML = `
					<label class="reflection-label">${q.label}</label>
					<div class="reflection-rating" data-id="${q.id}">
						${[1,2,3,4,5].map(n =>
							`<button type="button" class="rating-btn" data-val="${n}">${n}</button>`
						).join('')}
					</div>`;
				div.querySelectorAll('.rating-btn').forEach(btn => {
					btn.addEventListener('click', () => {
						div.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('selected'));
						btn.classList.add('selected');
						div.querySelector('.reflection-rating').dataset.value = btn.dataset.val;
					});
				});
			} else {
				div.innerHTML = `
					<label class="reflection-label">${q.label}</label>
					<textarea data-id="${q.id}" rows="2" maxlength="300"
						placeholder="${_t('refl_placeholder', 'Napíš pár viet...')}"></textarea>`;
				if (q.id === 'darilo') {
					const ta = div.querySelector('textarea');
					if (ta) ta.value = localStorage.getItem('givemegame_session_notes') || '';
				}
			}
			form.appendChild(div);
		});

		const submitBtn = modal.querySelector('#btn-reflection-submit');
		if (submitBtn) {
			submitBtn.disabled = false;
			submitBtn.onclick = () => _submit(questions, form, sessionCode, onSubmitted);
		}

		modal.style.display = 'flex';
	}

	function _onPhotoSelected(input) {
		const file = input.files?.[0];
		if (!file) return;
		const preview = document.getElementById('reflection-photo-preview');
		const status = document.getElementById('reflection-photo-status');

		if (file.size > 5 * 1024 * 1024) {
			if (status) status.textContent = _t('refl_photo_too_big', '⚠️ Fotka je príliš veľká (max 5 MB)');
			return;
		}

		const reader = new FileReader();
		reader.onload = () => {
			_pendingPhotoBase64 = reader.result;
			if (preview) {
				preview.innerHTML = `<img src="${reader.result}" alt="Preview">`;
				preview.style.display = 'block';
			}
			if (status) status.textContent = _t('refl_photo_ready', '✅ Fotka pripravená — odošli reflexiu');
		};
		reader.readAsDataURL(file);
	}

	async function _submit(questions, form, sessionCode, onSubmitted) {
		const data = {};
		let allFilled = true;

		questions.forEach(q => {
			if (q.type === 'rating') {
				const container = form.querySelector(`.reflection-rating[data-id="${q.id}"]`);
				const val = container?.dataset.value;
				if (!val) { allFilled = false; return; }
				data[q.id] = parseInt(val, 10);
			} else {
				const ta = form.querySelector(`textarea[data-id="${q.id}"]`);
				const val = ta?.value?.trim();
				if (!val) { allFilled = false; return; }
				data[q.id] = val;
			}
		});

		if (!allFilled) {
			GameUI.toast(_t('refl_fill_all', '⚠️ Vyplň všetky otázky pred odoslaním'));
			return;
		}

		const submitBtn = document.getElementById('btn-reflection-submit');
		if (submitBtn) submitBtn.disabled = true;

		let res;
		try {
			if (sessionCode && supabaseClient) {
				const { data: { session: authSession } } = await Promise.race([
					supabaseClient.auth.getSession(),
					new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
				]);
				const token = authSession?.access_token;
				if (!token) throw new Error(_t('refl_no_auth', 'Prihlás sa pre odoslanie reflexie'));

				const ctrl = new AbortController();
				const fetchTimeout = setTimeout(() => ctrl.abort(), 12000);
				try {
					res = await fetch(`/api/sessions/${sessionCode}/reflect`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${token}`
						},
						signal: ctrl.signal,
						body: JSON.stringify({ reflection_data: data })
					});
				} finally { clearTimeout(fetchTimeout); }
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || _t('refl_error', 'Chyba pri odosielaní reflexie'));
				}
			} else {
				// Solo flow — ulož reflexiu do localStorage ako záloha
				try {
					const key = 'givemegame_solo_reflections';
					const existing = JSON.parse(localStorage.getItem(key) || '[]');
					existing.unshift({ ts: new Date().toISOString(), data });
					if (existing.length > 20) existing.length = 20; // max 20 záznamov
					localStorage.setItem(key, JSON.stringify(existing));
				} catch (e) {}
			}

			close();
			if (typeof onSubmitted === 'function') onSubmitted(data);

		} catch (err) {
			GameUI.toast(`❌ ${err.message}`);
			if (submitBtn) submitBtn.disabled = false;
		}
	}

	function close() {
		const modal = document.getElementById(MODAL_ID);
		if (modal) modal.style.display = 'none';
		_pendingPhotoBase64 = null;
		_currentGame = null;
	}

	function getPhotoBase64() { return _pendingPhotoBase64; }
	function getCurrentGame() { return _currentGame; }

	return { open, close, buildQuestions, _onPhotoSelected, getPhotoBase64, getCurrentGame };
})();

window.Reflection = Reflection;
