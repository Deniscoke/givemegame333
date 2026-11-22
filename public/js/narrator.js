/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Narrator module (SMARTA voice + facts, Phase 8)

   The SMARTA dock (js/smarta-dock.js) owns the UI. This module owns:
     • Narrator.fetchFact(opts)  — one educational fact (AI for Pro, local otherwise)
     • Narrator.speak(text, opts)— read aloud: premium TTS when the plan allows it,
                                    otherwise the free Web Speech voice
     • Narrator.tellFact(opts)   — fetchFact + speak + the "listened" coin reward
     • Narrator.stop(), Narrator.getStyles(), Narrator.getArea()
   The right-panel SMARTA tab only holds settings (area and style pickers).

   Dependencies (globals resolved at call-time, not load-time):
     • ngrokHeaders()      — defined in script.js (top-level)
     • GameUI.toast()      — defined in script.js (top-level)
     • window.Coins        — defined in public/js/coins.js
     • window.givemegame_t — set by App.setLang() in script.js
     • window.givemegame_currentLang — set by App.setLang() in script.js

   Speaking state is broadcast as the window event "givemegame:smarta-speaking"
   ({ detail: { speaking } }) so the dock can animate the portrait.

   Exposes: window.Narrator  (also assigned to const Narrator in script.js)
   ═══════════════════════════════════════════════════════════════════ */

// Denný limit: max 10 zaujímavostí na Smartu na používateľa (coiny navyše kryje denný strop na serveri).
const SMARTA_DAILY_LIMIT = 10;
const SMARTA_USAGE_KEY = 'givemegame_smarta_usage';
const SMARTA_STYLES_KEY = 'givemegame_smarta_styles';
const SMARTA_TTS_REFUSED_KEY = 'givemegame_smarta_tts_refused';

async function narratorAuthHeaders() {
	const headers = { ...(typeof ngrokHeaders === 'function' ? ngrokHeaders() : {}), 'Content-Type': 'application/json' };
	try {
		if (typeof supabaseClient !== 'undefined' && supabaseClient?.auth) {
			const { data: { session } } = await Promise.race([
				supabaseClient.auth.getSession(),
				new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
			]);
			if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
		}
	} catch (e) { /* ignore */ }
	return headers;
}

function narratorUid() {
	try {
		const raw = sessionStorage.getItem('givemegame_user');
		const u = raw ? JSON.parse(raw) : null;
		return (u?.uid && u.uid !== 'guest') ? u.uid : 'anon';
	} catch { return 'anon'; }
}

function getSmartaStylesKey() { return SMARTA_STYLES_KEY + '_' + narratorUid(); }
function getSmartaUsageKey() { return SMARTA_USAGE_KEY + '_' + narratorUid(); }

function getSmartaUsage() {
	const key = getSmartaUsageKey();
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return { date: '', count: 0 };
		const o = JSON.parse(raw);
		const today = new Date().toISOString().slice(0, 10);
		if (o.date !== today) return { date: today, count: 0 };
		return { date: o.date, count: Math.max(0, parseInt(o.count, 10) || 0) };
	} catch { return { date: new Date().toISOString().slice(0, 10), count: 0 }; }
}

function incrementSmartaUsage() {
	const key = getSmartaUsageKey();
	const today = new Date().toISOString().slice(0, 10);
	const curr = getSmartaUsage();
	const newCount = (curr.date === today ? curr.count : 0) + 1;
	try {
		localStorage.setItem(key, JSON.stringify({ date: today, count: newCount }));
	} catch (e) {}
}

function canUseSmarta() {
	const u = getSmartaUsage();
	const today = new Date().toISOString().slice(0, 10);
	if (u.date !== today) return true;
	return u.count < SMARTA_DAILY_LIMIT;
}

