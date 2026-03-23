/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Narrator module (extracted from script.js Phase 1)

   Dependencies (globals resolved at call-time, not load-time):
     • ngrokHeaders()      — defined in script.js (top-level)
     • GameUI.toast()      — defined in script.js (top-level)
     • window.Coins        — defined in public/js/coins.js
     • window.givemegame_t — set by App.setLang() in script.js
     • window.givemegame_currentLang — set by App.setLang() in script.js

   Exposes: window.Narrator  (also assigned to const Narrator in script.js)
   ═══════════════════════════════════════════════════════════════════ */

// ─── Narrator — AI vypraváč (ako Dračí Hlídka: OpenAI TTS + fallback Web Speech)
// Denný limit: max 10 použití na Smartu na používateľa
const SMARTA_DAILY_LIMIT = 10;
const SMARTA_USAGE_KEY = 'givemegame_smarta_usage';
const SMARTA_STYLES_KEY = 'givemegame_smarta_styles';

function getSmartaStylesKey() {
	try {
		const raw = sessionStorage.getItem('givemegame_user');
		const u = raw ? JSON.parse(raw) : null;
		const uid = (u?.uid && u.uid !== 'guest') ? u.uid : 'anon';
		return SMARTA_STYLES_KEY + '_' + uid;
	} catch { return SMARTA_STYLES_KEY + '_anon'; }
}

