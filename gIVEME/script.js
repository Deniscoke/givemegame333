// ============================================
// gIVEME — Sociálna sieť (integrovaná do gIVEMEGAME.IO)
// ============================================

// ===== SUPABASE (prepojené s Google účtom — každý používateľ má svoj gIVEME účet) =====
const SUPABASE_URL = 'https://vhpkkbixshfyytohkruv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZocGtrYml4c2hmeXl0b2hrcnV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMDAzNzcsImV4cCI6MjA4ODY3NjM3N30.umrrhSqC9LW2Wlcs5y4uCViVfZmqyHcMbaPQaQiMbR0';
let supabase = null;
try {
	if (typeof window !== 'undefined' && window.supabase) {
		supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
			auth: { detectSessionInUrl: true, persistSession: true }
		});
	}
} catch (e) { console.warn('[gIVEME] Supabase init failed:', e); }

function getCurrentUser() {
	try {
		const raw = sessionStorage.getItem('givemegame_user');
		const u = raw ? JSON.parse(raw) : null;
		return u?.uid && u.uid !== 'guest' ? u : null;
	} catch { return null; }
}

// Sync auth z Supabase (ak sessionStorage prázdne napr. po refreshi)
async function syncAuthFromSupabase() {
	if (!supabase) return null;
	try {
		const { data: { session } } = await supabase.auth.getSession();
		if (session?.user) {
			const user = {
				uid: session.user.id,
				name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Player',
				email: session.user.email,
				photo: session.user.user_metadata?.avatar_url || null
			};
			sessionStorage.setItem('givemegame_user', JSON.stringify(user));
			return user;
		}
	} catch (e) { /* ignore */ }
	return null;
}

function getAvatarEmoji(name) {
	const emojis = ['🎨','🧙','🐉','⚔️','🏰','🌲','👾','🌙','🦊','🐱','🎮','🌟'];
	if (!name) return '🎨';
	const idx = name.split('').reduce((a,c)=>a+c.charCodeAt(0),0) % emojis.length;
	return emojis[idx];
}

// ===== GLOBAL STATE =====
let totalCoins = 42;

const COINS_STORAGE_KEY = 'givemegame_coins';

// Sync s hlavnou aplikáciou (ak sme v iframe)
function syncCoinsFromParent() {
	try {
		if (window.parent !== window && window.parent.App && window.parent.App.Coins) {
			totalCoins = window.parent.App.Coins.getBalance();
			updateCoinDisplay();
			return;
		}
	} catch (e) { /* cross-origin */ }
	const stored = parseInt(localStorage.getItem(COINS_STORAGE_KEY)) || 0;
	if (stored > 0) totalCoins = stored;
	updateCoinDisplay();
}

// Notifikuj rodiča o coinoch — uloží do hlavnej app aj lokálne fallback
function notifyParentCoinsChange(amount, action) {
	let saved = false;
	try {
		if (window.parent !== window && window.parent.App && window.parent.App.Coins && amount > 0) {
			window.parent.App.Coins.award('giveme_' + action);
			saved = true;
		}
	} catch (e) { /* cross-origin */ }
	if (!saved && amount > 0) {
		const stored = parseInt(localStorage.getItem(COINS_STORAGE_KEY)) || 0;
		localStorage.setItem(COINS_STORAGE_KEY, String(stored + amount));
	}
}
let xpProgress = 35;
let currentCommentPost = null;
let currentSharePostId = null;
let storyTimer = null;
let currentColor = '#e74c3c';
let isDrawing = false;

// ===== PIXEL ART PALETTES =====
const palettes = [
    // Sunset
    ['#ff6b6b', '#ee5a24', '#f0932b', '#f9ca24', '#6ab04c', '#22a6b3', '#30336b', '#130f40', '#e056a0', '#ff9ff3'],
    // Dragon / Ocean
    ['#e74c3c', '#c0392b', '#f39c12', '#f1c40f', '#e67e22', '#d35400', '#2c3e50', '#34495e', '#1abc9c', '#16a085'],
    // Forest / Weapons
    ['#2ecc71', '#27ae60', '#3498db', '#2980b9', '#9b59b6', '#8e44ad', '#1abc9c', '#f39c12', '#e74c3c', '#ecf0f1']
];

// ===== PROMPT ZADANIA (čo mám namaľovať) =====
const PROMPT_SUGGESTIONS = [
    'Namaľuj draka', 'Namaľuj hrad', 'Namaľuj strom', 'Namaľuj slnko', 'Namaľuj mesiac',
    'Namaľuj kvet', 'Namaľuj mačku', 'Namaľuj psa', 'Namaľuj srdce', 'Namaľuj hviezdu',
    'Namaľuj robota', 'Namaľuj loď', 'Namaľuj auto', 'Namaľuj dom', 'Namaľuj mraky',
    'Namaľuj snehuliaka', 'Namaľuj duhu', 'Namaľuj čarodejníka', 'Namaľuj meč',
    'Namaľuj pokémona', 'Namaľuj emoji', 'Namaľuj jedlo', 'Namaľuj kráľa',
    'Namaľuj princeznú', 'Namaľuj príšeru', 'Namaľuj vesmírnu loď', 'Namaľuj dinosaura'
];

