// Real Cognito auth (no SDK — plain JSON API, same "raw HTTP over SDK" approach as the Claude
// wiring in rna-atlas-inference's containers/research/handler.py), or a graceful offline demo
// when unconfigured.
//
// Set before this file loads:
//   <script>window.COGNITO_REGION = "us-east-2"; window.COGNITO_CLIENT_ID = "...";</script>
// (terraform output cognito_web_client_id / var.aws_region in rna-atlas-inference)
//
// With both unset, RNAnixAuth.configured() is false and requireAuth() always passes — login.html
// keeps its current demo behavior (any input logs in) and index.html needs no session at all.
(function () {
  var REGION = window.COGNITO_REGION || '';
  var CLIENT_ID = window.COGNITO_CLIENT_ID || '';
  var ENDPOINT = REGION ? ('https://cognito-idp.' + REGION + '.amazonaws.com/') : '';
  var SESSION_KEY = 'rnanix_session';
  // The edge gate in front of the whole site (rna-atlas-inference/lambda_src/edge_auth, a
  // Lambda@Edge on CloudFront's viewer-request) cannot see localStorage -- it reads THIS cookie
  // and verifies the ID token in it before any object is served. Mirror the token into it on
  // every login / silent refresh, clear it on logout. It is not HttpOnly by construction (JS
  // sets it); the same token already lives in localStorage, so that adds no new exposure.
  // AUTH_COOKIE_DOMAIN is injected at deploy time (e.g. "rna-atlas.org") so apex and www share
  // one session; unset = host-only cookie, which is right for local dev.
  var COOKIE_NAME = 'rnanix_id';
  var COOKIE_DOMAIN = window.AUTH_COOKIE_DOMAIN || '';
  // The site-root login page. Absolute, because index.html lives under /inference/ while the
  // login page is served at /login (the edge gate rewrites that to the /login.html object). Every
  // bounce carries ?next= so the visitor comes back to the page they were on after signing in.
  var LOGIN_PATH = '/login';
  function goLogin() {
    location.href = LOGIN_PATH + '?next=' + encodeURIComponent(location.pathname + location.search);
  }
  // localStorage, not sessionStorage: sessionStorage is scoped to one browsing-context/tab, so a
  // session saved in tab A is invisible to a brand-new tab B on the same origin -- requireAuth()
  // in B sees no session at all and bounces to login.html, even seconds after logging in in A.
  // localStorage is shared across tabs of the same origin (and survives closing/reopening the
  // browser), so a session persists until the refresh token itself actually expires (~30 days).
  var storage = window.localStorage;

  function configured() { return !!(REGION && CLIENT_ID); }

  async function call(target, body) {
    var r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.' + target },
      body: JSON.stringify(body),
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.message || j.__type || ('HTTP ' + r.status)); e.type = j.__type; throw e; }
    return j;
  }

  function cookieAttrs(maxAge, withDomain) {
    var a = '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax';
    if (location.protocol === 'https:') a += '; Secure';
    if (withDomain && COOKIE_DOMAIN) a += '; Domain=' + COOKIE_DOMAIN;
    return a;
  }
  // A host-only cookie and a Domain=-scoped one with the same name are DIFFERENT cookies to the
  // browser, and both are sent. After a deploy changes AUTH_COOKIE_DOMAIN the stale variant used
  // to live on until its Max-Age (12 h): a sign-in refreshed only the new variant and sign-out
  // cleared only the current one, so a still-valid old token kept passing the edge gate for page
  // loads after logout (T-0043; the gate itself tolerates duplicates since T-0021). So: every
  // write of the Domain= cookie also expires the host-only form, and clearing expires both.
  function expireHostOnlyCookie() { document.cookie = COOKIE_NAME + '=' + cookieAttrs(0, false); }
  function setCookie(idToken, expiresAt) {
    if (COOKIE_DOMAIN) expireHostOnlyCookie();
    document.cookie = COOKIE_NAME + '=' + idToken + cookieAttrs(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)), true);
  }
  function clearCookie() {
    document.cookie = COOKIE_NAME + '=' + cookieAttrs(0, true);
    if (COOKIE_DOMAIN) expireHostOnlyCookie();
  }
  function hasCookie() {
    return document.cookie.split(';').some(function (p) { return p.trim().indexOf(COOKIE_NAME + '=') === 0; });
  }

  // refreshToken is optional: REFRESH_TOKEN_AUTH's own response never includes a new one (the
  // original stays valid, ~30 days by default), so refreshSession() must pass the existing one
  // through explicitly here or it would get silently wiped on every renewal.
  function saveSession(auth, email, refreshToken) {
    var expiresAt = Date.now() + (auth.ExpiresIn || 3600) * 1000;
    storage.setItem(SESSION_KEY, JSON.stringify({
      idToken: auth.IdToken, accessToken: auth.AccessToken,
      refreshToken: auth.RefreshToken || refreshToken,
      expiresAt: expiresAt, email: email || '',
    }));
    setCookie(auth.IdToken, expiresAt);
  }

  function getSession() {
    try { return JSON.parse(storage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }

  function clearSession() { storage.removeItem(SESSION_KEY); clearCookie(); }

  // The ID/access token dies after ~1 hour (Cognito default); the refresh token that was sitting
  // in the session unused until now is normally good for ~30 days. Silently trades the former for
  // a new one instead of forcing a full re-login just because an hour of real use went by.
  var _refreshing = null;
  function refreshSession() {
    var s = getSession();
    if (!s || !s.refreshToken) return Promise.resolve(false);
    if (_refreshing) return _refreshing;
    _refreshing = call('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: s.refreshToken },
    }).then(function (j) {
      saveSession(j.AuthenticationResult, s.email, s.refreshToken);
      return true;
    }).catch(function () {
      return false;   // refresh token itself expired/revoked -- nothing left to try
    }).finally(function () { _refreshing = null; });
    return _refreshing;
  }

  // Throws with .challenge = "NEW_PASSWORD_REQUIRED" and .session set when this is an invited
  // user's first sign-in — the caller (login.html) routes that to the "Accept invite" pane.
  async function login(email, password) {
    var j = await call('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH', ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    if (j.ChallengeName) {
      var err = new Error(j.ChallengeName);
      err.challenge = j.ChallengeName; err.session = j.Session;
      throw err;
    }
    saveSession(j.AuthenticationResult, email);
    return j.AuthenticationResult;
  }

  async function completeNewPassword(email, newPassword, session) {
    var j = await call('RespondToAuthChallenge', {
      ChallengeName: 'NEW_PASSWORD_REQUIRED', ClientId: CLIENT_ID, Session: session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    });
    saveSession(j.AuthenticationResult, email);
    return j.AuthenticationResult;
  }

  function logout() { clearSession(); goLogin(); }

  // Called at the top of index.html. No-op (returns true) when Cognito isn't configured, so the
  // mockup keeps working with no auth at all — same "unconfigured = demo mode" convention as
  // window.INFER_API.
  function requireAuth() {
    if (!configured()) return true;
    var s = getSession();
    if (!s) { goLogin(); return false; }
    if (Date.now() > s.expiresAt) {
      if (!s.refreshToken) { goLogin(); return false; }
      // Stays synchronous (no flash-of-unauthenticated-content regression, no blocking network
      // call in <head>): render optimistically, renew in the background, and only bounce to
      // login from here if the refresh token itself turns out to be dead too.
      refreshSession().then(function (ok) { if (!ok) goLogin(); });
    } else if (!hasCookie()) {
      setCookie(s.idToken, s.expiresAt);   // session predates the cookie mirror -- backfill it
    }
    return true;
  }

  // For login.html: if this browser already holds a usable session (e.g. the edge gate bounced
  // someone who logged in before the cookie existed, or whose cookie expired while the refresh
  // token is still good), make the cookie current and report true so the page can skip the form
  // and send them straight back to where they were going. Never prompts, never throws.
  function resume() {
    if (!configured()) return Promise.resolve(false);
    var s = getSession();
    if (!s || !s.idToken) return Promise.resolve(false);
    if (Date.now() < s.expiresAt) { setCookie(s.idToken, s.expiresAt); return Promise.resolve(true); }
    return refreshSession();   // saveSession() inside it re-sets the cookie
  }

  // fetch() for the inference API. Attaches the session's Cognito ID token as
  // `Authorization: Bearer ...` and, on a 401, silently refreshes the session ONCE and retries.
  //
  // Every bridge route sits behind API Gateway's JWT authorizer (rna-atlas-inference
  // terraform/api_gateway.tf), which answers 401 {"message":"Unauthorized"} -- before the Lambda
  // ever runs -- for a missing, expired or foreign token. Without the retry, an ID token that
  // expires mid-session (12 h validity; a tab left open overnight) turns every status poll and
  // chat turn into a dead request until the user happens to reload. Outcomes:
  //   * 200/4xx/5xx other than 401     -> returned as-is
  //   * 401, refresh succeeds          -> ONE retry with the new token; its response is returned
  //                                       as-is, even if that is a 401 again (no loop)
  //   * 401, refresh fails             -> the refresh token is dead too and nothing here can
  //                                       recover: logout() (clears the session, bounces to the
  //                                       login page with ?next=), the same terminal outcome
  //                                       requireAuth() has, then throw so the caller's own error
  //                                       path runs
  // Unconfigured (demo mode): no session, no header, no retry -- behaves exactly like fetch().
  //
  // Only ever use this for the bridge API, never for a presigned S3 URL: S3 rejects a request
  // carrying BOTH a query-string signature and an Authorization header.
  function withBearer(init, idToken) {
    var headers = {};
    var given = (init && init.headers) || {};
    if (typeof Headers !== 'undefined' && given instanceof Headers) given.forEach(function (v, k) { headers[k] = v; });
    else Object.keys(given).forEach(function (k) { headers[k] = given[k]; });
    if (idToken) headers['Authorization'] = 'Bearer ' + idToken;
    var out = {};
    Object.keys(init || {}).forEach(function (k) { out[k] = init[k]; });
    out.headers = headers;
    return out;
  }
  async function authFetch(url, init) {
    var s = configured() ? getSession() : null;
    var r = await fetch(url, withBearer(init, s && s.idToken));
    if (r.status !== 401 || !configured()) return r;
    var renewed = await refreshSession();
    if (!renewed) {
      logout();
      throw new Error('Your session has expired -- please sign in again.');
    }
    s = getSession();
    return fetch(url, withBearer(init, s && s.idToken));
  }

  window.RNAnixAuth = {
    configured: configured, login: login, completeNewPassword: completeNewPassword,
    logout: logout, getSession: getSession, requireAuth: requireAuth, refreshSession: refreshSession,
    resume: resume, authFetch: authFetch,
  };
})();
