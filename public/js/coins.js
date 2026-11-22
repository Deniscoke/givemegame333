/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Coins module (extracted from script.js Phase 1)

   Dependencies (globals resolved at call-time, not load-time):
     • supabaseClient      — var declared in script.js (top-level)
     • supabaseProfilesOk  — var declared in script.js (top-level)
     • getCurrentUser()    — function declared in script.js (top-level)

   Exposes: window.Coins  (also bridged inside App as `const Coins = window.Coins`)
   ═══════════════════════════════════════════════════════════════════ */

// ─── Coin systém — gIVEMECOIN ───
// Prihlásený používateľ: zostatok vlastní server (profiles.coins). Prehliadač
// ho len číta a hlási udalosti na /api/coins/log, /api/coins/award-mode-click
// a /api/shop/purchase; server pripisuje a odpočítava (denné limity, žiadne
// prečerpanie). Prehliadač profiles.coins nikdy nezapisuje (migrácia 036).
// Hosť: lokálna „cvičná peňaženka“ v localStorage, nikdy sa nesynchronizuje
// a pri registrácii sa nespája so serverom (server dá jednorazový štartovací grant).
const Coins = (() => {
	const STORAGE_KEY = 'givemegame_coins';
	let balance = 0;
	let serverWallet = false;

	const _t = (key, fallback) => (window.givemegame_t || ((k, f) => f || k))(key, fallback);

	const rewards = {
		timer: 500,
		robot_challenge: 250,
		mode_click: 1,
		tamagochi_coin: 1,
		phone_buzz: 5,
		narrator_fact: 50   // AI vypraváč — vypočuj si zaujímavosť
	};

	const costs = {
		generate: 50,
		surprise: 25,
		remix: 25
	};

	// Starter coins — enough for several generations without earning first
	const STARTER_COINS = 500;

	function _isSignedIn() {
		const user = getCurrentUser();
		return !!(user && user.uid !== 'guest' && supabaseClient);
	}

	/** Hosťova cvičná peňaženka — len localStorage, nikdy sa neposiela na server. */
	function _loadGuestWallet() {
		let stored = 0;
		try {
			stored = Math.max(0, parseInt(localStorage.getItem(STORAGE_KEY)) || 0);
			// Starter coiny pre nových hostí (aby mohli generovať prvé hry)
			if (stored === 0 && !localStorage.getItem(STORAGE_KEY + '_init')) {
				stored = STARTER_COINS;
				localStorage.setItem(STORAGE_KEY, String(STARTER_COINS));
				localStorage.setItem(STORAGE_KEY + '_init', '1');
			}
		} catch (e) {}
		return stored;
	}

	async function _apiJson(url, token, { method = 'GET', body } = {}) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10000);
		try {
			const res = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal
			});
			let data = {};
			try { data = await res.json(); } catch (e) {}
			return { ok: res.ok, status: res.status, data };
		} finally { clearTimeout(timer); }
	}

	/** Prevezme zostatok zo servera, ak ho odpoveď obsahuje. */
	function _applyServerBalance(data) {
		const b = parseInt(data?.balance ?? data?.new_balance, 10);
		if (Number.isFinite(b) && b >= 0) {
			balance = b;
			updateDisplay();
			_updateShopBalance();
		}
	}

	async function _readServerBalance(token) {
		try {
			const r = await _apiJson('/api/coins/balance', token);
			if (r.ok && Number.isFinite(parseInt(r.data?.balance, 10))) return parseInt(r.data.balance, 10);
		} catch (e) {}
		// Záloha: priame čítanie (SELECT coins je povolený, zápis nie).
		try {
			const user = getCurrentUser();
			const { data, error } = await supabaseClient.from('profiles').select('coins').eq('id', user.uid).single();
			if (!error) return Math.max(0, parseInt(data?.coins) || 0);
		} catch (e) {}
		return null;
	}

	async function load() {
		if (_isSignedIn()) {
			serverWallet = true;
			const token = await _getAuthToken();
			if (token) {
				const fromServer = await _readServerBalance(token);
				if (fromServer != null) {
					balance = fromServer;
					// Úplne nový účet: jednorazový štartovací grant zo servera (bez spájania s hosťovou peňaženkou).
					if (balance === 0) {
						try {
							const g = await _apiJson('/api/coins/starter-grant', token, { method: 'POST' });
							if (g.ok) _applyServerBalance(g.data);
						} catch (e) {}
					}
				}
			}
			updateDisplay();
			return;
		}
		serverWallet = false;
		balance = _loadGuestWallet();
		updateDisplay();
	}

	function save() {
		// Ukladá sa len hosťova cvičná peňaženka; zostatok prihláseného vlastní server.
		if (serverWallet) return;
		try { localStorage.setItem(STORAGE_KEY, String(balance)); } catch (e) {}
	}

	/**
	 * Nahlási udalosť serveru (prihlásený používateľ). Server ju pripíše alebo
	 * odpočíta a vráti skutočný zostatok, ktorý sa prevezme.
	 * @returns {Promise<{ok:boolean, status:number, data:object}|null>}
	 */
	async function logTransaction(amount, action) {
		if (!serverWallet) return null;
		try {
			const token = await _getAuthToken();
			if (!token) return null;
			const r = await _apiJson('/api/coins/log', token, { method: 'POST', body: { amount, action } });
			_applyServerBalance(r.data);
			// 429: nič sa nepripísalo; capped: udalosť sa započítala (napr. Robot Challenge XP), coiny už nie.
			if (amount > 0 && r.status === 429 && r.data?.code === 'COIN_DAILY_CAP') {
				// Let periodic sources (e.g. the phone buzz) stop instead of retrying all day.
				try { window.dispatchEvent(new CustomEvent('givemegame:coin-cap', { detail: { action } })); } catch (_) {}
			}
			if (amount > 0 && ((r.status === 429 && r.data?.code === 'COIN_DAILY_CAP') || (r.ok && r.data?.capped))) {
				GameUI.toast(`🪙 ${_t('coins_daily_cap', 'Denný limit coinov z tejto aktivity je vyčerpaný. Skús to zajtra.')}`);
			}
			return r;
		} catch (e) { return null; }
	}

	/** H9: mode-click coiny len cez serverovú trasu s denným limitom. */
	async function _awardModeClickOnServer() {
		try {
			const token = await _getAuthToken();
			if (!token) return;
			const r = await _apiJson('/api/coins/award-mode-click', token, { method: 'POST' });
			_applyServerBalance(r.data);
		} catch (e) {}
	}

	// Automatic / passive sources never use a multiplier powerup: the server caps
	// them per day, so a paid double_coins charge would be burned for nothing.
	const NO_MULTIPLIER_SOURCES = ['tamagochi_coin', 'phone_buzz'];
	function _noMultiplier(source) {
		return NO_MULTIPLIER_SOURCES.includes(source) || String(source).startsWith('giveme_');
	}

	function award(source) {
		let amount = rewards[source] || 1;
		if (serverWallet && source === 'mode_click') {
			// Bez double_coins: server pripíše presne 1 coin a stráži denný limit.
			_awardModeClickOnServer();
		} else {
			const dc = _noMultiplier(source) ? null : getActivePowerup('double_coins');
			if (dc) {
				amount *= dc.value;
				consumePowerup('double_coins');
			}
			// Okamžitá odozva; pri prihlásení server zostatok potvrdí alebo opraví.
			balance += amount;
			save();
			updateDisplay();
			logTransaction(amount, source);
		}

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

		// Check for free_gen / free_reroll powerups
		if ((action === 'generate' || action === 'surprise') && getActivePowerup('free_gen')) {
			consumePowerup('free_gen');
			GameUI.toast('🎲 Free generate použitý!');
			logTransaction(0, `spend_${action}_free`);
			return true;
		}
		if (action === 'remix' && getActivePowerup('free_reroll')) {
			consumePowerup('free_reroll');
			GameUI.toast('🔄 Free re-roll použitý!');
			logTransaction(0, `spend_${action}_free`);
			return true;
		}

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
		if ((action === 'generate' || action === 'surprise') && getActivePowerup('free_gen')) return true;
		if (action === 'remix' && getActivePowerup('free_reroll')) return true;
		return balance >= cost;
	}

	function getCost(action) {
		return costs[action] || 0;
	}

	function getBalance() { return balance; }

	/**
	 * Lokálne odpočítanie — len hosťova cvičná peňaženka. Prihlásený používateľ
	 * daruje cez POST /api/giveme/donate (server odpočíta a vráti zostatok,
	 * ten sa prevezme cez syncServerBalance); lokálne zníženie čísla by inak
	 * po obnovení stránky zmizlo a dar by bol zadarmo.
	 */
	function spendAmount(amount) {
		if (serverWallet) return false;
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
		spend_surprise: '🎲 Surprise game',
		shop_xp_boost_2x: '⚡ XP Boost 2×',
		shop_free_gen_3: '🎲 Free Generate ×3',
		shop_timer_extend: '⏱️ Timer +5 min',
		shop_double_coins: '🪙 Double Coins',
		shop_reroll_free: '🔄 Free Re-roll',
		shop_xp_potion_500: '🧪 XP Potion',
		solo_complete_boosted: '⚡ Solo (boosted)',
		photo_verify_bonus: '📸 Foto výzva (overené)',
	};

	/** Server-side ledger actions with translated labels: action → [i18n key, Slovak fallback]. */
	const I18N_ACTION_LABELS = {
		starter_grant: ['coins_tx_starter_grant', '🎁 Štartovací bonus'],
		giveme_donation_sent: ['coins_tx_donation_sent', '🎁 Darované coiny (gIVEME)'],
		donation_received: ['coins_tx_donation_received', '🎁 Prijatý dar (gIVEME)'],
		balance_reconcile: ['coins_tx_balance_reconcile', '🧾 Obnovený zostatok'],
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

	// ─── Shop catalog ───
	// Each item: { id, icon, name, desc, cost, type, value, duration?, stackable? }
	// type: 'xp_boost' | 'free_gen' | 'timer_extend' | 'double_coins' | 'cosmetic'
	const SHOP_ITEMS = [
		{ id: 'xp_boost_2x',    icon: '⚡', name: '2× XP Boost',           desc: 'Dvojnásobné XP z nasledujúcich 3 hier',              cost: 1500,  type: 'xp_boost',     value: 2, uses: 3 },
		{ id: 'free_gen_3',     icon: '🎲', name: '3× Free Generate',      desc: 'Generuj 3 hry zadarmo (bez nákladov na coiny)',       cost: 500,   type: 'free_gen',     value: 3 },
		{ id: 'timer_extend',   icon: '⏱️', name: 'Timer +5 min',          desc: 'Pridá 5 min navyše k aktuálnemu timeru',              cost: 300,   type: 'timer_extend', value: 5 },
		{ id: 'double_coins',   icon: '🪙', name: '2× Coiny (3 hry)',      desc: 'Dvojnásobné coin odmeny z nasledujúcich 3 aktivít',   cost: 2000,  type: 'double_coins', value: 2, uses: 3 },
		{ id: 'reroll_free',    icon: '🔄', name: 'Free Re-roll',          desc: 'Jeden remix/re-roll zadarmo',                          cost: 200,   type: 'free_reroll',  value: 1 },
		{ id: 'xp_potion_500',  icon: '🧪', name: 'XP Potion (+500 XP)',   desc: 'Okamžite získaš +500 RPG XP',                         cost: 5000,  type: 'instant_xp',   value: 500 },
	];

	// Active powerups stored in localStorage
	const POWERUPS_KEY = 'givemegame_powerups';
	function _loadPowerups() {
		try { return JSON.parse(localStorage.getItem(POWERUPS_KEY) || '{}'); } catch { return {}; }
	}
	function _savePowerups(p) {
		try { localStorage.setItem(POWERUPS_KEY, JSON.stringify(p)); } catch {}
	}

	function getActivePowerup(type) {
		const p = _loadPowerups();
		const pu = p[type];
		if (!pu || (pu.uses != null && pu.uses <= 0)) return null;
		return pu;
	}

	function consumePowerup(type) {
		const p = _loadPowerups();
		if (!p[type]) return false;
		if (p[type].uses != null) {
			p[type].uses--;
			if (p[type].uses <= 0) delete p[type];
		} else {
			delete p[type];
		}
		_savePowerups(p);
		return true;
	}

	async function _getAuthToken() {
		if (!supabaseClient) return null;
		try {
			const r = await Promise.race([
				supabaseClient.auth.getSession(),
				new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
			]);
			return r.data?.session?.access_token || null;
		} catch { return null; }
	}

	async function purchaseItem(itemId) {
		const item = SHOP_ITEMS.find(i => i.id === itemId);
		if (!item) return;
		if (balance < item.cost) {
			GameUI.toast(`🪙 Nedostatok coinov! Treba ${item.cost}, máš ${balance}`);
			return;
		}

		// Items sold by the server: XP potion and the XP boost (solo completion
		// only applies a multiplier the server sold — see /api/shop/purchase).
		if (item.type === 'instant_xp' || item.type === 'xp_boost') {
			const token = await _getAuthToken();
			if (!token) { GameUI.toast('⚠️ Prihlás sa pre nákup'); return; }
			try {
				const res = await fetch('/api/shop/purchase', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
					body: JSON.stringify({ item_id: itemId })
				});
				const data = await res.json();
				if (!res.ok) { GameUI.toast(`❌ ${data.error || 'Nákup zlyhal'}`); return; }
				balance = data.new_balance ?? (balance - item.cost);
				save(); updateDisplay();
				_updateShopBalance();
				if (item.type === 'xp_boost') {
					_addPowerup(item);
					playCoinSound();
					GameUI.toast(`${item.icon} ${item.name} kúpený!`);
					_renderShop();
					return;
				}
				GameUI.toast(`${item.icon} ${item.name} aktivovaný! +${item.value} XP`);
				if (window.RpgTalents?.load) {
					const td = await RpgTalents.load();
					if (td && GameUI.renderRpgHudFromTalents) GameUI.renderRpgHudFromTalents(td);
				}
				if (window.RpgScreen?.refresh) RpgScreen.refresh();
				if (data.rpg_level_up) GameUI.toast(`⭐ Nový RPG level: ${data.rpg_level}!`);
				if (data.rpg_xp_gained > 0 && window.RpgXpFx) RpgXpFx.trigger(data.rpg_xp_gained, `${item.icon} ${item.name}`);
				_renderShop();
				return;
			} catch (e) { GameUI.toast(`❌ ${e.message}`); return; }
		}

		// Signed in: the server debits first; the item is granted only if it did.
		if (serverWallet) {
			const r = await logTransaction(-item.cost, `shop_${itemId}`);
			if (!r || !r.ok) {
				GameUI.toast(`❌ ${r?.data?.error || 'Nákup zlyhal'}`);
				return;
			}
		} else {
			balance -= item.cost;
			save();
		}
		updateDisplay();

		// Timer extend — instant effect, no stored powerup
		if (item.type === 'timer_extend') {
			if (window.Timer?.addTime) Timer.addTime(item.value);
			else GameUI.toast('⏱️ Najprv spusti timer!');
			playCoinSound();
			_updateShopBalance();
			_renderShop();
			return;
		}

		// Client-side powerup items (already paid above)
		_addPowerup(item);

		playCoinSound();
		GameUI.toast(`${item.icon} ${item.name} kúpený!`);
		_updateShopBalance();
		_renderShop();
	}

	function _addPowerup(item) {
		const p = _loadPowerups();
		if (item.uses) {
			if (p[item.type]) {
				p[item.type].uses = (p[item.type].uses || 0) + item.uses;
				p[item.type].value = item.value;
			} else {
				p[item.type] = { value: item.value, uses: item.uses };
			}
		} else {
			p[item.type] = { value: item.value, uses: item.value };
		}
		_savePowerups(p);
	}

	function _updateShopBalance() {
		const el = document.getElementById('coin-history-balance');
		if (el) el.textContent = balance;
	}

	function _renderShop() {
		const list = document.getElementById('coin-shop-list');
		if (!list) return;

		const powerups = _loadPowerups();
		const activeBadges = Object.entries(powerups)
			.filter(([, v]) => v && (v.uses == null || v.uses > 0))
			.map(([type, v]) => {
				const item = SHOP_ITEMS.find(i => i.type === type);
				return `<div class="shop-active-badge">${item?.icon || '✨'} ${item?.name || type}${v.uses != null ? ` (${v.uses}×)` : ''}</div>`;
			}).join('');

		const activeSection = activeBadges
			? `<div class="shop-active-section"><div class="shop-section-title">✨ Aktívne bonusy</div>${activeBadges}</div>`
			: '';

		const itemsHtml = SHOP_ITEMS.map(item => {
			const canBuy = balance >= item.cost;
			const existing = powerups[item.type];
			const stackInfo = existing?.uses > 0 ? `<span class="shop-item-stack">(aktívne: ${existing.uses}×)</span>` : '';
			return `
				<div class="shop-item ${canBuy ? '' : 'shop-item-locked'}">
					<div class="shop-item-icon">${item.icon}</div>
					<div class="shop-item-info">
						<div class="shop-item-name">${item.name} ${stackInfo}</div>
						<div class="shop-item-desc">${item.desc}</div>
					</div>
					<button class="shop-item-buy ${canBuy ? '' : 'disabled'}"
						onclick="Coins.purchaseItem('${item.id}')" ${canBuy ? '' : 'disabled'}>
						🪙 ${item.cost.toLocaleString()}
					</button>
				</div>`;
		}).join('');

		list.innerHTML = `${activeSection}<div class="shop-section-title">🛒 Obchod</div>${itemsHtml}`;
	}

	let historyOpen = false;
	let currentTab = 'history';

	function switchTab(tab) {
		currentTab = tab;
		document.querySelectorAll('.coin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
		document.getElementById('coin-tab-history').style.display = tab === 'history' ? '' : 'none';
		document.getElementById('coin-tab-shop').style.display = tab === 'shop' ? '' : 'none';
		if (tab === 'shop') _renderShop();
	}

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

		if (currentTab === 'shop') { _renderShop(); return; }

		const listEl = document.getElementById('coin-history-list');
		if (listEl) listEl.innerHTML = '<div class="coin-history-loading">Načítavam...</div>';

		if (!supabaseClient) {
			if (listEl) listEl.innerHTML = '<div class="coin-history-empty">Prihlás sa pre históriu</div>';
			return;
		}

		try {
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
			} finally { clearTimeout(fetchTimeout); }
			if (!resp.ok) throw new Error(resp.status);
			const { transactions } = await resp.json();
			if (!listEl) return;
			if (!transactions.length) {
				listEl.innerHTML = '<div class="coin-history-empty">Žiadne transakcie</div>';
				return;
			}
			listEl.innerHTML = transactions.map(tx => {
				const i18nLabel = I18N_ACTION_LABELS[tx.action];
				const label = i18nLabel
					? _t(i18nLabel[0], i18nLabel[1])
					: (ACTION_LABELS[tx.action] || tx.action);
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
		if (historyOpen) {
			const dropdown = document.getElementById('coin-history-dropdown');
			const coinDisplay = document.getElementById('coin-display');
			if (!dropdown?.contains(e.target) && !coinDisplay?.contains(e.target)) {
				historyOpen = false;
				dropdown?.classList.remove('open');
			}
		}
	});

	return {
		load, award, spend, spendAmount, canAfford, getCost, getBalance,
		isServerWallet: () => serverWallet,
		syncServerBalance: (b) => { if (serverWallet) _applyServerBalance({ balance: b }); },
		toggleHistory, switchTab, purchaseItem,
		getActivePowerup, consumePowerup
	};
})();

// Expose globally so App can bridge it as `const Coins = window.Coins`
window.Coins = Coins;
