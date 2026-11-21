'use strict';

// Static (DOM-free) guards for public/gIVEME/script.js:
//  - user-controlled fields must never be interpolated raw into HTML strings
//  - images must be built through createSafeImg() (no `<img` in HTML strings)
//  - esc() escapes & < > " '
//  - safeImageSrc() only accepts safe data:image URIs and the project's Supabase storage host
//  - the old `let supabase` global collision stays fixed (socialSupabase)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'public', 'gIVEME', 'script.js');
const source = fs.readFileSync(SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n');

// Fields that come from the database / other users.
const USER_FIELD_RE = /\b(image_data|display_name|displayName|avatar_url|avatar|caption|prompt|content|photo|email|bio|name)\b/;

function findMatching(str, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === open) depth++;
    else if (str[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Return every `${...}` expression in the source (including nested ones).
function templateExpressions(str) {
  const out = [];
  let idx = str.indexOf('${');
  while (idx !== -1) {
    const end = findMatching(str, idx + 1, '{', '}');
    if (end === -1) break;
    out.push({ expr: str.slice(idx + 2, end), line: str.slice(0, idx).split('\n').length });
    idx = str.indexOf('${', idx + 2);
  }
  return out;
}

// Remove esc(...)/safeId(...)/encodeURIComponent(...) calls and nested `${...}` blocks.
function stripSafeParts(expr) {
  let s = expr;
  for (const fn of ['esc(', 'safeId(', 'encodeURIComponent(']) {
    let i = s.indexOf(fn);
    while (i !== -1) {
      const end = findMatching(s, i + fn.length - 1, '(', ')');
      if (end === -1) break;
      s = s.slice(0, i) + 'SAFE' + s.slice(end + 1);
      i = s.indexOf(fn);
    }
  }
  let j = s.indexOf('${');
  while (j !== -1) {
    const end = findMatching(s, j + 1, '{', '}');
    if (end === -1) break;
    s = s.slice(0, j) + s.slice(end + 1);
    j = s.indexOf('${');
  }
  return s;
}

function loadHelpers() {
  const start = source.indexOf('// ===== XSS HELPERS =====');
  const end = source.indexOf('// ===== FOLLOW API');
  assert.ok(start !== -1 && end > start, 'XSS helper block must exist in gIVEME/script.js');
  const urlLine = source.match(/const SUPABASE_URL = '[^']+';/);
  assert.ok(urlLine, 'SUPABASE_URL constant must exist');
  const avatarFn = source.match(/function getAvatarEmoji\(name\) \{[\s\S]*?\n\}/);
  assert.ok(avatarFn, 'getAvatarEmoji must exist');
  const code = `${urlLine[0]}\n${avatarFn[0]}\n${source.slice(start, end)}\n` +
    'this.esc = esc; this.escapeHTML = escapeHTML; this.safeId = safeId; this.safeImageSrc = safeImageSrc;';
  const ctx = { URL };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ...ctx, SUPABASE_URL: urlLine[0].match(/'([^']+)'/)[1] };
}

test('esc escapes & < > " and \'', () => {
  const { esc, escapeHTML } = loadHelpers();
  assert.equal(esc(`<img src=x onerror="alert('x')">&`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
  assert.equal(escapeHTML, esc, 'escapeHTML must be the quote-escaping esc helper');
});

test('safeId strips everything that could break out of an inline handler', () => {
  const { safeId } = loadHelpers();
  assert.equal(safeId('10000000-0000-4000-8000-000000000001'), '10000000-0000-4000-8000-000000000001');
  assert.equal(safeId("x');alert(1);('"), 'xalert1');
  assert.equal(safeId(null), '');
});

test('safeImageSrc accepts only safe data:image URIs and project storage URLs', () => {
  const { safeImageSrc, SUPABASE_URL } = loadHelpers();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal(safeImageSrc(png), png);
  assert.ok(safeImageSrc('data:image/webp;base64,AAAA'));
  assert.ok(safeImageSrc('data:image/jpeg;base64,AAAA'));

  const storage = `${SUPABASE_URL}/storage/v1/object/public/avatars/a.png`;
  assert.equal(safeImageSrc(storage), storage);

  const rejected = [
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,AAAA" onerror="alert(1)',
    'javascript:alert(1)',
    'x" onerror="alert(1)',
    `${SUPABASE_URL.replace('https:', 'http:')}/storage/v1/object/public/a.png`,
    `${SUPABASE_URL}/rest/v1/profiles`,
    'https://evil.example.com/storage/v1/object/public/a.png',
    `https://user:pw@${new URL(SUPABASE_URL).host}/storage/v1/object/public/a.png`,
    'https://lh3.googleusercontent.com/a/photo',
    '',
    null,
    {}
  ];
  for (const src of rejected) {
    assert.equal(safeImageSrc(src), null, `must reject ${JSON.stringify(src)}`);
  }
  // Google profile photos are allowed only for avatars.
  assert.ok(safeImageSrc('https://lh3.googleusercontent.com/a/photo', { avatar: true }));
  assert.equal(safeImageSrc('https://evil.example.com/a.png', { avatar: true }), null);
});

test('no image_data or other user field is interpolated raw into template strings', () => {
  const offenders = [];
  for (const { expr, line } of templateExpressions(source)) {
    if (/image_data/.test(expr)) offenders.push(`line ${line}: \${${expr}}`);
    const rest = stripSafeParts(expr)
      // Drop literal text (string / template literal contents are not values).
      .replace(/`[^`]*`/g, "''")
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      // A field used only as a boolean condition (`x.prompt ? ... : ''`) is fine.
      .replace(/[\w.?]+\s*\?(?!\.)/g, 'COND ?');
    if (USER_FIELD_RE.test(rest)) offenders.push(`line ${line}: \${${expr.trim().slice(0, 120)}}`);
  }
  assert.deepEqual(offenders, [], 'unescaped user fields in template strings');
});

test('HTML string concatenation into innerHTML/insertAdjacentHTML/outerHTML only uses esc()', () => {
  const offenders = [];
  const sinkRe = /\.(innerHTML|outerHTML)\s*=\s*([^;]+);|insertAdjacentHTML\(([^;]+)\);/g;
  let m;
  while ((m = sinkRe.exec(source)) !== null) {
    const rhs = m[2] || m[3];
    if (rhs.trim().startsWith('`')) continue; // template literals are covered by the test above
    const rest = stripSafeParts(rhs).replace(/'(?:[^'\\]|\\.)*'/g, "''");
    if (/\+/.test(rest) && /[A-Za-z_$][\w$.]*/.test(rest.replace(/''/g, '').replace(/\bSAFE\b/g, '').replace(/[+\s]/g, ''))) {
      offenders.push(m[0].slice(0, 120));
    }
  }
  assert.deepEqual(offenders, [], 'raw values concatenated into HTML sinks');
});

test('images are created via DOM (createSafeImg), never as <img> HTML strings', () => {
  const lines = source.split('\n');
  const offenders = lines
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => /<img\b/i.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(offenders, [], 'found <img in HTML strings');
  assert.match(source, /function createSafeImg\(/);
  assert.match(source, /createSafeImg\(post\.image_data/);
  assert.match(source, /createSafeImg\(p\.image_data/);
});

test('Supabase client rename is complete (no `supabase` global collision)', () => {
  assert.doesNotMatch(source, /\b(let|const|var)\s+supabase\b/, 'must not redeclare the CDN global `supabase`');
  // Every `supabase.` member access must be the CDN namespace via window.supabase.
  const bare = source.match(/(?<![\w.])supabase\s*\./g) || [];
  assert.deepEqual(bare, [], 'bare supabase.* references left over; use socialSupabase');
  assert.match(source, /let socialSupabase = null;/);
  assert.match(source, /window\.supabase\.createClient\(/);
});
