'use strict';
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Preload for local development (node -r ./scripts/load-local-env.js)

   Loads .env.local BEFORE server.js / the migration runner run their own
   dotenv.config() (which never overrides variables that are already set),
   so .env.local always wins over .env. Falls back to the local Supabase
   database URL and refuses to continue if SUPABASE_URL or SUPABASE_DB_URL
   point anywhere other than 127.0.0.1 / localhost.
   ═══════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const LOCAL_ENV_PATH = path.join(__dirname, '..', '.env.local');
const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLocal(value) {
	try {
		return LOCAL_HOSTS.has(new URL(value).hostname);
	} catch {
		return false;
	}
}

const isServer = path.basename(process.argv[1] || '') === 'server.js';

if (fs.existsSync(LOCAL_ENV_PATH)) {
	require('dotenv').config({ path: LOCAL_ENV_PATH, override: true });
} else if (isServer) {
	console.error('[local-env] .env.local is missing. Run: npm run db:local:env');
	process.exit(1);
}
if (isServer && (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)) {
	console.error('[local-env] .env.local must set SUPABASE_URL and SUPABASE_ANON_KEY. Run: npm run db:local:env');
	process.exit(1);
}
if (!process.env.SUPABASE_DB_URL) process.env.SUPABASE_DB_URL = LOCAL_DB_URL;

for (const name of ['SUPABASE_URL', 'SUPABASE_DB_URL']) {
	const value = process.env[name];
	if (value && !isLocal(value)) {
		console.error(`[local-env] ${name} is not a local address; refusing to start. Check .env.local.`);
		process.exit(1);
	}
}