// ===== STORY DATA =====
const storyData = [
    { name: 'pixel_mage', avatar: '🧙' },
    { name: 'dragon_art', avatar: '🐉' },
    { name: 'sword_pixl', avatar: '⚔️' },
    { name: 'castle_8bit', avatar: '🏰' },
    { name: 'nature_px', avatar: '🌲' },
    { name: 'retro_game', avatar: '👾' },
    { name: 'moon_pixel', avatar: '🌙' }
];

// =============================================
// PIXEL ART GENERATOR
// =============================================

function generatePixelArt(canvas, paletteIndex) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const palette = palettes[paletteIndex % palettes.length];

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = palette[Math.floor(Math.random() * 3) + 7] || '#130f40';
    ctx.fillRect(0, 0, w, h);

    // Generate symmetric pixel art
    const halfW = Math.ceil(w / 2);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < halfW; x++) {
            if (Math.random() > 0.45) {
                const color = palette[Math.floor(Math.random() * palette.length)];
                ctx.fillStyle = color;
                ctx.fillRect(x, y, 1, 1);
                ctx.fillRect(w - 1 - x, y, 1, 1); // Mirror
            }
        }
    }

    // Add highlights
    for (let i = 0; i < 8; i++) {
        const x = Math.floor(Math.random() * w);
        const y = Math.floor(Math.random() * h);
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.6;
        ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;
}

function generateStoryArt(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const palette = palettes[Math.floor(Math.random() * palettes.length)];

    // Gradient background
    for (let y = 0; y < h; y++) {
        const idx = Math.floor((y / h) * palette.length);
        ctx.fillStyle = palette[Math.min(idx, palette.length - 1)];
        for (let x = 0; x < w; x++) {
            if (Math.random() > 0.3) {
                ctx.fillRect(x, y, 1, 1);
            }
        }
    }

    // Character in center
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    ctx.fillStyle = '#ffffff';
    for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            if (Math.random() > 0.3) {
                ctx.fillRect(cx + dx, cy + dy, 1, 1);
            }
        }
    }
}

// =============================================
// FEED — načítanie z Supabase
// =============================================

