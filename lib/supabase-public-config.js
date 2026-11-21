'use strict';
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Public Supabase config for the browser
   Served as GET /supabase-config.js. The anon key is public by design
   (RLS protects the data); never put a service_role key here.
   ═══════════════════════════════════════════════════════════════════ */

const PRODUCTION_SUPABASE_URL = 'https://vhpkkbixshfyytohkruv.supabase.co';
const PRODUCTION_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZocGtrYml4c2hmeXl0b2hrcnV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMDAzNzcsImV4cCI6MjA4ODY3NjM3N30.umrrhSqC9LW2Wlcs5y4uCViVfZmqyHcMbaPQaQiMbR0';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * @param {string} value
 * @returns {URL|null}
 */
function parseHttpUrl(value) {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		if (url.username || url.password) return null;
		return url;
	} catch {
		return null;
	}
}

/**
 * @param {URL} url
 * @returns {boolean}
 */
function isLocalUrl(url) {
	return LOCAL_HOSTNAMES.has(url.hostname);
}

/**
 * Builds the browser-facing Supabase config from server env.
 * Falls back to the production project when env is missing or invalid.
 * Plain http is accepted only for local hosts.
 * @param {Record<string, string|undefined>} env
 * @returns {{ url: string, anonKey: string, passwordLogin: boolean }}
 */
function buildSupabasePublicConfig(env = {}) {
	const parsed = parseHttpUrl(env.SUPABASE_URL);
	const usable = parsed && (parsed.protocol === 'https:' || isLocalUrl(parsed)) ? parsed : null;
	const anonKey = typeof env.SUPABASE_ANON_KEY === 'string' ? env.SUPABASE_ANON_KEY.trim() : '';
	if (!usable || !anonKey || !/^[A-Za-z0-9._-]+$/.test(anonKey)) {
		return {
			url: PRODUCTION_SUPABASE_URL,
			anonKey: PRODUCTION_SUPABASE_ANON_KEY,
			passwordLogin: false
		};
	}
	return {
		url: usable.origin,
		anonKey,
		passwordLogin: isLocalUrl(usable)
	};
}

/**
 * @param {{ url: string, anonKey: string, passwordLogin: boolean }} config
 * @returns {string}
 */
function renderSupabaseConfigScript(config) {
	const json = JSON.stringify({
		url: config.url,
		anonKey: config.anonKey,
		passwordLogin: config.passwordLogin === true
	}).replace(/</g, '\\u003c');
	return `window.GMG_SUPABASE = Object.freeze(${json});\n`;
}

/**
 * Extra CSP origin needed when the configured Supabase URL is not covered
 * by https://*.supabase.co (e.g. a local stack on http://127.0.0.1:55321).
 * @param {{ url: string }} config
 * @returns {string}
 */
function extraCspOrigin(config) {
	const url = parseHttpUrl(config && config.url);
	if (!url) return '';
	if (url.protocol === 'https:' && url.hostname.endsWith('.supabase.co')) return '';
	return url.origin;
}

module.exports = {
	PRODUCTION_SUPABASE_URL,
	PRODUCTION_SUPABASE_ANON_KEY,
	buildSupabasePublicConfig,
	renderSupabaseConfigScript,
	extraCspOrigin
};
