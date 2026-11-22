'use strict';

/**
 * gIVEMEGAME.IO — text-to-speech providers for SMARTA (server side only).
 *
 * Order of preference: ElevenLabs (when ELEVENLABS_API_KEY and
 * ELEVENLABS_VOICE_ID are set), then OpenAI (OPENAI_API_KEY), and when neither
 * is configured the route answers 503 so the browser falls back to the free
 * Web Speech voice. A provider that fails hands over to the next one.
 *
 * Audio is cached in memory by a hash of provider + voice + style + text, so
 * the same sentence is never paid for twice on one instance. No database.
 * The plan gate (Pro) stays in the /api/tts route, before this module runs.
 */

const crypto = require('node:crypto');

const TTS_VOICES = ['marin', 'cedar', 'onyx', 'sage', 'coral', 'nova', 'alloy'];
const TTS_STYLE_CONFIG = {
	sangvinik: { voice: 'coral', speed: 1.15, instructions: 'Speak enthusiastically and energetically. Warm, upbeat tone. Slightly faster pace. Expressive intonation with excitement.' },
	flegmatik: { voice: 'sage', speed: 0.9, instructions: 'Speak calmly and gently. Slow, relaxed pace. Soothing, patient tone. Peaceful delivery.' },
	cholerik: { voice: 'onyx', speed: 1.2, instructions: 'Speak with confidence and assertiveness. Direct, punchy delivery. Clear and decisive. Strong, determined tone.' },
	melancholik: { voice: 'cedar', speed: 0.92, instructions: 'Speak thoughtfully and reflectively. Gentle, nuanced tone. Slightly slower, contemplative pace. Introspective delivery.' },
	genz: { voice: 'nova', speed: 1.05, instructions: 'Speak casually and conversationally. Relaxed, friendly tone. Natural, laid-back delivery.' }
};

const OPENAI_MAX_CHARS = 4096;
const ELEVENLABS_MAX_CHARS = 2500;
const DEFAULT_TIMEOUT_MS = 25000;
const PLACEHOLDER_KEY = 'sk-your-openai-api-key-here';

/** Provider failure that carries an HTTP status for the route. */
class TtsError extends Error {
	constructor(message, status) {
		super(message);
		this.name = 'TtsError';
		this.status = status;
	}
}

function openAiKey(env) {
	const k = env.OPENAI_API_KEY;
	return k && k !== PLACEHOLDER_KEY ? k : '';
}

/** ElevenLabs voice ids are short alphanumeric strings; anything else would end up in a URL path. */
function elevenLabsVoiceId(env) {
	const id = (env.ELEVENLABS_VOICE_ID || '').trim();
	return /^[A-Za-z0-9]{8,64}$/.test(id) ? id : '';
}

function elevenLabsConfigured(env) {
	return Boolean((env.ELEVENLABS_API_KEY || '').trim() && elevenLabsVoiceId(env));
}

/** @returns {string[]} configured provider names in the order they are tried */
function getProviderOrder(env = process.env) {
	const order = [];
	if (elevenLabsConfigured(env)) order.push('elevenlabs');
	if (openAiKey(env)) order.push('openai');
	return order;
}

/** Voice, speed and delivery instructions for the OpenAI request. */
function resolveOpenAiVoice(voiceName, styles) {
	let voice = TTS_VOICES.includes(voiceName) ? voiceName : 'marin';
	let speed = 1;
	let instructions = 'Speak in a calm, engaging narrative tone like a storyteller. Moderate pace, clear pronunciation.';
	const list = Array.isArray(styles) ? styles : [];
	const cfg = list.length > 0 ? TTS_STYLE_CONFIG[list[0]] : null;
	if (cfg) {
		voice = cfg.voice;
		speed = cfg.speed;
		instructions = cfg.instructions;
		if (list.length > 1) {
			instructions += ' Also incorporate: ' + list.slice(1).map((s) => TTS_STYLE_CONFIG[s]?.instructions?.split('.')[0] || s).join('. ');
		}
	}
	return { voice, speed, instructions };
}

async function readErrorBody(response) {
	const text = await response.text().catch(() => '');
	return text.slice(0, 200);
}