async function loadFeed() {
    const feedEl = document.getElementById('feed');
    const loadingEl = document.getElementById('feedLoading');
    const emptyEl = document.getElementById('feedEmpty');
    if (!feedEl || !loadingEl) return;

    try {
        if (!supabase) {
            loadingEl.textContent = 'Supabase nie je dostupný.';
            emptyEl.style.display = 'block';
            return;
        }
        const { data: posts, error } = await supabase
            .from('giveme_posts')
            .select('id, image_data, caption, prompt, created_at, author_id')
            .order('created_at', { ascending: false })
            .limit(50);

        loadingEl.style.display = 'none';

        if (error) {
            console.warn('[gIVEME] Feed error:', error);
            emptyEl.style.display = 'block';
            emptyEl.querySelector('p').textContent = 'Chyba pri načítaní. Skús obnoviť stránku.';
            return;
        }

        if (!posts || posts.length === 0) {
            emptyEl.style.display = 'block';
            const txt = document.getElementById('feedEmptyText');
            if (txt) txt.textContent = getCurrentUser() ? '🎨 Zatiaľ žiadne posty. Vytvor prvý pixel art!' : '🎨 Zatiaľ žiadne posty. Prihlás sa a vytvor prvý!';
            return;
        }

        emptyEl.style.display = 'none';

        const authorIds = [...new Set(posts.map(p => p.author_id))];
        const { data: profilesData } = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', authorIds);
        const profileMap = Object.fromEntries((profilesData || []).map(p => [p.id, p]));

        // Načítaj lajky, komentáre, dary pre každý post
        const postIds = posts.map(p => p.id);
        const [likesRes, commentsRes, donationsRes] = await Promise.all([
            supabase.from('giveme_likes').select('post_id, user_id').in('post_id', postIds),
            supabase.from('giveme_comments').select('post_id').in('post_id', postIds),
            supabase.from('giveme_coin_donations').select('post_id, amount').in('post_id', postIds)
        ]);

        const likesByPost = {};
        (likesRes.data || []).forEach(l => {
            if (!likesByPost[l.post_id]) likesByPost[l.post_id] = { count: 0, userIds: [] };
            likesByPost[l.post_id].count++;
            likesByPost[l.post_id].userIds.push(l.user_id);
        });

        const commentsByPost = {};
        (commentsRes.data || []).forEach(c => {
            commentsByPost[c.post_id] = (commentsByPost[c.post_id] || 0) + 1;
        });

        const donationsByPost = {};
        (donationsRes.data || []).forEach(d => {
            donationsByPost[d.post_id] = (donationsByPost[d.post_id] || 0) + d.amount;
        });

        const me = getCurrentUser();

        feedEl.innerHTML = '';
        for (const post of posts) {
            const author = profileMap[post.author_id] || {};
            const displayName = author.display_name || 'Anonym';
            const avatar = author.avatar_url ? `<img src="${escapeHTML(author.avatar_url)}" alt="" class="post-avatar-img">` : getAvatarEmoji(displayName);
            const likesCount = (likesByPost[post.id]?.count) || 0;
            const commentsCount = (commentsByPost[post.id]) || 0;
            const coinsReceived = (donationsByPost[post.id]) || 0;
            const iLiked = me && (likesByPost[post.id]?.userIds || []).includes(me.uid);

            const card = document.createElement('article');
            card.className = 'post-card';
            card.dataset.postId = post.id;
            card.dataset.authorId = post.author_id;
            card.innerHTML = `
                <div class="post-header">
                    <div class="post-user-info">
                        <div class="post-avatar">${avatar}</div>
                        <div>
                            <div class="post-username">${escapeHTML(displayName)}</div>
                            <div class="post-location">🎨 gIVEME</div>
                        </div>
                    </div>
                    <button class="post-menu-btn">•••</button>
                </div>
                <div class="post-image-container" ondblclick="doubleTapLike(this, '${post.id}')">
                    <img src="${post.image_data}" alt="pixel art" class="post-image-pixel" width="16" height="16">
                    <div class="double-tap-heart">❤️</div>
                </div>
                <div class="post-actions">
                    <div class="post-actions-left">
                        <button class="action-btn like-btn ${iLiked ? 'liked' : ''}" onclick="toggleLike(this, '${post.id}')">
                            <span class="like-icon">${iLiked ? '❤️' : '🤍'}</span>
                        </button>
                        <button class="action-btn comment-btn" onclick="openComments('${post.id}')">💬</button>
                        <button class="action-btn share-btn" onclick="openShare('${post.id}')">📤</button>
                        <button class="action-btn coin-btn" onclick="toggleCoinPopup(this)">
                            <div class="coin-symbol">C</div>
                            <div class="coin-amount-popup">
                                <div class="coin-amount-option" onclick="sendCoins(event, '${post.id}', '${post.author_id}', 1)">🪙 1 Coin</div>
                                <div class="coin-amount-option" onclick="sendCoins(event, '${post.id}', '${post.author_id}', 5)">🪙 5 Coins</div>
                                <div class="coin-amount-option" onclick="sendCoins(event, '${post.id}', '${post.author_id}', 10)">🪙 10 Coins</div>
                                <div class="coin-custom-input">
                                    <input type="number" placeholder="Vlastné" min="1" id="customCoin${post.id.replace(/-/g,'')}">
                                    <button onclick="sendCustomCoins(event, '${post.id}', '${post.author_id}')">OK</button>
                                </div>
                            </div>
                        </button>
                    </div>
                    <button class="action-btn bookmark-btn" onclick="toggleBookmark(this)">🔖</button>
                </div>
                <div class="post-stats">
                    <div class="post-likes">❤️ <span class="likes-count" id="likes-${post.id.replace(/-/g,'')}">${likesCount}</span> lajkov</div>
                    <div class="post-coins-received">🪙 <span id="coins-received-${post.id.replace(/-/g,'')}">${coinsReceived}</span> coinov darovaných</div>
                </div>
                ${post.prompt ? `<div class="post-prompt">📋 Zadanie: ${escapeHTML(post.prompt)}</div>` : ''}
                <div class="post-caption"><span class="caption-username">${escapeHTML(displayName)}</span> ${escapeHTML(post.caption || '')}</div>
                <div class="post-comments-preview">
                    <button class="view-comments-btn" onclick="openComments('${post.id}')">${commentsCount === 0 ? 'Pridať komentár' : (commentsCount === 1 ? 'Zobraziť 1 komentár' : 'Zobraziť ' + commentsCount + ' komentárov')}</button>
                </div>
                <div class="comment-input-area">
                    <button class="emoji-btn">😀</button>
                    <input type="text" placeholder="Pridať komentár..." onkeydown="handleCommentInput(event, this, '${post.id}')" oninput="toggleSubmitBtn(this)">
                    <button class="comment-submit-btn" onclick="submitInlineComment(this, '${post.id}')">Odoslať</button>
                </div>
                <div class="post-time">${formatTimeAgo(post.created_at)}</div>
            `;
            feedEl.appendChild(card);
        }
    } catch (err) {
        console.error('[gIVEME] loadFeed:', err);
        loadingEl.textContent = 'Chyba pri načítaní.';
        emptyEl.style.display = 'block';
    }
}

