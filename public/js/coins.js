/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Coins module (extracted from script.js Phase 1)

   Dependencies (globals resolved at call-time, not load-time):
     • supabaseClient      — var declared in script.js (top-level)
     • supabaseProfilesOk  — var declared in script.js (top-level)
     • getCurrentUser()    — function declared in script.js (top-level)

   Exposes: window.Coins  (also bridged inside App as `const Coins = window.Coins`)
   ═══════════════════════════════════════════════════════════════════ */

// ─── Coin systém — gIVEMECOIN (localStorage = hlavný zdroj, Supabase = sync pre prihlásených) ───
const Coins = (() => {
	const STORAGE_KEY = 'givemegame_coins';
	let balance = 0;

	const rewards = {
		timer: 500,
		robot_challenge: 250,
		mode_click: 1,
		tamagochi_coin: 1,
		phone_buzz: 5,
		narrator_fact: 50   // AI vypraváč — vypočuj si zaujímavosť
	};

	const costs = {
		generate: 125,
		surprise: 50
	};

	async function load() {
		// 1. VŽDY načítaj z localStorage (pretrvá pri refreshi)
		let fromStorage = Math.max(0, parseInt(localStorage.getItem(STORAGE_KEY)) || 0);
		// Starter coiny pre nových používateľov (aby mohli generovať prvú hru)
		if (fromStorage === 0 && !localStorage.getItem(STORAGE_KEY + '_init')) {
			fromStorage = 150;
			localStorage.setItem(STORAGE_KEY, '150');
			localStorage.setItem(STORAGE_KEY + '_init', '1');
		}

		const user = getCurrentUser();
		if (user && user.uid !== 'guest' && supabaseClient && supabaseProfilesOk) {
			try {
				const { data, error } = await supabaseClient.from('profiles').select('coins').eq('id', user.uid).single();
				if (error) { supabaseProfilesOk = false; balance = fromStorage; }
				else {
					const fromSupabase = Math.max(0, parseInt(data?.coins) || 0);
					balance = Math.max(fromSupabase, fromStorage);
					if (balance > fromSupabase) save();
				}
			} catch (e) {
				supabaseProfilesOk = false;
				balance = fromStorage;
			}
		} else {
			balance = fromStorage;
		}
		// DÔLEŽITÉ: Vždy ulož balance do localStorage ako zálohu — inak pri ďalšom načítaní
		// (ak Supabase zlyhá alebo session nie je ešte pripravená) by sa coiny stratili
		try { localStorage.setItem(STORAGE_KEY, String(balance)); } catch (e) {}
		updateDisplay();
	}

	function save() {
		// 1. VŽDY ulož do localStorage (okamžite — pretrvá pri refreshi)
		try { localStorage.setItem(STORAGE_KEY, String(balance)); } catch (e) {}

		const user = getCurrentUser();
		if (user && user.uid !== 'guest' && supabaseClient && supabaseProfilesOk) {
			supabaseClient.from('profiles').upsert({
				id: user.uid,
				coins: balance,
				display_name: user.name || null,
				avatar_url: user.photo || null,
				updated_at: new Date().toISOString()
			}, { onConflict: 'id' }).then(({ error }) => {
				if (error) supabaseProfilesOk = false;
			}).catch(() => { supabaseProfilesOk = false; });
		}
	}

	async function logTransaction(amount, action) {
		if (!supabaseClient) return;
		try {
			const { data: { session } } = await Promise.race([
				supabaseClient.auth.getSession(),
				new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
			]);
			if (!session?.access_token) return;
			fetch('/api/coins/log', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
				body: JSON.stringify({ amount, action })
			}).catch(() => {});
		} catch {}
	}

	function award(source) {
		const amount = rewards[source] || 1;
		balance += amount;
		save();
		updateDisplay();
		logTransaction(amount, source);

		// Pop animation
		const display = document.getElementById('coin-display');
		if (display) {
			display.classList.remove('coin-awarded');
			void display.offsetWidth; // Force reflow
			display.classList.add('coin-awarded');
		}

		// Coin sound (short retro "pling")
		playCoinSound();

		console.log(`[Coins] +${amount} (${source}) → balance: ${balance}`);
	}

	// ─── Mode-specific coin sound profiles ───
	const coinSoundProfiles = {
		party: {
			type: 'square',      // 8-bit arcade vibe
			notes: [987.77, 1318.51, 1567.98],  // B5→E6→G6 (major fanfare)
			step: 0.06, volume: 0.08, duration: 0.25
		},
		classroom: {
			type: 'triangle',    // Soft school-bell chime
			notes: [523.25, 659.25, 783.99],     // C5→E5→G5 (clean major triad)
			step: 0.07, volume: 0.10, duration: 0.30
		},
		reflection: {
			type: 'sine',        // Warm singing-bowl tone
			notes: [440, 554.37, 659.25],        // A4→C#5→E5 (gentle A-major)
			step: 0.10, volume: 0.07, duration: 0.40
		},
		circus: {
			type: 'sawtooth',    // Whimsical calliope organ
			notes: [783.99, 987.77, 1174.66, 1318.51], // G5→B5→D6→E6 (playful run)
			step: 0.05, volume: 0.06, duration: 0.28
		},
		cooking: {
			type: 'triangle',    // Kitchen timer ding
			notes: [1046.50, 1318.51, 1046.50],  // C6→E6→C6 (ding-ding-ding)
			step: 0.06, volume: 0.09, duration: 0.25
		},
		meditation: {
			type: 'sine',        // Zen bowl — slow, deep, resonant
			notes: [293.66, 349.23],             // D4→F4 (minor second, contemplative)
			step: 0.15, volume: 0.06, duration: 0.55
		}
	};

	let _sharedAudioContext = null;
	function getSharedAudioContext() {
		if (!_sharedAudioContext) _sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
		return _sharedAudioContext;
	}
	function playCoinSound() {
		try {
			const profiles = Object.values(coinSoundProfiles);
			const profile = profiles[Math.floor(Math.random() * profiles.length)];
			const ac = getSharedAudioContext();
			const osc = ac.createOscillator();
			const gain = ac.createGain();
			osc.connect(gain);
			gain.connect(ac.destination);

			osc.type = profile.type;

			// Schedule note sequence
			profile.notes.forEach((freq, i) => {
				osc.frequency.setValueAtTime(freq, ac.currentTime + i * profile.step);
			});

			gain.gain.setValueAtTime(profile.volume, ac.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + profile.duration);

			osc.start(ac.currentTime);
			osc.stop(ac.currentTime + profile.duration);
		} catch {}
	}

	function updateDisplay() {
		const el = document.getElementById('coin-count');
		if (el) el.textContent = balance;
	}

	function spend(action) {
		const cost = costs[action] || 0;
		if (cost <= 0) return true;
		if (balance < cost) return false;
		balance -= cost;
		save();
		updateDisplay();
		logTransaction(-cost, `spend_${action}`);
		console.log(`[Coins] -${cost} (${action}) → balance: ${balance}`);
		return true;
	}

	function canAfford(action) {
		const cost = costs[action] || 0;
		return balance >= cost;
	}

	function getCost(action) {
		return costs[action] || 0;
	}

	function getBalance() { return balance; }

	function spendAmount(amount) {
		const amt = parseInt(amount) || 0;
		if (amt <= 0 || balance < amt) return false;
		balance -= amt;
		save();
		updateDisplay();
		return true;
	}

	const ACTION_LABELS = {
		timer: '⏱ Timer completed',
		robot_challenge: '🤖 Robot Challenge',
		narrator_fact: '🎙 Narrator fact',
		mode_click: '🎮 Mode click',
		tamagochi_coin: '🐣 Tamagotchi',
		phone_buzz: '📱 Phone buzz',
		spend_generate: '🎲 Generate game',
		spend_surprise: '🎲 Surprise game'
	};

	function formatRelativeTime(isoString) {
		const diff = Date.now() - new Date(isoString).getTime();
		const m = Math.floor(diff / 60000);
		if (m < 1) return 'práve teraz';
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h`;
		return `${Math.floor(h / 24)}d`;
	}

	let historyOpen = false;

	async function toggleHistory() {
		const dropdown = document.getElementById('coin-history-dropdown');
		const coinDisplay = document.getElementById('coin-display');
		const balanceEl = document.getElementById('coin-history-balance');
		if (!dropdown || !coinDisplay) return;

		historyOpen = !historyOpen;
		dropdown.classList.toggle('open', historyOpen);

		if (historyOpen) {
			const rect = coinDisplay.getBoundingClientRect();
			dropdown.style.top = (rect.bottom + 8) + 'px';
			const right = window.innerWidth - rect.right;
			dropdown.style.right = right + 'px';
			dropdown.style.left = 'auto';
		}

		if (!historyOpen) return;

		if (balanceEl) balanceEl.textContent = balance;

		// Fetch history
		const listEl = document.getElementById('coin-history-list');
		if (listEl) listEl.innerHTML = '<div class="coin-history-loading">Načítavam...</div>';

		if (!supabaseClient) {
			if (listEl) listEl.innerHTML = '<div class="coin-history-empty">Prihlás sa pre históriu</div>';
			return;
		}

		try {
			// 8s timeout — prevents hanging if Supabase auth is slow on token refresh
			const sessionResult = await Promise.race([
				supabaseClient.auth.getSession(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('session_timeout')), 8000))
			]);
			if (!sessionResult.data?.session?.access_token) {
				if (listEl) listEl.innerHTML = '<div class="coin-history-empty">Prihlás sa pre históriu</div>';
				return;
			}
			const controller = new AbortController();
			const fetchTimeout = setTimeout(() => controller.abort(), 10000);
			let resp;
			try {
				resp = await fetch('/api/coins/history?limit=10', {
					headers: { Authorization: `Bearer ${sessionResult.data.session.access_token}` },
					signal: controller.signal
				});
			} finally {
				clearTimeout(fetchTimeout);
			}
			if (!resp.ok) throw new Error(resp.status);
			const { transactions } = await resp.json();
			if (!listEl) return;
			if (!transactions.length) {
				listEl.innerHTML = '<div class="coin-history-empty">Žiadne transakcie</div>';
				return;
			}
			listEl.innerHTML = transactions.map(tx => {
				const label = ACTION_LABELS[tx.action] || tx.action;
				const sign = tx.amount >= 0 ? '+' : '';
				const cls = tx.amount >= 0 ? 'positive' : 'negative';
				return `<div class="coin-history-row">
					<span class="coin-history-action">${label}</span>
					<span class="coin-history-amount ${cls}">${sign}${tx.amount}</span>
					<span class="coin-history-time">${formatRelativeTime(tx.createdAt)}</span>
				</div>`;
			}).join('');
		} catch {
			if (listEl) listEl.innerHTML = '<div class="coin-history-empty">Chyba načítania</div>';
		}
	}

	// Close dropdown when clicking outside
	document.addEventListener('click', (e) => {
		if (historyOpen && !document.getElementById('coin-display')?.contains(e.target)) {
			historyOpen = false;
			document.getElementById('coin-history-dropdown')?.classList.remove('open');
		}
	});

	return { load, award, spend, spendAmount, canAfford, getCost, getBalance, toggleHistory };
})();

// Expose globally so App can bridge it as `const Coins = window.Coins`
window.Coins = Coins;
