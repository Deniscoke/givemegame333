'use strict';
// The phone buzz awards coins every 30 s. It must not run in a hidden tab and
// must stop once the server reports the daily cap, instead of retrying all day.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const script = read('public/script.js');
const coins = read('public/js/coins.js');

describe('phone buzz coin source', () => {
	it('skips the award while the tab is hidden', () => {
		const start = script.slice(script.indexOf('function startPhoneVibrate'), script.indexOf('function stopPhoneVibrate'));
		assert.match(start, /document\.visibilityState !== 'visible'\) return;/);
		assert.ok(start.indexOf('visibilityState') < start.indexOf("Coins.award('phone_buzz')"));
	});

	it('coins.js announces a reached daily cap', () => {
		assert.match(coins, /r\.data\?\.code === 'COIN_DAILY_CAP'\) \{\n\t+\/\/[^\n]*\n\t+try \{ window\.dispatchEvent\(new CustomEvent\('givemegame:coin-cap', \{ detail: \{ action \} \}\)\); \}/);
	});

	it('stops the buzz when its cap is reached', () => {
		assert.match(script, /addEventListener\('givemegame:coin-cap', \(e\) => \{\n\t+if \(e\.detail\?\.action === 'phone_buzz'\) stopPhoneVibrate\(\);/);
	});
});
