'use strict';
// RNAnixAuth.authFetch: the Bearer header + 401-refresh-retry path every bridge call goes through
// (app.js apiFetch). Runs auth.js in a vm sandbox with fetch/localStorage/location stubbed, the
// same harness shape as the earlier refresh-token check -- no browser, no deps:
//
//   node --test test/
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AUTH_JS = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
const COGNITO_ENDPOINT = 'https://cognito-idp.us-east-2.amazonaws.com/';
const BRIDGE = 'https://bridge.test/status?job=x';

function response(status, json) {
  return { status: status, ok: status >= 200 && status < 300, json: async () => json || {} };
}

// fetchImpl(url, init, callIndex) -> Response-ish. Every call is recorded on sandbox.calls.
function sandbox(fetchImpl, opts) {
  opts = opts || {};
  const store = {};
  const calls = [];
  const sb = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: { cookie: '' },
    location: { href: START, protocol: 'https:', pathname: '/inference/index.html', search: '' },
    fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init, calls.length - 1); },
    console,
    Headers: class Headers {   // minimal: only what withBearer() touches
      constructor(obj) { this._m = new Map(Object.entries(obj || {})); }
      forEach(fn) { this._m.forEach((v, k) => fn(v, k)); }
    },
  };
  sb.window = sb;
  sb.calls = calls;
  if (opts.configured !== false) { sb.window.COGNITO_REGION = 'us-east-2'; sb.window.COGNITO_CLIENT_ID = 'client-id'; }
  vm.createContext(sb);
  vm.runInContext(AUTH_JS, sb);
  if (opts.session !== null) {
    sb.localStorage.setItem('rnanix_session', JSON.stringify(Object.assign({
      idToken: 'ID-OLD', accessToken: 'AT', refreshToken: 'REFRESH-OK', expiresAt: Date.now() + 3600e3, email: 'u@x',
    }, opts.session || {})));
  }
  return sb;
}

const bridgeCalls = (sb) => sb.calls.filter((c) => c.url !== COGNITO_ENDPOINT);
const cognitoCalls = (sb) => sb.calls.filter((c) => c.url === COGNITO_ENDPOINT);
const bearer = (call) => call.init && call.init.headers && call.init.headers.Authorization;
// authFetch delegates the bounce to logout(), so wherever this build puts the login page
// (site-root /login?next=... today) is what we land on; only "we left the app" is asserted.
const START = 'https://site.test/inference/index.html';
const atLogin = (sb) => sb.location.href !== START && /(^|\/)login(\.html)?(\?|$)/.test(sb.location.href);

test('attaches the session ID token as Authorization: Bearer', async () => {
  const sb = sandbox(async () => response(200, { state: 'running' }));
  const r = await sb.window.RNAnixAuth.authFetch(BRIDGE);
  assert.equal(r.status, 200);
  assert.equal(sb.calls.length, 1);
  assert.equal(bearer(sb.calls[0]), 'Bearer ID-OLD');
});

test('keeps the caller\'s method, body and other headers', async () => {
  const sb = sandbox(async () => response(200));
  await sb.window.RNAnixAuth.authFetch(BRIDGE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  const c = sb.calls[0];
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.body, '{"a":1}');
  assert.equal(c.init.headers['content-type'], 'application/json');
  assert.equal(bearer(c), 'Bearer ID-OLD');
});

test('accepts a Headers instance without dropping its entries', async () => {
  const sb = sandbox(async () => response(200));
  await sb.window.RNAnixAuth.authFetch(BRIDGE, { headers: new sb.Headers({ 'x-custom': '1' }) });
  assert.equal(sb.calls[0].init.headers['x-custom'], '1');
  assert.equal(bearer(sb.calls[0]), 'Bearer ID-OLD');
});

test('does not mutate the init object it was handed', async () => {
  const sb = sandbox(async () => response(200));
  const init = { headers: { 'content-type': 'application/json' } };
  await sb.window.RNAnixAuth.authFetch(BRIDGE, init);
  assert.deepEqual(init, { headers: { 'content-type': 'application/json' } });
});