function createOpenAiProvider({ env, fetchImpl, timeoutMs }) {
	return {
		name: 'openai',
		async synthesize({ text, voice, styles }) {
			const input = text.length > OPENAI_MAX_CHARS ? text.slice(0, OPENAI_MAX_CHARS) : text;
			const v = resolveOpenAiVoice(voice, styles);
			const response = await fetchImpl('https://api.openai.com/v1/audio/speech', {
				method: 'POST',
				signal: AbortSignal.timeout(timeoutMs),
				headers: { Authorization: `Bearer ${openAiKey(env)}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
					voice: v.voice,
					input,
					speed: v.speed,
					instructions: v.instructions,
					response_format: 'mp3'
				})
			});
			if (!response.ok) {
				console.error('[TTS] OpenAI:', response.status, await readErrorBody(response));
				throw new TtsError(`TTS chyba: ${response.status}`, response.status >= 500 ? 502 : response.status);
			}
			return { audio: Buffer.from(await response.arrayBuffer()), contentType: 'audio/mpeg' };
		}
	};
}

function createElevenLabsProvider({ env, fetchImpl, timeoutMs }) {
	return {
		name: 'elevenlabs',
		async synthesize({ text }) {
			const input = text.length > ELEVENLABS_MAX_CHARS ? text.slice(0, ELEVENLABS_MAX_CHARS) : text;
			const url = `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId(env)}?output_format=mp3_44100_128`;
			const response = await fetchImpl(url, {
				method: 'POST',
				signal: AbortSignal.timeout(timeoutMs),
				headers: { 'xi-api-key': env.ELEVENLABS_API_KEY.trim(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
				body: JSON.stringify({ text: input, model_id: env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2' })
			});
			if (!response.ok) {
				console.error('[TTS] ElevenLabs:', response.status, await readErrorBody(response));
				throw new TtsError(`TTS chyba: ${response.status}`, response.status >= 500 ? 502 : response.status);
			}
			return { audio: Buffer.from(await response.arrayBuffer()), contentType: 'audio/mpeg' };
		}
	};
}

/**
 * Small in-memory LRU bounded by entry count and total bytes.
 * @param {{ maxEntries?: number, maxBytes?: number }} [opts]
 */
function createAudioCache({ maxEntries = 64, maxBytes = 16 * 1024 * 1024 } = {}) {
	const map = new Map();
	let bytes = 0;
	return {
		get(key) {
			const hit = map.get(key);
			if (!hit) return null;
			map.delete(key);
			map.set(key, hit); // most recently used goes last
			return hit;
		},
		set(key, value) {
			if (value.audio.length > maxBytes) return;
			const old = map.get(key);
			if (old) { bytes -= old.audio.length; map.delete(key); }
			map.set(key, value);
			bytes += value.audio.length;
			for (const k of map.keys()) {
				if (map.size <= maxEntries && bytes <= maxBytes) break;
				bytes -= map.get(k).audio.length;
				map.delete(k);
			}
		},
		size: () => map.size,
		bytes: () => bytes,
		clear() { map.clear(); bytes = 0; }
	};
}

const sharedCache = createAudioCache();

function cacheKey(provider, { text, voice, styles }) {
	const style = Array.isArray(styles) ? styles.join(',') : '';
	return crypto.createHash('sha256').update(`${provider}\n${voice || ''}\n${style}\n${text}`).digest('hex');
}

/**
 * Turn text into speech with the first provider that works.
 * Resolves { audio, contentType, provider, cached }. Rejects with
 * TtsError(503) when no provider is configured (the browser then uses Web
 * Speech), or with the last provider error when all configured ones fail.
 *
 * @param {{ text: string, voice?: string, styles?: string[] }} req
 * @param {{ env?: object, fetchImpl?: Function, cache?: ReturnType<typeof createAudioCache>, timeoutMs?: number }} [deps]
 */
async function synthesizeSpeech(req, deps = {}) {
	const env = deps.env || process.env;
	const fetchImpl = deps.fetchImpl || fetch;
	const cache = deps.cache || sharedCache;
	const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
	const order = getProviderOrder(env);
	if (!order.length) throw new TtsError('TTS nie je nakonfigurované. Použi Web Speech.', 503);

	const factories = { elevenlabs: createElevenLabsProvider, openai: createOpenAiProvider };
	let lastError = null;
	for (const name of order) {
		const key = cacheKey(name, req);
		const hit = cache.get(key);
		if (hit) return { ...hit, provider: name, cached: true };
		try {
			const out = await factories[name]({ env, fetchImpl, timeoutMs }).synthesize(req);
			cache.set(key, out);
			return { ...out, provider: name, cached: false };
		} catch (e) {
			lastError = e instanceof TtsError ? e : new TtsError('Nepodarilo sa vygenerovať audio.', 502);
			if (!(e instanceof TtsError)) console.error(`[TTS] ${name}:`, e.message);
		}
	}
	throw lastError;
}

module.exports = {
	TTS_VOICES,
	TTS_STYLE_CONFIG,
	TtsError,
	getProviderOrder,
	resolveOpenAiVoice,
	createAudioCache,
	synthesizeSpeech
};
