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

  function saveSession(auth, email) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      idToken: auth.IdToken, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken,
      expiresAt: Date.now() + (auth.ExpiresIn || 3600) * 1000, email: email || '',
    }));
  }

  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }

  function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

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

  function logout() { clearSession(); location.href = 'login.html'; }

  // Called at the top of index.html. No-op (returns true) when Cognito isn't configured, so the
  // mockup keeps working with no auth at all — same "unconfigured = demo mode" convention as
  // window.INFER_API.
  function requireAuth() {
    if (!configured()) return true;
    var s = getSession();
    if (!s || Date.now() > s.expiresAt) { location.href = 'login.html'; return false; }
    return true;
  }

  window.RNAnixAuth = {
    configured: configured, login: login, completeNewPassword: completeNewPassword,
    logout: logout, getSession: getSession, requireAuth: requireAuth,
  };
})();