function formatTimeAgo(iso) {
    const d = new Date(iso);
    const now = new Date();
    const s = Math.floor((now - d) / 1000);
    if (s < 60) return 'práve teraz';
    if (s < 3600) return `pred ${Math.floor(s/60)} min`;
    if (s < 86400) return `pred ${Math.floor(s/3600)} h`;
    return `pred ${Math.floor(s/86400)} d`;
}

// =============================================
// COIN SYSTEM
// =============================================

function earnCoin(action) {
    totalCoins++;
    updateCoinDisplay();
    showCoinToast();
    updateXP(2);
    createFloatingCoin();
    notifyParentCoinsChange(1, action);
}

function updateCoinDisplay() {
    document.getElementById('totalCoins').textContent = totalCoins;
    const counter = document.getElementById('coinCounter');
    counter.style.transform = 'scale(1.2)';
    setTimeout(() => counter.style.transform = 'scale(1)', 200);
}

function showCoinToast() {
    const toast = document.getElementById('coinToast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}

function createFloatingCoin() {
    const coin = document.createElement('div');
    coin.className = 'floating-coin';
    coin.textContent = '🪙';
    coin.style.left = Math.random() * window.innerWidth + 'px';
    coin.style.top = (Math.random() * 300 + 200) + 'px';
    document.body.appendChild(coin);
    setTimeout(() => coin.remove(), 1500);
}

function updateXP(amount) {
    xpProgress = Math.min(100, xpProgress + amount);
    document.getElementById('xpBar').style.width = xpProgress + '%';
    if (xpProgress >= 100) {
        xpProgress = 0;
        coinRainEffect();
    }
}

function coinRainEffect() {
    for (let i = 0; i < 20; i++) {
        setTimeout(() => {
            const coin = document.createElement('div');
            coin.className = 'coin-rain-particle';
            coin.textContent = '🪙';
            coin.style.left = Math.random() * 100 + 'vw';
            coin.style.top = '-20px';
            coin.style.fontSize = (12 + Math.random() * 16) + 'px';
            coin.style.animationDuration = (1.5 + Math.random()) + 's';
            document.body.appendChild(coin);
            setTimeout(() => coin.remove(), 3000);
        }, i * 100);
    }
}

function showCoinHistory() {
    alert(
        `🪙 Tvoje coiny: ${totalCoins}\n\n` +
        `Zarábaj coiny interakciou:\n` +
        `❤️ Lajk = +1 coin\n` +
        `💬 Komentár = +1 coin\n` +
        `📤 Zdieľanie = +1 coin\n` +
        `👁️ Zobrazenie príbehu = +1 coin\n` +
        `🪙 Odoslanie coinov = +1 coin\n\n` +
        `Coiny môžeš darovať opakovane!`
    );
}

// =============================================
// LIKE SYSTEM
// =============================================

async function toggleLike(btn, postId) {
    const me = getCurrentUser();
    const safeId = String(postId).replace(/-/g, '');
    const likesEl = document.getElementById(`likes-${safeId}`);
    if (!likesEl) return;

    const isLiked = btn.classList.contains('liked');

    if (me && supabase) {
        try {
            if (isLiked) {
                await supabase.from('giveme_likes').delete().eq('post_id', postId).eq('user_id', me.uid);
                btn.classList.remove('liked');
                btn.querySelector('.like-icon').textContent = '🤍';
                likesEl.textContent = Math.max(0, parseInt(likesEl.textContent) - 1);
            } else {
                await supabase.from('giveme_likes').insert({ post_id: postId, user_id: me.uid });
                btn.classList.add('liked');
                btn.querySelector('.like-icon').textContent = '❤️';
                likesEl.textContent = parseInt(likesEl.textContent) + 1;
                earnCoin('like');
            }
        } catch (e) { console.warn('[gIVEME] toggleLike:', e); }
    } else {
        if (!isLiked) {
            btn.classList.add('liked');
            btn.querySelector('.like-icon').textContent = '❤️';
            likesEl.textContent = parseInt(likesEl.textContent) + 1;
            earnCoin('like');
        }
    }
}

function doubleTapLike(container, postId) {
    const heart = container.querySelector('.double-tap-heart');
    const postCard = container.closest('.post-card');
    const likeBtn = postCard?.querySelector('.like-btn');
    const safeId = String(postId).replace(/-/g, '');
    const likesEl = document.getElementById('likes-' + safeId);

    heart.classList.remove('animate');
    void heart.offsetWidth;
    heart.classList.add('animate');

    if (likeBtn && !likeBtn.classList.contains('liked')) {
        likeBtn.classList.add('liked');
        likeBtn.querySelector('.like-icon').textContent = '❤️';
        if (likesEl) likesEl.textContent = parseInt(likesEl.textContent || 0) + 1;
        earnCoin('double-tap-like');
        const me = getCurrentUser();
        if (me && supabase) {
            supabase.from('giveme_likes').upsert({ post_id: postId, user_id: me.uid }, { onConflict: 'post_id,user_id' }).then(() => {});
        }
    }
    setTimeout(() => heart.classList.remove('animate'), 1000);
}

// =============================================
// COIN DONATION
// =============================================

function toggleCoinPopup(btn) {
    const popup = btn.querySelector('.coin-amount-popup');
    // Close all other popups first
    document.querySelectorAll('.coin-amount-popup.show').forEach(p => {
        if (p !== popup) p.classList.remove('show');
    });
    popup.classList.toggle('show');
}

async function sendCoins(event, postId, recipientId, amount) {
    event.stopPropagation();
    amount = parseInt(amount) || 0;
    if (amount <= 0) return;

    const me = getCurrentUser();
    if (!me && supabase) {
        alert('Prihlás sa, aby si mohol darovať coinov ostatným.');
        return;
    }

    let deducted = false;
    try {
        if (window.parent !== window && window.parent.App?.Coins?.spendAmount) {
            deducted = window.parent.App.Coins.spendAmount(amount);
            if (deducted) totalCoins = window.parent.App.Coins.getBalance();
        }
    } catch (e) {}
    if (!deducted) {
        if (totalCoins < amount) {
            alert('Nemáš dostatok coinov!');
            return;
        }
        totalCoins -= amount;
        try { localStorage.setItem(COINS_STORAGE_KEY, String(totalCoins)); } catch (e) {}
    }
    updateCoinDisplay();

    if (me && supabase && recipientId) {
        try {
            await supabase.from('giveme_coin_donations').insert({
                post_id: postId,
                donor_id: me.uid,
                recipient_id: recipientId,
                amount
            });
        } catch (e) { console.warn('[gIVEME] sendCoins insert:', e); }
    }

    const safeId = String(postId).replace(/-/g, '');
    const received = document.getElementById('coins-received-' + safeId);
    if (received) received.textContent = parseInt(received.textContent || 0) + amount;

    setTimeout(() => earnCoin('send-coin'), 300);

    const coinBtn = event.target.closest('.coin-btn');
    if (coinBtn) {
        coinBtn.classList.add('sending');
        setTimeout(() => coinBtn.classList.remove('sending'), 500);
    }

    document.querySelectorAll('.coin-amount-popup.show').forEach(p => p.classList.remove('show'));

    for (let i = 0; i < Math.min(amount, 10); i++) {
        setTimeout(() => createFloatingCoin(), i * 100);
    }
}

function sendCustomCoins(event, postId, recipientId) {
    event.stopPropagation();
    const safeId = String(postId).replace(/-/g, '');
    const input = document.getElementById('customCoin' + safeId);
    const amount = parseInt(input?.value);
    if (amount && amount > 0) {
        sendCoins(event, postId, recipientId, amount);
        input.value = '';
    }
}

// Close coin popups when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.coin-btn')) {
        document.querySelectorAll('.coin-amount-popup.show').forEach(p => p.classList.remove('show'));
    }
});