const Narrator = (() => {
	let speechSynth = null;
	let currentAudio = null;
	let currentAudioUrl = null;
	let safetyTimer = null;
	let finishCurrent = null; // ends the playback in progress (resolves its promise)
	let premiumDisabledInPage = false; // 502/503 or a blocked play(): stop trying until reload
	let localFacts = { sk: [], cs: [], en: [], es: [] };
	const FALLBACK_FACTS = {
		sk: ['Medúzy existujú na Zemi už viac ako 650 miliónov rokov – sú staršie ako dinosaury!', 'Včely komunikujú tancom.'],
		cs: ['Medúzy existují na Zemi už více než 650 milionů let – jsou starší než dinosauři!', 'Včely komunikují tancem.'],
		de: ['Quallen gibt es seit über 650 Millionen Jahren auf der Erde – älter als Dinosaurier!', 'Bienen kommunizieren durch Tanz.'],
		en: ['Jellyfish have existed on Earth for over 650 million years – older than dinosaurs!', 'Bees communicate through dance.'],
		es: ['Las medusas existen en la Tierra desde hace más de 650 millones de años.', 'Las abejas se comunican bailando.']
	};
	const _t = (k, f) => (window.givemegame_t || ((key, fb) => fb || key))(k, f);

	async function loadLocalFacts() {
		try {
			const res = await fetch('data/narrator-facts.json', { headers: ngrokHeaders() });
			if (res.ok) localFacts = await res.json();
		} catch (e) { /* optional */ }
	}

	function getRandomLocalFact(lang) {
		const arr = localFacts[lang] || localFacts.sk;
		if (arr && arr.length > 0) return arr[Math.floor(Math.random() * arr.length)];
		const fallback = FALLBACK_FACTS[lang] || FALLBACK_FACTS.sk;
		return fallback[Math.floor(Math.random() * fallback.length)];
	}

	function getLangBcp47(lang) {
		return window.ReadAloud ? window.ReadAloud.langToBcp47(lang) : (lang === 'sk' ? 'sk-SK' : lang === 'cs' ? 'cs-CZ' : lang === 'de' ? 'de-DE' : lang === 'es' ? 'es-ES' : lang === 'tr' ? 'tr-TR' : 'en-US');
	}

	function currentLang() {
		const langMap = { sk: 'sk', cs: 'cs', de: 'de', en: 'en', es: 'es', tr: 'tr' };
		const active = document.querySelector('.btn-lang.active')?.dataset?.lang || window.givemegame_currentLang || 'sk';
		return langMap[active] || 'sk';
	}

	function getPreferredVoice(lang) {
		if (!speechSynth) return null;
		const voices = speechSynth.getVoices();
		const bcp = getLangBcp47(lang);
		const langCode = bcp.split('-')[0].toLowerCase();
		return voices.find(v => v.lang.toLowerCase() === bcp.toLowerCase())
			|| voices.find(v => v.lang.toLowerCase().startsWith(langCode))
			|| voices.find(v => /en/i.test(v.lang))
			|| null;
	}

	// Intonácia pre Web Speech fallback — charakteristické črty typov osobnosti (prvý štýl dominuje)
	const TTS_FALLBACK_PARAMS = {
		sangvinik: { rate: 1.1, pitch: 1.05 },
		flegmatik: { rate: 0.85, pitch: 0.95 },
		cholerik: { rate: 1.15, pitch: 1.08 },
		melancholik: { rate: 0.9, pitch: 0.92 },
		genz: { rate: 1.02, pitch: 1 }
	};
	function getTtsParamsForStyles(styles = []) {
		const first = styles.find(s => TTS_FALLBACK_PARAMS[s]);
		if (first) return TTS_FALLBACK_PARAMS[first];
		return { rate: 0.95, pitch: 1 };
	}

	// ─── Premium TTS refusal cache ───
	// Free users get 401/403 from /api/tts. Remember that for the whole browser
	// session (per account) so we never ask again.
	function ttsRefusedKey() { return SMARTA_TTS_REFUSED_KEY + '_' + narratorUid(); }
	function isTtsRefused() {
		if (premiumDisabledInPage) return true;
		try { return sessionStorage.getItem(ttsRefusedKey()) === '1'; } catch { return false; }
	}
	function rememberTtsRefusal() {
		try { sessionStorage.setItem(ttsRefusedKey(), '1'); } catch (e) {}
	}

	function setSpeaking(on) {
		try { window.dispatchEvent(new CustomEvent('givemegame:smarta-speaking', { detail: { speaking: !!on } })); } catch (e) {}
	}

	function cleanupAudio() {
		if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio.onended = null; currentAudio.onerror = null; currentAudio = null; }
		if (currentAudioUrl) { try { URL.revokeObjectURL(currentAudioUrl); } catch (e) {} currentAudioUrl = null; }
	}

	/** Stop whatever SMARTA is saying right now. */
	function stop() {
		if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
		cleanupAudio();
		if (speechSynth) { try { speechSynth.cancel(); } catch (e) {} }
		if (finishCurrent) { const f = finishCurrent; finishCurrent = null; f(false); }
		setSpeaking(false);
	}

	/**
	 * Read text aloud.
	 * @param {string} text
	 * @param {{ lang?: string, styles?: string[], voice?: 'auto'|'browser', muted?: boolean }} [opts]
	 *   voice 'browser' never calls the server; muted skips the sound completely.
	 * @returns {Promise<'premium'|'browser'|'muted'|'none'>} resolves when the speech has ended
	 */
	async function speak(text, opts = {}) {
		const clean = String(text || '').trim();
		if (!clean) return 'none';
		if (opts.muted) return 'muted';
		stop();
		const lang = opts.lang || currentLang();
		const styles = Array.isArray(opts.styles) ? opts.styles : [];

		return new Promise(async (resolve) => {
			let done = false;
			const finish = (completed, mode) => {
				if (done) return;
				done = true;
				if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
				cleanupAudio();
				finishCurrent = null;
				setSpeaking(false);
				resolve(completed ? mode : 'none');
			};
			finishCurrent = (completed) => finish(completed, 'none');
			const armSafety = () => {
				if (safetyTimer) clearTimeout(safetyTimer);
				safetyTimer = setTimeout(() => { safetyTimer = null; finish(true, 'none'); }, Math.max(20000, clean.length * 120));
			};

			// 1. Premium TTS (Pro plan). Skipped for anonymous users, for the "browser voice"
			//    setting and after a refusal — no request, so no 401/403 noise.
			if (opts.voice !== 'browser' && !isTtsRefused()) {
				try {
					const headers = await narratorAuthHeaders();
					if (!headers.Authorization) {
						// anonymous: nothing to cache, just do not ask
					} else {
						const ctrl = new AbortController();
						const to = setTimeout(() => ctrl.abort(), 8000);
						const res = await fetch('/api/tts', {
							method: 'POST',
							headers,
							body: JSON.stringify({ text: clean, voice: 'marin', styles }),
							signal: ctrl.signal
						});
						clearTimeout(to);
						if (done) return;
						if (res.ok) {
							const blob = await res.blob();
							if (done) return;
							const url = URL.createObjectURL(blob);
							currentAudioUrl = url;
							const audio = new Audio(url);
							currentAudio = audio;
							audio.onended = () => finish(true, 'premium');
							audio.onerror = () => finish(true, 'premium');
							try {
								armSafety();
								setSpeaking(true);
								await audio.play();
								return;
							} catch (playErr) {
								premiumDisabledInPage = true;
								cleanupAudio();
							}
						} else if (res.status === 401 || res.status === 403) {
							rememberTtsRefusal();
						} else if (res.status === 502 || res.status === 503) {
							premiumDisabledInPage = true;
						}
					}
				} catch (err) {
					if (err?.name === 'AbortError') console.warn('[Narrator] TTS timeout — Web Speech');
					premiumDisabledInPage = true;
				}
			}
			if (done) return;

			// 2. Free voice: Web Speech API, intonation by style
			if (speechSynth) {
				speechSynth.cancel();
				const u = new SpeechSynthesisUtterance(clean);
				u.lang = getLangBcp47(lang);
				const { rate, pitch } = getTtsParamsForStyles(styles);
				u.rate = rate;
				u.pitch = pitch;
				const preferred = getPreferredVoice(lang);
				if (preferred) u.voice = preferred;
				armSafety();
				u.onend = () => finish(true, 'browser');
				u.onerror = () => finish(true, 'browser');
				setSpeaking(true);
				speechSynth.speak(u);
			} else {
				finish(false, 'none');
			}
		});
	}

	function getStyles() {
		return Array.from(document.querySelectorAll('input[name="narrator-style"]:checked')).map(cb => cb.value).filter(Boolean);
	}
	function getArea() {
		return document.getElementById('narrator-area')?.value || '';
	}

	/**
	 * One educational fact. Pro users get an AI fact, everyone else a local one.
	 * @returns {Promise<{ fact: string, source: 'openai'|'local', planGate?: string, limited?: boolean }>}
	 */
	async function fetchFact(opts = {}) {
		const lang = opts.lang || currentLang();
		const area = opts.area !== undefined ? opts.area : getArea();
		const styles = Array.isArray(opts.styles) ? opts.styles : getStyles();
		if (!canUseSmarta()) return { fact: '', source: 'local', limited: true };

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 15000);
		let fact = '';
		let source = 'local';
		let planGate;
		try {
			let url = `/api/random-fact?lang=${lang}`;
			if (area) url += `&area=${encodeURIComponent(area)}`;
			if (styles.length) url += '&style=' + encodeURIComponent(styles.join(','));
			const res = await fetch(url, { headers: await narratorAuthHeaders(), signal: controller.signal });
			const data = await res.json().catch(() => ({}));
			fact = data?.fact || '';
			source = data?.source === 'openai' ? 'openai' : 'local';
			planGate = data?.planGate;
			if (source === 'local' && data?._debug) console.error('[Narrator] OpenAI zlyhalo:', data._debug);
		} catch (err) {
			console.warn('[Narrator]', err?.name === 'AbortError' ? 'timeout' : err);
		} finally {
			clearTimeout(timeoutId);
		}
		if (!fact) { fact = getRandomLocalFact(lang); source = 'local'; }
		if (!fact) throw new Error('Žiadna zaujímavosť');
		incrementSmartaUsage();
		refreshHint();
		return { fact, source, planGate };
	}

	/**
	 * Fact + voice + the one-time "listened" coin reward (the server caps it per day).
	 * @param {{ lang?: string, area?: string, styles?: string[], voice?: 'auto'|'browser', muted?: boolean,
	 *           onFact?: (r: { fact: string, source: string }) => void }} [opts]
	 */
	async function tellFact(opts = {}) {
		const styles = Array.isArray(opts.styles) ? opts.styles : getStyles();
		const r = await fetchFact({ ...opts, styles });
		if (r.limited) {
			GameUI.toast(_t('smarta_limit_reached', `Dnes si použil/a Smartu ${SMARTA_DAILY_LIMIT}×. Skús zajtra!`));
			return r;
		}
		if (opts.onFact) opts.onFact(r);
		const mode = await speak(r.fact, { lang: opts.lang, styles, voice: opts.voice, muted: opts.muted });
		if (mode === 'premium' || mode === 'browser') {
			try {
				// window.Coins is set by coins.js (loads before narrator is ever called)
				if (window.Coins?.award) window.Coins.award('narrator_fact');
			} catch (e) { console.warn('[Narrator] Coins.award:', e); }
			GameUI.toast(`🪙 +50 gIVEMECOIN! ${_t('narrator_listened', 'Vypočutá zaujímavosť!')}`);
		}
		return { ...r, spoken: mode };
	}

	function fillAreas(sel, areas) {
		sel.textContent = '';
		for (const a of areas) {
			const o = document.createElement('option');
			o.value = a.id;
			o.textContent = a.name;
			sel.appendChild(o);
		}
	}

	async function loadNarratorAreas() {
		const sel = document.getElementById('narrator-area');
		if (!sel) return;
		try {
			const res = await fetch('/api/narrator-areas', { headers: ngrokHeaders() });
			if (res.ok) {
				const { areas } = await res.json();
				fillAreas(sel, areas);
				return;
			}
		} catch (e) { console.warn('[Narrator] Areas API:', e); }
		try {
			const rvpRes = await fetch('data/rvp.json', { headers: ngrokHeaders() });
			if (rvpRes.ok) {
				const rvp = await rvpRes.json();
				const areas = [{ id: '', name: 'Náhodná oblasť' }];
				if (rvp.vzdelavaci_oblasti) {
					for (const [id, v] of Object.entries(rvp.vzdelavaci_oblasti)) areas.push({ id, name: v.nazev });
				}
				if (rvp.kompetence) {
					for (const [id, v] of Object.entries(rvp.kompetence)) areas.push({ id: 'komp-' + id, name: v.nazev });
				}
				if (rvp.prurezova_temata) {
					for (const [id, name] of Object.entries(rvp.prurezova_temata)) areas.push({ id: 'tema-' + id, name });
				}
				fillAreas(sel, areas);
			}
		} catch (e) { console.warn('[Narrator] Areas fallback:', e); }
	}

	/** Usage counter ("3/10 dnes") in the settings tab, when it is on the page. */
	function refreshHint() {
		const el = document.getElementById('smarta-usage-hint');
		if (!el) return;
		const u = getSmartaUsage();
		el.textContent = (_t('smarta_usage_hint', '{count}/{limit} dnes')).replace('{count}', u.count).replace('{limit}', SMARTA_DAILY_LIMIT);
	}

	function loadSmartaStyles() {
		const key = getSmartaStylesKey();
		try {
			const raw = localStorage.getItem(key);
			const saved = raw ? JSON.parse(raw) : [];
			if (!Array.isArray(saved)) return;
			document.querySelectorAll('input[name="narrator-style"]').forEach(cb => {
				cb.checked = saved.includes(cb.value);
			});
		} catch (e) {}
	}

	function saveSmartaStyles() {
		const checked = getStyles();
		const key = getSmartaStylesKey();
		try { localStorage.setItem(key, JSON.stringify(checked)); } catch (e) {}
		try { window.dispatchEvent(new CustomEvent('givemegame:smarta-styles', { detail: { styles: checked } })); } catch (e) {}
	}

	function init() {
		speechSynth = window.speechSynthesis;
		if (speechSynth) {
			speechSynth.onvoiceschanged = () => {};
			speechSynth.getVoices();
		}
		loadLocalFacts();
		loadNarratorAreas();
		loadSmartaStyles();
		document.querySelectorAll('input[name="narrator-style"]').forEach(cb => {
			cb.addEventListener('change', saveSmartaStyles);
		});
		refreshHint();
	}

	return { init, refreshHint, loadSmartaStyles, speak, stop, fetchFact, tellFact, getStyles, getArea, getRandomLocalFact, isTtsRefused };
})();

// Expose globally so App can reference it as `const Narrator = window.Narrator`
window.Narrator = Narrator;
