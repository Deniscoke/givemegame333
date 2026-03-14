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

	// Human-readable question per competency key
	const KOMP_QUESTIONS = {
		'k-uceni':            'Ako sa ti darilo učiť sa nové veci počas hry?',
		'k-reseni-problemu':  'Ako si riešil/a problémy počas aktivity?',
		'komunikativni':      'Ako sa ti darilo komunikovať so skupinou?',
		'socialni-personalni':'Ako si spolupracoval/a s ostatnými hráčmi?',
		'obcanske':           'Ako si dodržiaval/a pravidlá a férovosť?',
		'pracovni':           'Ako si pristupoval/a k zadanej úlohe?'
	};

	// Build 5 questions: up to 3 competency ratings + 2 fixed open text
	function buildQuestions(game) {
		const questions = [];
		const komps = (game?.rvp?.kompetence || []).slice(0, 3);
		komps.forEach(key => {
			questions.push({
				id: key,
				type: 'rating',
				label: KOMP_QUESTIONS[key] || key
			});
		});
		// Always pad to at least 3 items with a generic if fewer competencies
		while (questions.length < 3) {
			questions.push({
				id: 'aktivita_' + questions.length,
				type: 'rating',
				label: 'Ako hodnotíš svoju účasť na aktivite?'
			});
		}
		questions.push({ id: 'darilo',  type: 'text', label: 'Čo sa ti darilo?' });
		questions.push({ id: 'zlepsit', type: 'text', label: 'Čo by si zlepšil/a nabudúce?' });
		return questions;
	}

	function open(game, sessionCode, onSubmitted) {
		const modal = document.getElementById(MODAL_ID);
		if (!modal) return;

		const questions = buildQuestions(game);
		const form = modal.querySelector('#reflection-form');
		if (!form) return;
		form.innerHTML = '';

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
						placeholder="Napíš pár viet..."></textarea>`;
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
			GameUI.toast('⚠️ Vyplň všetky otázky pred odoslaním');
			return;
		}

		const submitBtn = document.getElementById('btn-reflection-submit');
		if (submitBtn) submitBtn.disabled = true;

		try {
			if (sessionCode && supabaseClient) {
				const { data: { session: authSession } } = await supabaseClient.auth.getSession();
				const token = authSession?.access_token;
				if (!token) throw new Error('Prihlás sa pre odoslanie reflexie');

				const res = await fetch(`/api/sessions/${sessionCode}/reflect`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${token}`
					},
					body: JSON.stringify({ reflection_data: data })
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || 'Chyba pri odosielaní reflexie');
				}
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
	}

	return { open, close, buildQuestions };
})();

window.Reflection = Reflection;
