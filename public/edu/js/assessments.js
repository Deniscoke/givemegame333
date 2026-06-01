/*
 * public/edu/js/assessments.js — INVOK Assessment frontend (MVP)
 *
 * Vanilla JS, IIFE module. Depends on:
 *   - window.EduAuth (from edu-auth.js) — for getToken()
 *   - window.givemegame_t (from script.js, if loaded) — optional i18n
 *
 * Architecture: tab-based UI (list / create / results / summary), plus a
 * hidden "take" panel that swaps in when the user starts an assessment.
 */
'use strict';

(function () {
	const t = (key, fb) => (window.givemegame_t ? window.givemegame_t(key, fb) : fb);

	// ─── Defensive HTML escape (XSS guard) ─────────────────────────────
	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
		}[c]));
	}

	// ─── API client wrapper ────────────────────────────────────────────
	async function api(path, opts) {
		opts = opts || {};
		const token = await (window.EduAuth && window.EduAuth.getToken
			? window.EduAuth.getToken()
			: Promise.resolve(null));
		const headers = Object.assign({}, opts.headers || {});
		if (token) headers['Authorization'] = 'Bearer ' + token;
		if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
		const res = await fetch(path, Object.assign({}, opts, { headers }));
		const ct = res.headers.get('content-type') || '';
		const data = ct.includes('application/json') ? await res.json() : await res.text();
		if (!res.ok) {
			const err = new Error((data && data.error) || ('HTTP ' + res.status));
			err.code = (data && data.code) || ('HTTP_' + res.status);
			err.data = data;
			throw err;
		}
		return data;
	}

	function showError(msg) {
		const el = document.getElementById('assess-error');
		if (!el) return;
		el.textContent = msg;
		el.hidden = false;
		setTimeout(() => { el.hidden = true; }, 5000);
	}

	// ─── Tab navigation ────────────────────────────────────────────────
	const TABS = ['list', 'create', 'results', 'summary'];

	function showTab(name) {
		TABS.forEach(tab => {
			const btn = document.getElementById('tab-' + tab);
			const panel = document.getElementById('panel-' + tab);
			if (btn) btn.setAttribute('aria-selected', tab === name ? 'true' : 'false');
			if (panel) panel.hidden = tab !== name;
		});
		// Hide "take" panel when switching tabs.
		const take = document.getElementById('panel-take');
		if (take) take.hidden = true;

		if (name === 'list') loadList();
		if (name === 'results') loadMyResults();
		if (name === 'summary') loadSummary();
	}

	function bindTabs() {
		TABS.forEach(tab => {
			const btn = document.getElementById('tab-' + tab);
			if (btn) btn.addEventListener('click', () => showTab(tab));
		});
	}

	// ─── List ──────────────────────────────────────────────────────────
	async function loadList() {
		const container = document.getElementById('assess-list-container');
		container.innerHTML = '<p class="assess-empty">' + esc(t('assess_loading', 'Načítavam...')) + '</p>';
		try {
			const { items } = await api('/api/assessments');
			if (!items.length) {
				container.innerHTML = '<p class="assess-empty">' + esc(t('assess_empty', 'Zatiaľ žiadne assessmenty.')) + '</p>';
				return;
			}
			container.innerHTML = items.map(renderCard).join('');
			container.querySelectorAll('[data-take]').forEach(b => {
				b.addEventListener('click', () => startTake(b.dataset.take));
			});
		} catch (e) {
			showError(e.message);
			container.innerHTML = '';
		}
	}

	function renderCard(a) {
		const moduleLabel = t('assess_module_' + a.module_key, a.module_key);
		const typeLabel = t('assess_type_' + a.assessment_type, a.assessment_type);
		const dateStr = a.created_at ? new Date(a.created_at).toLocaleDateString() : '';
		return [
			'<article class="assess-card">',
			'<h3>', esc(a.title), '</h3>',
			'<div class="assess-meta">',
				'<span class="assess-pill ', esc(a.assessment_type), '">', esc(typeLabel), '</span>',
				'<span class="assess-pill">', esc(moduleLabel), '</span>',
				'<span>', esc(dateStr), '</span>',
				a.is_mine ? '<span class="assess-pill">' + esc(t('assess_mine', 'moje')) + '</span>' : '',
			'</div>',
			a.description ? '<p>' + esc(a.description) + '</p>' : '',
			'<button class="assess-btn" data-take="', esc(a.id), '">',
				esc(t('assess_btn_take', 'Začať')),
			'</button>',
			'</article>'
		].join('');
	}

	// ─── Take flow ─────────────────────────────────────────────────────
	async function startTake(assessmentId) {
		try {
			const detail = await api('/api/assessments/' + assessmentId);
			const { attempt_id } = await api('/api/assessments/' + assessmentId + '/start', {
				method: 'POST',
				body: '{}'
			});
			renderTakeUI(detail, attempt_id);
		} catch (e) {
			showError(e.message);
		}
	}

	function renderTakeUI(assessment, attemptId) {
		const panel = document.getElementById('panel-take');
		const container = document.getElementById('take-container');
		// Hide other panels
		TABS.forEach(tab => { const p = document.getElementById('panel-' + tab); if (p) p.hidden = true; });
		panel.hidden = false;

		const qsHtml = assessment.questions.map((q, i) => renderQuestion(q, i)).join('');

		container.innerHTML = [
			'<h2>', esc(assessment.title), '</h2>',
			assessment.description ? '<p>' + esc(assessment.description) + '</p>' : '',
			'<form id="take-form" class="assess-form" novalidate>',
			qsHtml,
			'<div><button type="submit" class="assess-btn">',
				esc(t('assess_btn_submit', 'Odoslať')),
			'</button> ',
			'<button type="button" class="assess-btn secondary" id="btn-cancel-take">',
				esc(t('assess_btn_cancel', 'Zrušiť')),
			'</button></div>',
			'</form>'
		].join('');

		document.getElementById('btn-cancel-take').addEventListener('click', () => showTab('list'));
		document.getElementById('take-form').addEventListener('submit', e => {
			e.preventDefault();
			submitTake(assessment, attemptId);
		});
	}

	function renderQuestion(q, i) {
		const label = (i + 1) + '. ' + esc(q.prompt);
		const idPrefix = 'q-' + esc(q.id);
		if (q.question_type === 'multiple_choice') {
			const opts = Array.isArray(q.options) ? q.options : [];
			const optsHtml = opts.map((opt, k) => [
				'<div>',
				'<label>',
				'<input type="radio" name="', idPrefix, '" value="', esc(String(opt)), '" data-qid="', esc(q.id), '">',
				' ', esc(String(opt)),
				'</label>',
				'</div>'
			].join('')).join('');
			return [
				'<fieldset class="question-block">',
				'<legend>', label, '</legend>',
				'<div class="question-options-list">', optsHtml, '</div>',
				'</fieldset>'
			].join('');
		}
		if (q.question_type === 'scale_1_5') {
			const opts = [1, 2, 3, 4, 5].map(v => [
				'<label>',
				'<input type="radio" name="', idPrefix, '" value="', v, '" data-qid="', esc(q.id), '">',
				' ', v,
				'</label>'
			].join('')).join('');
			return [
				'<fieldset class="question-block">',
				'<legend>', label, '</legend>',
				'<div class="scale-options">', opts, '</div>',
				'</fieldset>'
			].join('');
		}
		// text
		return [
			'<div class="question-block">',
			'<label for="', idPrefix, '">', label, '</label>',
			'<textarea id="', idPrefix, '" name="', idPrefix, '" data-qid="', esc(q.id), '" maxlength="5000"></textarea>',
			'</div>'
		].join('');
	}

	async function submitTake(assessment, attemptId) {
		const answers = [];
		for (const q of assessment.questions) {
			const name = 'q-' + q.id;
			if (q.question_type === 'multiple_choice') {
				const sel = document.querySelector('input[name="' + cssEscape(name) + '"]:checked');
				if (sel) answers.push({ question_id: q.id, answer: { value: sel.value } });
			} else if (q.question_type === 'scale_1_5') {
				const sel = document.querySelector('input[name="' + cssEscape(name) + '"]:checked');
				if (sel) answers.push({ question_id: q.id, answer: { value: Number(sel.value) } });
			} else if (q.question_type === 'text') {
				const ta = document.getElementById(name);
				if (ta && ta.value.trim()) {
					answers.push({ question_id: q.id, answer: { value: ta.value } });
				}
			}
		}
		try {
			const result = await api('/api/assessment-attempts/' + attemptId + '/submit', {
				method: 'POST',
				body: JSON.stringify({ answers })
			});
			renderResultScreen(result);
		} catch (e) {
			showError(e.message);
		}
	}

	function cssEscape(s) {
		// Conservative escape for use inside querySelector attribute matchers.
		return String(s).replace(/(["\\\]\[])/g, '\\$1');
	}

	function renderResultScreen(result) {
		const container = document.getElementById('take-container');
		container.innerHTML = [
			'<h2>', esc(t('assess_done_h2', 'Hotovo!')), '</h2>',
			'<div class="assess-card">',
			'<p><strong>', esc(t('assess_total', 'Body')), ':</strong> ',
				esc(result.total_score), ' / ', esc(result.max_score), '</p>',
			'<p><strong>', esc(t('assess_percent', 'Percentá')), ':</strong> ', esc(result.percent_score), ' %</p>',
			'</div>',
			'<button class="assess-btn" id="btn-back-to-list">',
				esc(t('assess_btn_back', 'Späť na zoznam')),
			'</button>'
		].join('');
		document.getElementById('btn-back-to-list').addEventListener('click', () => showTab('list'));
	}

	// ─── Create form ───────────────────────────────────────────────────
	let _questionCounter = 0;

	function addQuestionBlock() {
		const wrap = document.getElementById('cf-questions');
		const idx = _questionCounter++;
		const div = document.createElement('div');
		div.className = 'question-block';
		div.innerHTML = [
			'<label for="qf-prompt-', idx, '">', esc(t('assess_q_prompt', 'Otázka')), '</label>',
			'<input type="text" id="qf-prompt-', idx, '" data-q-prompt="', idx, '" maxlength="2000" required>',
			'<label for="qf-type-', idx, '">', esc(t('assess_q_type', 'Typ')), '</label>',
			'<select id="qf-type-', idx, '" data-q-type="', idx, '">',
				'<option value="multiple_choice">multiple_choice</option>',
				'<option value="scale_1_5">scale_1_5</option>',
				'<option value="text">text</option>',
			'</select>',
			'<label for="qf-options-', idx, '">', esc(t('assess_q_options', 'Možnosti (oddelené čiarkou, len pre multiple_choice)')), '</label>',
			'<input type="text" id="qf-options-', idx, '" data-q-options="', idx, '" maxlength="1000">',
			'<label for="qf-correct-', idx, '">', esc(t('assess_q_correct', 'Správna odpoveď (hodnota / target 1–5 / prázdne pre likert)')), '</label>',
			'<input type="text" id="qf-correct-', idx, '" data-q-correct="', idx, '" maxlength="200">',
			'<label for="qf-points-', idx, '">', esc(t('assess_q_points', 'Body')), '</label>',
			'<input type="number" id="qf-points-', idx, '" data-q-points="', idx, '" min="0" max="100" step="0.5" value="1">'
		].join('');
		wrap.appendChild(div);
	}

	function collectQuestionsFromForm() {
		const questions = [];
		const wrap = document.getElementById('cf-questions');
		const blocks = wrap.querySelectorAll('.question-block');
		blocks.forEach(block => {
			const prompt = block.querySelector('[data-q-prompt]').value.trim();
			const type = block.querySelector('[data-q-type]').value;
			const optsRaw = block.querySelector('[data-q-options]').value.trim();
			const correctRaw = block.querySelector('[data-q-correct]').value.trim();
			const points = Number(block.querySelector('[data-q-points]').value) || 1;
			if (!prompt) return;
			const q = { question_type: type, prompt, max_points: points };
			if (type === 'multiple_choice') {
				q.options = optsRaw ? optsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
				if (correctRaw) q.correct_answer = [correctRaw];
			} else if (type === 'scale_1_5') {
				const target = Number(correctRaw);
				if (Number.isFinite(target) && target >= 1 && target <= 5) {
					q.correct_answer = { target };
				}
			}
			questions.push(q);
		});
		return questions;
	}

	async function submitCreate(e) {
		e.preventDefault();
		const title = document.getElementById('cf-title').value.trim();
		const description = document.getElementById('cf-description').value.trim();
		const module_key = document.getElementById('cf-module').value;
		const assessment_type = document.getElementById('cf-type').value;
		const questions = collectQuestionsFromForm();
		if (!title) { showError(t('assess_err_title', 'Zadaj názov.')); return; }
		if (!questions.length) { showError(t('assess_err_no_questions', 'Pridaj aspoň jednu otázku.')); return; }
		try {
			await api('/api/assessments', {
				method: 'POST',
				body: JSON.stringify({ title, description, module_key, assessment_type, questions })
			});
			showTab('list');
		} catch (err) {
			showError(err.message);
		}
	}

	// ─── My results ────────────────────────────────────────────────────
	async function loadMyResults() {
		const container = document.getElementById('results-container');
		container.innerHTML = '<p class="assess-empty">' + esc(t('assess_loading', 'Načítavam...')) + '</p>';
		try {
			const { attempts, deltas } = await api('/api/assessment-results/me');
			const deltaHtml = renderDeltas(deltas);
			const attemptsHtml = attempts.length
				? attempts.map(renderAttempt).join('')
				: '<p class="assess-empty">' + esc(t('assess_no_attempts', 'Zatiaľ žiadne pokusy.')) + '</p>';
			container.innerHTML = [
				deltaHtml,
				'<h3>', esc(t('assess_all_attempts', 'Všetky pokusy')), '</h3>',
				attemptsHtml,
				'<p><a href="/api/assessment-results/export.csv" class="assess-btn secondary" download>',
					esc(t('assess_export_csv', '⬇ Stiahnuť CSV')),
				'</a></p>'
			].join('');
		} catch (e) {
			showError(e.message);
			container.innerHTML = '';
		}
	}

	function renderDeltas(deltas) {
		const keys = Object.keys(deltas || {});
		if (!keys.length) {
			return '<p class="assess-empty">' + esc(t('assess_no_delta', 'Zatiaľ žiadne pre/post porovnanie.')) + '</p>';
		}
		return [
			'<h3>', esc(t('assess_pre_post_delta', 'Pre/post zlepšenie')), '</h3>',
			keys.map(k => {
				const d = deltas[k];
				const cls = d.improved ? '' : ' regression';
				const label = t('assess_module_' + k, k);
				return [
					'<div class="delta-card', cls, '">',
					'<strong>', esc(label), '</strong>: ',
					esc(d.pre_percent), '% → ', esc(d.post_percent), '% ',
					'(', d.delta_percent >= 0 ? '+' : '', esc(d.delta_percent), ' pp)',
					'</div>'
				].join('');
			}).join('')
		].join('');
	}

	function renderAttempt(r) {
		const moduleLabel = t('assess_module_' + r.module_key, r.module_key);
		const typeLabel = t('assess_type_' + r.assessment_type, r.assessment_type);
		const dateStr = r.submitted_at
			? new Date(r.submitted_at).toLocaleString()
			: (r.status === 'in_progress' ? esc(t('assess_in_progress', '— prebieha —')) : '');
		return [
			'<div class="assess-card">',
			'<div class="assess-meta">',
				'<span class="assess-pill ', esc(r.assessment_type), '">', esc(typeLabel), '</span>',
				'<span class="assess-pill">', esc(moduleLabel), '</span>',
				'<span>', esc(dateStr), '</span>',
			'</div>',
			r.status === 'submitted'
				? '<p><strong>' + esc(r.total_score) + ' / ' + esc(r.max_score) + '</strong> · ' + esc(r.percent_score) + ' %</p>'
				: '<p>' + esc(t('assess_status_' + r.status, r.status)) + '</p>',
			'</div>'
		].join('');
	}

	// ─── Teacher summary ───────────────────────────────────────────────
	async function loadSummary() {
		const container = document.getElementById('summary-container');
		container.innerHTML = '<p class="assess-empty">' + esc(t('assess_loading', 'Načítavam...')) + '</p>';
		try {
			const { items } = await api('/api/assessment-results/summary');
			if (!items.length) {
				container.innerHTML = '<p class="assess-empty">' + esc(t('assess_no_summary', 'Ešte si nevytvoril žiaden assessment.')) + '</p>';
				return;
			}
			container.innerHTML = items.map(r => {
				const moduleLabel = t('assess_module_' + r.module_key, r.module_key);
				const typeLabel = t('assess_type_' + r.assessment_type, r.assessment_type);
				return [
					'<div class="assess-card">',
					'<h3>', esc(r.title), '</h3>',
					'<div class="assess-meta">',
						'<span class="assess-pill ', esc(r.assessment_type), '">', esc(typeLabel), '</span>',
						'<span class="assess-pill">', esc(moduleLabel), '</span>',
					'</div>',
					'<p>',
						esc(t('assess_attempts', 'Pokusov')), ': ', esc(r.attempt_count), ' · ',
						esc(t('assess_submitted', 'Odoslaných')), ': ', esc(r.submitted_count), ' · ',
						esc(t('assess_avg', 'Priemer')), ': ', esc(r.avg_percent == null ? '—' : (r.avg_percent + ' %')),
					'</p>',
					'</div>'
				].join('');
			}).join('');
		} catch (e) {
			showError(e.message);
			container.innerHTML = '';
		}
	}

	// ─── Boot ──────────────────────────────────────────────────────────
	function init() {
		bindTabs();
		document.getElementById('btn-add-question').addEventListener('click', addQuestionBlock);
		document.getElementById('create-form').addEventListener('submit', submitCreate);
		// Seed one question block so the user sees the form shape.
		addQuestionBlock();
		showTab('list');
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
