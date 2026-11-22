'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getProviderOrder, synthesizeSpeech, createAudioCache, TtsError } = require('../lib/tts-providers');

const BOTH = { OPENAI_API_KEY: 'sk-test-openai', ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_VOICE_ID: 'abcDEF1234567890' };
const OPENAI_ONLY = { OPENAI_API_KEY: 'sk-test-openai' };

function okResponse(bytes = 'mp3') {
	return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(bytes), text: async () => '' };
}
function failResponse(status) {
	return { ok: false, status, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'boom' };
}
function recorder(handler) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url: String(url), init });
		return handler(String(url), init);
	};
	fn.calls = calls;
	return fn;
}

describe('TTS provider order', () => {
	it('prefers elevenlabs, then openai', () => {
		assert.deepEqual(getProviderOrder(BOTH), ['elevenlabs', 'openai']);
	});
	it('uses openai alone when elevenlabs is not fully configured', () => {
		assert.deepEqual(getProviderOrder(OPENAI_ONLY), ['openai']);
		assert.deepEqual(getProviderOrder({ ...OPENAI_ONLY, ELEVENLABS_API_KEY: 'xi' }), ['openai']);
		assert.deepEqual(getProviderOrder({ ...OPENAI_ONLY, ELEVENLABS_API_KEY: 'xi', ELEVENLABS_VOICE_ID: '../etc' }), ['openai']);
	});
	it('has no server provider without keys (client falls back to Web Speech)', () => {
		assert.deepEqual(getProviderOrder({}), []);
		assert.deepEqual(getProviderOrder({ OPENAI_API_KEY: 'sk-your-openai-api-key-here' }), []);
	});
});

describe('synthesizeSpeech', () => {
	it('calls elevenlabs first when configured', async () => {
		const fetchImpl = recorder(() => okResponse('eleven'));
		const out = await synthesizeSpeech({ text: 'Ahoj' }, { env: BOTH, fetchImpl, cache: createAudioCache() });
		assert.equal(out.provider, 'elevenlabs');
		assert.equal(fetchImpl.calls.length, 1);
		assert.match(fetchImpl.calls[0].url, /api\.elevenlabs\.io\/v1\/text-to-speech\/abcDEF1234567890/);
		assert.equal(fetchImpl.calls[0].init.headers['xi-api-key'], 'xi-test');
	});

	it('falls back to openai when elevenlabs fails', async () => {
		const fetchImpl = recorder((url) => (url.includes('elevenlabs') ? failResponse(500) : okResponse('openai')));
		const out = await synthesizeSpeech({ text: 'Ahoj' }, { env: BOTH, fetchImpl, cache: createAudioCache() });
		assert.equal(out.provider, 'openai');
		assert.deepEqual(fetchImpl.calls.map((c) => new URL(c.url).hostname), ['api.elevenlabs.io', 'api.openai.com']);
	});

	it('goes straight to openai when elevenlabs is not configured', async () => {
		const fetchImpl = recorder(() => okResponse());
		const out = await synthesizeSpeech({ text: 'Ahoj', styles: ['flegmatik'] }, { env: OPENAI_ONLY, fetchImpl, cache: createAudioCache() });
		assert.equal(out.provider, 'openai');
		assert.equal(fetchImpl.calls.length, 1);
		assert.equal(JSON.parse(fetchImpl.calls[0].init.body).voice, 'sage');
	});

	it('answers 503 without any provider, without a network call', async () => {
		const fetchImpl = recorder(() => okResponse());
		await assert.rejects(
			synthesizeSpeech({ text: 'Ahoj' }, { env: {}, fetchImpl, cache: createAudioCache() }),
			(e) => e instanceof TtsError && e.status === 503
		);
		assert.equal(fetchImpl.calls.length, 0);
	});

	it('rejects with the provider status when every provider fails', async () => {
		const fetchImpl = recorder(() => failResponse(429));
		await assert.rejects(
			synthesizeSpeech({ text: 'Ahoj' }, { env: BOTH, fetchImpl, cache: createAudioCache() }),
			(e) => e.status === 429
		);
		assert.equal(fetchImpl.calls.length, 2);
	});

	it('serves a repeated sentence from the cache', async () => {
		const fetchImpl = recorder(() => okResponse());
		const cache = createAudioCache();
		const first = await synthesizeSpeech({ text: 'Ahoj' }, { env: OPENAI_ONLY, fetchImpl, cache });
		const second = await synthesizeSpeech({ text: 'Ahoj' }, { env: OPENAI_ONLY, fetchImpl, cache });
		assert.equal(first.cached, false);
		assert.equal(second.cached, true);
		assert.equal(fetchImpl.calls.length, 1);
	});
});

describe('audio cache', () => {
	it('evicts the least recently used entry', () => {
		const cache = createAudioCache({ maxEntries: 2 });
		const v = () => ({ audio: Buffer.from('x'), contentType: 'audio/mpeg' });
		cache.set('a', v());
		cache.set('b', v());
		cache.get('a');
		cache.set('c', v());
		assert.ok(cache.get('a'));
		assert.equal(cache.get('b'), null);
		assert.ok(cache.get('c'));
	});
});