// =============================================
// BOOKMARK
// =============================================

function toggleBookmark(btn) {
    if (btn.classList.contains('saved')) {
        btn.classList.remove('saved');
        btn.textContent = '🔖';
    } else {
        btn.classList.add('saved');
        btn.textContent = '📑';
        earnCoin('bookmark');
    }
}

// =============================================
// COMMENTS
// =============================================

async function openComments(postId) {
    currentCommentPost = postId;
    document.getElementById('commentModal').classList.add('show');
    earnCoin('view-comments');

    const list = document.getElementById('commentsList');
    list.innerHTML = '<div class="comment-loading">Načítavam...</div>';

    if (supabase) {
        try {
            const { data: comments } = await supabase
                .from('giveme_comments')
                .select('id, content, created_at, user_id')
                .eq('post_id', postId)
                .order('created_at', { ascending: true });

            list.innerHTML = '';
            const authorIds = [...new Set((comments || []).map(c => c.user_id))];
            const { data: profs } = authorIds.length ? await supabase.from('profiles').select('id, display_name, avatar_url').in('id', authorIds) : { data: [] };
            const profMap = Object.fromEntries((profs || []).map(p => [p.id, p]));

            for (const c of comments || []) {
                const p = profMap[c.user_id] || {};
                const name = p.display_name || 'Anonym';
                const av = p.avatar_url ? `<img src="${escapeHTML(p.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover">` : getAvatarEmoji(name);
                const div = document.createElement('div');
                div.className = 'comment-item';
                div.innerHTML = `
                    <div class="comment-avatar">${av}</div>
                    <div class="comment-body">
                        <span class="comment-username">${escapeHTML(name)}</span>
                        <p class="comment-content">${escapeHTML(c.content)}</p>
                        <div class="comment-meta"><span>${formatTimeAgo(c.created_at)}</span></div>
                    </div>
                `;
                list.appendChild(div);
            }
        } catch (e) {
            list.innerHTML = '<div class="comment-loading">Chyba pri načítaní.</div>';
        }
    } else {
        list.innerHTML = '';
    }
}