test('401 -> silent refresh -> ONE retry carrying the NEW token; the retry\'s response is returned', async () => {
  const sb = sandbox(async (url, init, i) => {
    if (url === COGNITO_ENDPOINT) {
      const body = JSON.parse(init.body);
      assert.equal(body.AuthFlow, 'REFRESH_TOKEN_AUTH');
      assert.equal(body.AuthParameters.REFRESH_TOKEN, 'REFRESH-OK');
      return response(200, { AuthenticationResult: { IdToken: 'ID-NEW', AccessToken: 'AT2', ExpiresIn: 3600 } });
    }
    return bearer({ init }) === 'Bearer ID-NEW' ? response(200, { state: 'done' }) : response(401, { message: 'Unauthorized' });
  });
  const r = await sb.window.RNAnixAuth.authFetch(BRIDGE);
  assert.equal(r.status, 200);
  const b = bridgeCalls(sb);
  assert.equal(b.length, 2, 'original + exactly one retry');
  assert.equal(bearer(b[0]), 'Bearer ID-OLD');
  assert.equal(bearer(b[1]), 'Bearer ID-NEW');
  assert.equal(cognitoCalls(sb).length, 1);
  assert.equal(sb.window.RNAnixAuth.getSession().idToken, 'ID-NEW', 'session persisted the refreshed token');
  assert.equal(sb.window.RNAnixAuth.getSession().refreshToken, 'REFRESH-OK', 'refresh token preserved');
  assert.ok(!atLogin(sb));
});

test('a 401 that survives a successful refresh is returned as-is -- never loops', async () => {
  const sb = sandbox(async (url) => url === COGNITO_ENDPOINT
    ? response(200, { AuthenticationResult: { IdToken: 'ID-NEW', ExpiresIn: 3600 } })
    : response(401, { message: 'Unauthorized' }));
  const r = await sb.window.RNAnixAuth.authFetch(BRIDGE);
  assert.equal(r.status, 401);
  assert.equal(bridgeCalls(sb).length, 2);
  assert.equal(cognitoCalls(sb).length, 1);
  assert.ok(!atLogin(sb), 'token is fine, request is not: no logout');
});

test('401 + dead refresh token -> session cleared, sent to login, throws for the caller', async () => {
  const sb = sandbox(async (url) => url === COGNITO_ENDPOINT
    ? response(400, { __type: 'NotAuthorizedException', message: 'Refresh Token has expired' })
    : response(401, { message: 'Unauthorized' }));
  await assert.rejects(sb.window.RNAnixAuth.authFetch(BRIDGE), /session has expired/);
  assert.equal(bridgeCalls(sb).length, 1, 'no retry without a new token');
  assert.equal(sb.window.RNAnixAuth.getSession(), null);
  assert.ok(atLogin(sb), 'bounced to the login page, got ' + sb.location.href);
});

test('401 with no session at all -> straight to login (nothing to refresh with)', async () => {
  const sb = sandbox(async () => response(401), { session: null });
  await assert.rejects(sb.window.RNAnixAuth.authFetch(BRIDGE));
  assert.equal(cognitoCalls(sb).length, 0);
  assert.ok(atLogin(sb), 'bounced to the login page, got ' + sb.location.href);
});

test('concurrent 401s share one refresh call', async () => {
  let refreshes = 0;
  const sb = sandbox(async (url, init) => {
    if (url === COGNITO_ENDPOINT) { refreshes++; await new Promise((r) => setTimeout(r, 10)); return response(200, { AuthenticationResult: { IdToken: 'ID-NEW', ExpiresIn: 3600 } }); }
    return bearer({ init }) === 'Bearer ID-NEW' ? response(200) : response(401);
  });
  const [a, b] = await Promise.all([sb.window.RNAnixAuth.authFetch(BRIDGE), sb.window.RNAnixAuth.authFetch(BRIDGE + '2')]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(refreshes, 1);
});

test('non-401 errors are passed through untouched', async () => {
  const sb = sandbox(async () => response(502, { error: 'Claude API call failed' }));
  const r = await sb.window.RNAnixAuth.authFetch(BRIDGE);
  assert.equal(r.status, 502);
  assert.equal(sb.calls.length, 1);
});

test('unconfigured (demo mode): plain fetch, no header, no refresh, no redirect on 401', async () => {
  const sb = sandbox(async () => response(401), { configured: false });
  const r = await sb.window.RNAnixAuth.authFetch(BRIDGE);
  assert.equal(r.status, 401);
  assert.equal(sb.calls.length, 1);
  assert.equal(bearer(sb.calls[0]), undefined);
  assert.ok(!atLogin(sb));
});
