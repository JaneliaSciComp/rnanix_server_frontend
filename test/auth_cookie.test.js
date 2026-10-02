'use strict';
// T-0043: the edge-gate cookie (rnanix_id) must never be left alive in two variants. Runs auth.js in
// a vm sandbox whose document.cookie records every write (the browser applies each write as its own
// cookie; a Domain= cookie and a host-only one are distinct cookies to it).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AUTH_JS = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');

// A minimal cookie jar: identity = name + (Domain= value or HOST-ONLY) + Path, exactly what the
// browser keys on; Max-Age=0 deletes. `document.cookie` reads back the live names, like a browser.
function jarOf(writes) {
  const jar = new Map();
  for (const w of writes) {
    const parts = w.split(';').map((p) => p.trim());
    const [name, value] = parts[0].split('=');
    const attr = (k) => { const p = parts.find((x) => x.toLowerCase().startsWith(k.toLowerCase() + '=')); return p ? p.split('=')[1] : ''; };
    const key = name + '|' + (attr('Domain') || 'HOST-ONLY') + '|' + (attr('Path') || '/inference');
    if (attr('Max-Age') === '0') jar.delete(key); else jar.set(key, value);
  }
  return jar;
}
function sandbox(domain, seedWrites) {
  const store = {};
  const writes = (seedWrites || []).slice();
  const doc = {};
  Object.defineProperty(doc, 'cookie', {
    get: () => [...jarOf(writes).entries()].map(([k, v]) => k.split('|')[0] + '=' + v).join('; '),
    set: (v) => { writes.push(v); },
  });
  const sb = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: doc,
    location: { href: 'https://rna-atlas.org/inference/index.html', protocol: 'https:', pathname: '/inference/index.html', search: '' },
    fetch: async () => ({ status: 500, ok: false, json: async () => ({}) }),
    console,
    Headers: class { constructor(o) { this._m = new Map(Object.entries(o || {})); } forEach(fn) { this._m.forEach((v, k) => fn(v, k)); } },
  };
  sb.window = sb; sb.writes = writes; sb.jar = () => jarOf(writes);
  sb.window.COGNITO_REGION = 'us-east-2'; sb.window.COGNITO_CLIENT_ID = 'client-id';
  if (domain) sb.window.AUTH_COOKIE_DOMAIN = domain;
  vm.createContext(sb);
  vm.runInContext(AUTH_JS, sb);
  sb.localStorage.setItem('rnanix_session', JSON.stringify({ idToken: 'ID', accessToken: 'AT', refreshToken: 'R', expiresAt: Date.now() + 3600e3, email: 'u@x' }));
  return sb;
}
const hostOnly = (w) => /^rnanix_id=/.test(w) && !/Domain=/.test(w);
const domainScoped = (w) => /^rnanix_id=/.test(w) && /Domain=rna-atlas\.org/.test(w);
const expired = (w) => /Max-Age=0/.test(w);

test('with a cookie domain, setting the cookie also expires the host-only variant', () => {
  const sb = sandbox('rna-atlas.org');
  sb.window.RNAnixAuth.resume();          // backfills the cookie mirror from the stored session
  const set = sb.writes.filter((w) => /^rnanix_id=ID/.test(w));
  assert.equal(set.length, 1, sb.writes.join('\n'));
  assert.ok(domainScoped(set[0]) && !expired(set[0]), set[0]);
  const expiries = sb.writes.filter((w) => expired(w) && hostOnly(w));
  assert.equal(expiries.length, 1, sb.writes.join('\n'));
  assert.ok(sb.writes.indexOf(expiries[0]) < sb.writes.indexOf(set[0]), 'host-only expiry comes first');
  assert.match(expiries[0], /; Path=\/;/);          // load-bearing: without Path=/ the expiry targets /inference and removes nothing
});

test('with a cookie domain, clearing expires BOTH variants', () => {
  const sb = sandbox('rna-atlas.org');
  sb.window.RNAnixAuth.resume();
  const before = sb.writes.length;
  sb.window.RNAnixAuth.logout();
  const clears = sb.writes.slice(before).filter(expired);
  assert.equal(clears.length, 2, sb.writes.slice(before).join('\n'));
  assert.ok(clears.some(domainScoped) && clears.some(hostOnly));
  assert.ok(clears.every((w) => /; Path=\/;/.test(w)));
});

test('end state: a stale host-only cookie from before the domain change is gone after sign-in, and nothing survives sign-out', () => {
  // The ticket's invariant stated directly, through the jar: seed the pre-deploy host-only cookie
  // (still valid for 12 h), then the page resumes and the user signs out.
  const sb = sandbox('rna-atlas.org', ['rnanix_id=STALE; Path=/; Max-Age=43200; SameSite=Lax; Secure']);
  sb.window.RNAnixAuth.resume();
  assert.deepEqual([...sb.jar().entries()], [['rnanix_id|rna-atlas.org|/', 'ID']]);   // one variant, the new one
  sb.window.RNAnixAuth.logout();
  assert.equal(sb.jar().size, 0);
});

test('without a cookie domain (local dev) there is exactly one host-only write each way', () => {
  const sb = sandbox('');
  sb.window.RNAnixAuth.resume();
  assert.deepEqual(sb.writes.filter(expired), []);
  assert.equal(sb.writes.filter((w) => /^rnanix_id=ID/.test(w) && hostOnly(w)).length, 1);
  const before = sb.writes.length;
  sb.window.RNAnixAuth.logout();
  const clears = sb.writes.slice(before).filter(expired);
  assert.equal(clears.length, 1);
  assert.ok(hostOnly(clears[0]));
});
