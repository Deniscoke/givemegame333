#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Spustenie Supabase migrácií
   Použitie: node scripts/run-supabase-migrations.js
   Potrebuje: SUPABASE_DB_URL v .env (z Supabase Dashboard → Settings → Database)
   ═══════════════════════════════════════════════════════════════════ */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
const order = [
  '001_profiles_and_follows.sql',
  '002_add_coins_to_profiles.sql',
  '003_giveme_social.sql',
  '004_add_prompt_to_posts.sql',
  '005_quest_log.sql',
  '006_coin_transactions.sql',
  '007_add_scoreboard_to_profiles.sql',
  '008_smarta_styles.sql'
];

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url || url.includes('your-')) {
    console.error(`
❌ Chýba SUPABASE_DB_URL v .env

Postup:
1. Otvor https://supabase.com/dashboard → tvoj projekt vhpkkbixshfyytohkruv
2. Project Settings → Database
3. Skopíruj "Connection string" (URI) — Session mode
4. Pridaj do .env:
   SUPABASE_DB_URL=postgresql://postgres.[PROJECT]:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres

   (Nahraď [PASSWORD] heslom z Database settings)
`);
    process.exit(1);
  }

  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    console.error('❌ Nainštaluj pg: npm install pg');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    console.log('✅ Pripojené k Supabase DB\n');
  } catch (e) {
    console.error('❌ Pripojenie zlyhalo:', e.message);
    process.exit(1);
  }

  for (const file of order) {
    const filePath = path.join(migrationsDir, file);
    if (!fs.existsSync(filePath)) {
      console.log(`⏭️  Preskočené (neexistuje): ${file}`);
      continue;
    }
    const sql = fs.readFileSync(filePath, 'utf-8');
    try {
      await client.query(sql);
      console.log(`✅ ${file}`);
    } catch (e) {
      if (e.code === '42P07' || e.message?.includes('already exists')) {
        console.log(`⏭️  ${file} (už existuje)`);
      } else {
        console.error(`❌ ${file}:`, e.message);
        await client.end();
        process.exit(1);
      }
    }
  }

  await client.end();
  console.log('\n✅ Migrácie dokončené. Tabuľka profiles s coins je pripravená.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