function closeComments() {
    document.getElementById('commentModal').classList.remove('show');
}

function handleCommentInput(event, input, postId) {
    if (event.key === 'Enter' && input.value.trim()) {
        submitInlineComment(input.nextElementSibling, postId);
    }
}

function toggleSubmitBtn(input) {
    const btn = input.nextElementSibling;
    btn.classList.toggle('active', input.value.trim().length > 0);
}

async function submitInlineComment(btn, postId) {
    const input = btn.previousElementSibling;
    const content = (input?.value || '').trim();
    if (!content) return;

    const me = getCurrentUser();
    if (!me || !supabase) {
        alert('Prihlás sa, aby si mohol komentovať.');
        return;
    }

    try {
        await supabase.from('giveme_comments').insert({
            post_id: postId,
            user_id: me.uid,
            content
        });
        earnCoin('comment');
        input.value = '';
        btn.classList.remove('active');

        const card = btn.closest('.post-card');
        const previewBtn = card?.querySelector('.view-comments-btn');
        if (previewBtn) {
            const m = previewBtn.textContent.match(/(\d+)/);
            const n = m ? parseInt(m[1]) + 1 : 1;
            previewBtn.textContent = n === 1 ? 'Zobraziť 1 komentár' : `Zobraziť ${n} komentárov`;
        }
    } catch (e) { console.warn('[gIVEME] submitInlineComment:', e); }
}

function handleModalComment(event) {
    if (event.key === 'Enter') {
        submitModalComment();
    }
}

async function submitModalComment() {
    const input = document.getElementById('modalCommentInput');
    const content = (input?.value || '').trim();
    if (!content || !currentCommentPost) return;

    const me = getCurrentUser();
    if (!me || !supabase) {
        alert('Prihlás sa, aby si mohol komentovať.');
        return;
    }

    try {
        const { error } = await supabase.from('giveme_comments').insert({
            post_id: currentCommentPost,
            user_id: me.uid,
            content
        });
        if (error) throw error;

        const commentsList = document.getElementById('commentsList');
        const newComment = document.createElement('div');
        newComment.className = 'comment-item';
        const name = me.name || 'Ty';
        newComment.innerHTML = `
            <div class="comment-avatar">${me.photo ? `<img src="${escapeHTML(me.photo)}" alt="" style="width:100%;height:100%;object-fit:cover">` : getAvatarEmoji(name)}</div>
            <div class="comment-body">
                <span class="comment-username">${escapeHTML(name)}</span>
                <p class="comment-content">${escapeHTML(content)}</p>
                <div class="comment-meta"><span>práve teraz</span></div>
            </div>
        `;
        commentsList.appendChild(newComment);
        input.value = '';
        commentsList.scrollTop = commentsList.scrollHeight;
        earnCoin('comment');
        // Aktualizuj počet komentárov v karte
        const card = document.querySelector(`[data-post-id="${currentCommentPost}"]`);
        const previewBtn = card?.querySelector('.view-comments-btn');
        if (previewBtn) {
            const m = previewBtn.textContent.match(/(\d+)/);
            const n = m ? parseInt(m[1]) + 1 : 1;
            previewBtn.textContent = n === 1 ? 'Zobraziť 1 komentár' : `Zobraziť ${n} komentárov`;
        }
    } catch (e) {
        console.warn('[gIVEME] submitModalComment:', e);
    }
}

function likeComment(btn) {
    if (btn.textContent === '🤍') {
        btn.textContent = '❤️';
        earnCoin('like-comment');
    } else {
        btn.textContent = '🤍';
    }
}

