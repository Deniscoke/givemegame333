'use strict';
// Review fixes for phase 8: paid TTS is limited per user, the ElevenLabs cache
// is not split by ignored fields, and the dock keeps a typed question.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { synthesizeSpeech, createAudioCache } = require('../lib/tts-providers');
const { createDailyCounter } = require('../lib/routes/smarta');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('phase 8 review fixes', () => {
	it('daily counter can add a weighted amount (characters)', () => {
		const c = createDailyCounter();
		c.add('u1', 1200);
		c.add('u1', 300);
		assert.equal(c.used('u1'), 1500);
		assert.equal(c.used('u2'), 0);
	});

	it('/api/tts checks the rate limit and the daily character cap before synthesizing', () => {
		const src = read('server.js');
		const start = src.indexOf("app.post('/api/tts'");
		const route = src.slice(start, src.indexOf('synthesizeSpeech({', start));
		assert.match(route, /ttsLimiter\.check\(ttsUser\.id\)/);
		assert.match(route, /TTS_DAILY_CAP/);
		assert.match(route, /ttsCharsToday\.add\(ttsUser\.id, chars\)/);
	});

	it('ElevenLabs cache ignores voice and styles', async () => {
		const env = { ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_VOICE_ID: 'abcDEF1234567890' };
		let calls = 0;
		const fetchImpl = async () => {
			calls++;
			return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('mp3'), text: async () => '' };
		};
		const cache = createAudioCache();
		await synthesizeSpeech({ text: 'Ahoj', voice: 'a' }, { env, fetchImpl, cache });
		const second = await synthesizeSpeech({ text: 'Ahoj', voice: 'zzz', styles: ['genz'] }, { env, fetchImpl, cache });
		assert.equal(calls, 1);
		assert.equal(second.cached, true);
	});

	it('narrator falls back to Web Speech on a 429 from /api/tts', () => {
		assert.match(read('public/js/narrator.js'), /res\.status === 429 \|\| res\.status === 502/);
	});

	it('dock keeps the typed question while busy and closes the drawer before opening chat', () => {
		const dock = read('public/js/smarta-dock.js');
		assert.match(dock, /if \(busy \|\| !input\.value\.trim\(\)\) return;\n\t+const text = input\.value;/);
		assert.match(dock, /let factBusy = false;/);
		assert.match(dock, /GameUI\?\.closeTools\?\.\(false\);[^\n]*\n\t+setState\('open'\);/);
	});
});