function getSmartaUsageKey() {
	try {
		const raw = sessionStorage.getItem('givemegame_user');
		const u = raw ? JSON.parse(raw) : null;
		const uid = (u?.uid && u.uid !== 'guest') ? u.uid : 'anon';
		return SMARTA_USAGE_KEY + '_' + uid;
	} catch { return SMARTA_USAGE_KEY + '_anon'; }
}

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
	let awardedForCurrent = false;
	let usePremiumTts = null; // null = skúsiť, true = OK, false = fallback
	let localFacts = { sk: [], cs: [], en: [], es: [] };
	const FALLBACK_FACTS = {
		sk: ['Medúzy existujú na Zemi už viac ako 650 miliónov rokov – sú staršie ako dinosaury!', 'Včely komunikujú tancom.'],
		cs: ['Medúzy existují na Zemi už více než 650 milionů let – jsou starší než dinosauři!', 'Včely komunikují tancem.'],
		de: ['Quallen gibt es seit über 650 Millionen Jahren auf der Erde – älter als Dinosaurier!', 'Bienen kommunizieren durch Tanz.'],
		en: ['Jellyfish have existed on Earth for over 650 million years – older than dinosaurs!', 'Bees communicate through dance.'],
		es: ['Las medusas existen en la Tierra desde hace más de 650 millones de años.', 'Las abejas se comunican bailando.']
	};

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
		return lang === 'sk' ? 'sk-SK' : lang === 'cs' ? 'cs-CZ' : lang === 'de' ? 'de-DE' : lang === 'es' ? 'es-ES' : 'en-US';
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

	async function loadNarratorAreas() {
		const sel = document.getElementById('narrator-area');
		if (!sel) return;
		try {
			const res = await fetch('/api/narrator-areas', { headers: ngrokHeaders() });
			if (res.ok) {
				const { areas } = await res.json();
				sel.innerHTML = areas.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
				return;
			}
		} catch (e) { console.warn('[Narrator] Areas API:', e); }
		try {
			const rvpRes = await fetch('data/rvp.json', { headers: ngrokHeaders() });
			if (rvpRes.ok) {
				const rvp = await rvpRes.json();
				const areas = [{ id: '', name: 'Náhodná oblasť' }];
				if (rvp.vzdelavaci_oblasti) {
					for (const [id, v] of Object.entries(rvp.vzdelavaci_oblasti)) {
						areas.push({ id, name: v.nazev });
					}
				}
				if (rvp.kompetence) {
					for (const [id, v] of Object.entries(rvp.kompetence)) {
						areas.push({ id: 'komp-' + id, name: v.nazev });
					}
				}
				if (rvp.prurezova_temata) {
					for (const [id, name] of Object.entries(rvp.prurezova_temata)) {
						areas.push({ id: 'tema-' + id, name });
					}
				}
				sel.innerHTML = areas.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
			}
		} catch (e) { console.warn('[Narrator] Areas fallback:', e); }
	}

	function refreshHint() {
		const btn = document.getElementById('narrator-bot');
		const hint = btn?.querySelector('.narrator-hint');
		if (!hint) return;
		const _t = window.givemegame_t || ((k, f) => f || k);
		const u = getSmartaUsage();
		// Vždy zobrazovať X/10 dnes, aby bol limit viditeľný
		hint.textContent = (_t('smarta_usage_hint', '{count}/{limit} dnes')).replace('{count}', u.count).replace('{limit}', SMARTA_DAILY_LIMIT);
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
		const checked = Array.from(document.querySelectorAll('input[name="narrator-style"]:checked')).map(cb => cb.value);
		const key = getSmartaStylesKey();
		try {
			localStorage.setItem(key, JSON.stringify(checked));
		} catch (e) {}
	}

	function init() {
		speechSynth = window.speechSynthesis;
		if (speechSynth) {
			speechSynth.onvoiceschanged = () => {};
			speechSynth.getVoices();
		}
		loadLocalFacts();
		loadNarratorAreas();
		const btn = document.getElementById('narrator-bot');
		const hint = btn?.querySelector('.narrator-hint');
		if (!btn) return;
		loadSmartaStyles();
		document.querySelectorAll('input[name="narrator-style"]').forEach(cb => {
			cb.addEventListener('change', saveSmartaStyles);
		});
		btn.addEventListener('click', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (hint) hint.textContent = 'Načítavam...';
			try {
				await onNarratorClick();
			} finally {
				refreshHint();
			}
		});
		refreshHint();
	}

	let playbackEndTimeout = null;
	function onPlaybackEnd(btn) {
		if (playbackEndTimeout) { clearTimeout(playbackEndTimeout); playbackEndTimeout = null; }
		if (btn) btn.classList.remove('speaking');
		if (!awardedForCurrent) {
			awardedForCurrent = true;
			try {
				// window.Coins is set by coins.js (loads before narrator is ever called)
				if (window.Coins?.award) window.Coins.award('narrator_fact');
			} catch (e) { console.warn('[Narrator] Coins.award:', e); }
			GameUI.toast(`🪙 +50 gIVEMECOIN! ${(window.givemegame_t || ((k,f)=>f||k))('narrator_listened', 'Vypočutá zaujímavosť!')}`);
		}
		refreshHint();
		btn.disabled = false;
	}
	function schedulePlaybackEndSafety(btn, ms = 30000) {
		if (playbackEndTimeout) clearTimeout(playbackEndTimeout);
		playbackEndTimeout = setTimeout(() => {
			playbackEndTimeout = null;
			if (btn && btn.disabled) {
				console.warn('[Narrator] Safety timeout — re-enabling button');
				onPlaybackEnd(btn);
			}
		}, ms);
	}

	async function speakAndAward(fact, lang, btn, factEl, styles = []) {
		if (factEl) {
			factEl.classList.remove('narrator-fact-placeholder');
			factEl.setAttribute('aria-hidden', 'true');
			factEl.innerHTML = '';
			const p = document.createElement('p');
			p.textContent = fact;
			p.style.margin = '0';
			p.setAttribute('aria-hidden', 'true');
			factEl.appendChild(p);
		}

		// 1. Skúsiť OpenAI TTS (ako Dračí Hlídka) — s intonáciou podľa typu osobnosti
		if (usePremiumTts !== false) {
			try {
				const TTS_TIMEOUT_MS = 8000;
				const ctrl = new AbortController();
				const to = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
				const res = await fetch('/api/tts', {
					method: 'POST',
					headers: { ...ngrokHeaders(), 'Content-Type': 'application/json' },
					body: JSON.stringify({ text: fact, voice: 'marin', styles: Array.isArray(styles) ? styles : [] }),
					signal: ctrl.signal
				});
				clearTimeout(to);
				if (res.ok) {
					const blob = await res.blob();
					const url = URL.createObjectURL(blob);
					const audio = new Audio(url);
					schedulePlaybackEndSafety(btn);
					audio.onended = () => {
						URL.revokeObjectURL(url);
						onPlaybackEnd(btn);
					};
					audio.onerror = () => {
						URL.revokeObjectURL(url);
						onPlaybackEnd(btn);
					};
					try {
						btn.classList.add('speaking');
						await audio.play();
						usePremiumTts = true;
						return;
					} catch (playErr) {
						URL.revokeObjectURL(url);
						usePremiumTts = false;
					}
				} else {
					if (res.status === 503 || res.status === 502) usePremiumTts = false;
				}
			} catch (err) {
				if (err?.name === 'AbortError') console.warn('[Narrator] TTS timeout — fallback na Web Speech');
				usePremiumTts = false;
			}
		}

		// 2. Fallback: Web Speech API s výberom hlasu — intonácia podľa štýlu
		if (speechSynth) {
			speechSynth.cancel();
			const u = new SpeechSynthesisUtterance(fact);
			u.lang = getLangBcp47(lang);
			const { rate, pitch } = getTtsParamsForStyles(styles);
			u.rate = rate;
			u.pitch = pitch;
			const preferred = getPreferredVoice(lang);
			if (preferred) u.voice = preferred;
			schedulePlaybackEndSafety(btn);
			u.onend = () => onPlaybackEnd(btn);
			u.onerror = () => onPlaybackEnd(btn);
			btn.classList.add('speaking');
			speechSynth.speak(u);
		} else {
			GameUI.toast((window.givemegame_t || ((k,f)=>f||k))('narrator_no_tts', 'Tento prehliadač nepodporuje hlasový výstup.'));
			btn.disabled = false;
		}
	}

	async function onNarratorClick() {
		const btn = document.getElementById('narrator-bot');
		const factEl = document.getElementById('narrator-fact');
		if (!btn) return;

		if (!canUseSmarta()) {
			const _t = window.givemegame_t || ((k,f)=>f||k);
			GameUI.toast(_t('smarta_limit_reached', `Dnes si použil/a Smartu ${SMARTA_DAILY_LIMIT}×. Skús zajtra!`));
			refreshHint();
			return;
		}

		btn.disabled = true;
		if (factEl) {
			factEl.classList.add('narrator-fact-placeholder');
			factEl.innerHTML = '<i class="bi bi-hourglass-split"></i><span>Načítavam...</span>';
		}
		awardedForCurrent = false;

		const langMap = { sk: 'sk', cs: 'cs', de: 'de', en: 'en', es: 'es' };
		const activeLang = document.querySelector('.btn-lang.active')?.dataset?.lang || window.givemegame_currentLang || 'cs';
		const lang = langMap[activeLang] || 'sk';
		const areaEl = document.getElementById('narrator-area');
		const area = areaEl?.value || '';
		const styleCheckboxes = document.querySelectorAll('input[name="narrator-style"]:checked');
		const styles = Array.from(styleCheckboxes).map(cb => cb.value).filter(Boolean);

		const TIMEOUT_MS = 15000;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

		try {
			let url = `/api/random-fact?lang=${lang}`;
			if (area) url += `&area=${encodeURIComponent(area)}`;
			if (styles.length) url += '&style=' + encodeURIComponent(styles.join(','));
			const res = await fetch(url, {
				headers: ngrokHeaders(),
				signal: controller.signal
			});
			clearTimeout(timeoutId);
			const data = await res.json().catch(() => ({}));
			let fact = data?.fact;
			const source = data?.source || 'local';
			if (!fact && !res.ok) {
				console.warn('[Narrator] API error:', res.status, data?.error);
			}
			if (source === 'local' && data?._debug) {
				console.error('[Narrator] OpenAI zlyhalo:', data._debug);
				GameUI.toast('⚠️ AI nedostupná: ' + (data._debug || '').slice(0, 60) + '…');
			}
			if (!fact) fact = getRandomLocalFact(lang);
			if (!fact) throw new Error('Žiadna zaujímavosť');

			incrementSmartaUsage();

			console.log('[Narrator] Zaujímavosť:', source === 'openai' ? '🤖 AI (OpenAI)' : '📋 Lokál');

			// 1. Najprv zobraz text dole (výstup) — používateľ vidí zaujímavosť hneď
			if (factEl) {
				factEl.classList.remove('narrator-fact-placeholder');
				factEl.innerHTML = '';
				const p = document.createElement('p');
				p.textContent = fact;
				p.style.margin = '0';
				factEl.appendChild(p);
				const badge = document.createElement('span');
				badge.className = 'narrator-source-badge';
				badge.textContent = source === 'openai' ? '🤖 AI' : '📋 Lokál';
				badge.title = source === 'openai' ? 'Vygenerované OpenAI' : 'Lokálna zaujímavosť';
				factEl.appendChild(badge);
			}

			// 2. Potom prečítaj nahlas (TTS alebo Web Speech) — s intonáciou podľa štýlu
			await speakAndAward(fact, lang, btn, null, styles);
		} catch (err) {
			clearTimeout(timeoutId);
			console.warn('[Narrator]', err);
			const fact = getRandomLocalFact(lang);
			if (fact) {
				incrementSmartaUsage();
				if (factEl) {
					factEl.classList.remove('narrator-fact-placeholder');
					factEl.innerHTML = '';
					const p = document.createElement('p');
					p.textContent = fact;
					p.style.margin = '0';
					factEl.appendChild(p);
					const badge = document.createElement('span');
					badge.className = 'narrator-source-badge';
					badge.textContent = '📋 Lokál';
					badge.title = 'Lokálna zaujímavosť (API zlyhalo)';
					factEl.appendChild(badge);
				}
				await speakAndAward(fact, lang, btn, null, styles);
			} else {
				if (factEl) {
					factEl.classList.add('narrator-fact-placeholder');
					const _t = window.givemegame_t || ((k,f)=>f||k);
					factEl.innerHTML = '<i class="bi bi-exclamation-triangle"></i><span>' + (err.name === 'AbortError' ? _t('narrator_timeout', 'Čas vypršal – skús znova') : (err.message || 'Chyba')) + '</span>';
				}
				const _t = window.givemegame_t || ((k,f)=>f||k);
				GameUI.toast(err.name === 'AbortError' ? _t('narrator_timeout', 'Čas vypršal – skús znova') : (err.message || 'Chyba načítania.'));
				btn.disabled = false;
			}
		}
	}

	return { init, refreshHint, loadSmartaStyles };
})();

// Expose globally so App can reference it as `const Narrator = window.Narrator`
window.Narrator = Narrator;