// Utility: Escape HTML to prevent XSS
function escapeHTML(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// =============================================
// SHARE
// =============================================

function openShare(postId) {
    currentSharePostId = postId;
    const basePath = window.location.pathname.replace(/\/[^/]*$/, '') || '/gIVEME';
    const shareUrl = `${window.location.origin}${basePath}/?post=${postId}`;
    const input = document.getElementById('shareLinkInput');
    if (input) input.value = shareUrl;
    document.getElementById('shareModal').classList.add('show');
    earnCoin('share-open');
}

function closeShare(event) {
    if (event.target === event.currentTarget) {
        document.getElementById('shareModal').classList.remove('show');
    }
}

function shareAction(platform) {
    if (platform === 'download' && currentSharePostId) {
        const card = document.querySelector(`[data-post-id="${currentSharePostId}"]`);
        const img = card?.querySelector('.post-image-pixel');
        if (img?.src) {
            const a = document.createElement('a');
            a.href = img.src;
            a.download = `giveme-pixel-${currentSharePostId}.png`;
            a.click();
        }
    }
    document.getElementById('shareModal').classList.remove('show');
    earnCoin('share');
}

function copyShareLink() {
    const input = document.getElementById('shareLinkInput');
    input.select();
    document.execCommand('copy');
    earnCoin('copy-link');
    const btn = input.nextElementSibling;
    btn.textContent = 'Skopírované!';
    setTimeout(() => btn.textContent = 'Kopírovať', 2000);
}

// =============================================
// STORIES
// =============================================

function openStory(index) {
    const story = storyData[index];
    document.getElementById('storyViewerAvatar').textContent = story.avatar;
    document.getElementById('storyViewerName').textContent = story.name;

    const canvas = document.getElementById('storyCanvas');
    generateStoryArt(canvas);

    const modal = document.getElementById('storyModal');
    modal.classList.add('show');

    // Reset and start progress
    const segments = document.querySelectorAll('.story-progress-segment');
    segments.forEach(s => {
        s.classList.remove('active', 'completed');
        s.querySelector('.fill').style.width = '0%';
    });
    segments[0].classList.add('active');

    earnCoin('view-story');

    // Auto progress
    let currentSegment = 0;
    clearInterval(storyTimer);
    storyTimer = setInterval(() => {
        segments[currentSegment].classList.remove('active');
        segments[currentSegment].classList.add('completed');
        currentSegment++;
        if (currentSegment < segments.length) {
            segments[currentSegment].classList.add('active');
            generateStoryArt(canvas);
        } else {
            closeStory();
        }
    }, 5000);
}

function closeStory() {
    clearInterval(storyTimer);
    document.getElementById('storyModal').classList.remove('show');
}

function handleStoryReply(event) {
    if (event.key === 'Enter' && event.target.value.trim()) {
        earnCoin('story-reply');
        event.target.value = '';
    }
}

function likeStory() {
    earnCoin('story-like');
}

function sendStoryCoin() {
    if (totalCoins > 0) {
        totalCoins--;
        updateCoinDisplay();
        setTimeout(() => earnCoin('story-coin'), 300);
        createFloatingCoin();
    }
}

function shareStory() {
    earnCoin('story-share');
}

function openCreateStory() {
    openCreateModal();
}

// =============================================
// CREATE POST
// =============================================

function pickRandomPrompt() {
    const input = document.getElementById('createPromptInput');
    if (input) {
        input.value = PROMPT_SUGGESTIONS[Math.floor(Math.random() * PROMPT_SUGGESTIONS.length)];
    }
}

function renderPromptSuggestions() {
    const el = document.getElementById('promptSuggestions');
    if (!el) return;
    el.innerHTML = '';
    const shown = PROMPT_SUGGESTIONS.slice(0, 8);
    shown.forEach(p => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'create-prompt-chip';
        chip.textContent = p;
        chip.onclick = () => {
            const input = document.getElementById('createPromptInput');
            if (input) input.value = p;
        };
        el.appendChild(chip);
    });
}

function handleCreateClick(ev) {
    if (ev) ev.preventDefault();
    try {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const btn = document.getElementById('nav-btn-create');
        if (btn) btn.classList.add('active');
        openCreateModal();
    } catch (e) {
        console.error('[gIVEME] handleCreateClick:', e);
    }
}

function openCreateModal() {
    try {
        if (window.parent !== window) window.parent.postMessage({ type: 'giveme_requestSync' }, '*');
        const modal = document.getElementById('createModal');
        if (!modal) {
            console.warn('[gIVEME] createModal element not found');
            return;
        }
        modal.classList.add('show');

        const promptInput = document.getElementById('createPromptInput');
        const captionInput = document.getElementById('createCaptionInput');
        if (promptInput) promptInput.value = '';
        if (captionInput) captionInput.value = '';

        pickRandomPrompt();
        renderPromptSuggestions();
        initCreateCanvas();
        initColorPalette();
    } catch (e) {
        console.error('[gIVEME] openCreateModal:', e);
    }
}

function closeCreateModal() {
    const modal = document.getElementById('createModal');
    if (modal) modal.classList.remove('show');
}

function clearCanvas() {
    const canvas = document.getElementById('createCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function initColorPalette() {
    const paletteEl = document.getElementById('colorPalette');
    paletteEl.innerHTML = '';
    const colors = [
        '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
        '#3498db', '#9b59b6', '#e056a0', '#ffffff', '#000000',
        '#95a5a6', '#d35400', '#8e44ad', '#2c3e50', '#c0392b',
        '#27ae60'
    ];
    colors.forEach(color => {
        const swatch = document.createElement('div');
        swatch.className = 'color-swatch' + (color === currentColor ? ' active' : '');
        swatch.style.background = color;
        swatch.onclick = () => {
            currentColor = color;
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
            swatch.classList.add('active');
        };
        paletteEl.appendChild(swatch);
    });
}

function initCreateCanvas() {
    const canvas = document.getElementById('createCanvas');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Mouse events
    canvas.onmousedown = (e) => {
        isDrawing = true;
        drawPixel(e, canvas);
    };
    canvas.onmousemove = (e) => {
        if (isDrawing) drawPixel(e, canvas);
    };
    canvas.onmouseup = () => isDrawing = false;
    canvas.onmouseleave = () => isDrawing = false;

    // Touch events
    canvas.ontouchstart = (e) => {
        e.preventDefault();
        isDrawing = true;
        drawPixelTouch(e, canvas);
    };
    canvas.ontouchmove = (e) => {
        e.preventDefault();
        if (isDrawing) drawPixelTouch(e, canvas);
    };
    canvas.ontouchend = () => isDrawing = false;
}

function drawPixel(e, canvas) {
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);
    ctx.fillStyle = currentColor;
    ctx.fillRect(x, y, 1, 1);
}

function drawPixelTouch(e, canvas) {
    const touch = e.touches[0];
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor((touch.clientX - rect.left) * scaleX);
    const y = Math.floor((touch.clientY - rect.top) * scaleY);
    ctx.fillStyle = currentColor;
    ctx.fillRect(x, y, 1, 1);
}

async function publishPost() {
    const canvas = document.getElementById('createCanvas');
    const captionInput = document.getElementById('createCaptionInput');
    const promptInput = document.getElementById('createPromptInput');
    const caption = (captionInput?.value || '').trim();
    const prompt = (promptInput?.value || '').trim();

    const me = getCurrentUser();
    if (!me) {
        alert('Prihlás sa, aby si mohol uverejniť pixel art.');
        closeCreateModal();
        return;
    }

    if (!canvas || !supabase) {
        closeCreateModal();
        return;
    }

    const imageData = canvas.toDataURL('image/png');

    try {
        const { error } = await supabase.from('giveme_posts').insert({
            author_id: me.uid,
            image_data: imageData,
            caption: caption || null,
            prompt: prompt || null
        });
        if (error) throw error;
        closeCreateModal();
        earnCoin('publish');
        coinRainEffect();
        loadFeed();
    } catch (e) {
        console.warn('[gIVEME] publishPost:', e);
        alert('Chyba pri uverejnení. Skús znova.');
    }
}

// =============================================
// NAVIGATION
// =============================================

function setActiveNav(el) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
    earnCoin('navigate');
}

// =============================================
// INITIALIZATION
// =============================================

window.addEventListener('message', (e) => {
    if (!e.data) return;
    if (e.data.type === 'giveme_syncCoins') syncCoinsFromParent();
    // Parent posiela user context (gIVEME účet prepojený s Google)
    if (e.data.type === 'giveme_syncUser') {
        try {
            const user = e.data.user;
            if (user && user.uid) {
                sessionStorage.setItem('givemegame_user', JSON.stringify(user));
            } else {
                sessionStorage.removeItem('givemegame_user');
            }
            loadFeed();
            updateConnectionBanner();
        } catch (err) {}
    }
});
function updateConnectionBanner() {
    const existing = document.getElementById('giveme-connection-banner');
    if (existing) existing.remove();
    const user = getCurrentUser();
    const header = document.querySelector('.header');
    if (!header) return;
    if (user && window.parent !== window) {
        const banner = document.createElement('div');
        banner.id = 'giveme-connection-banner';
        banner.className = 'connection-banner connected';
        banner.innerHTML = '<span>✅ Prepojené s účtom: ' + (user.name || user.email || '') + '</span>';
        header.insertAdjacentElement('afterend', banner);
    } else if (!user && window.parent !== window) {
        const banner = document.createElement('div');
        banner.id = 'giveme-connection-banner';
        banner.className = 'guest-banner';
        banner.innerHTML = '<span>🔐 Prihlás sa cez Google pre uverejňovanie a plný prístup</span><a href="../login.html" target="_top">Prihlásiť</a>';
        header.insertAdjacentElement('afterend', banner);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Sync auth z Supabase (rovnaký projekt = rovnaká session)
    await syncAuthFromSupabase();
    syncCoinsFromParent();
    // 2. Ak sme v iframe, požiadaj parent o sync (user + coiny)
    try {
        if (window.parent !== window) {
            window.parent.postMessage({ type: 'giveme_requestSync' }, '*');
            setTimeout(() => window.parent.postMessage({ type: 'giveme_requestSync' }, '*'), 500);
        }
    } catch (e) {}
    loadFeed();
    updateConnectionBanner();
});