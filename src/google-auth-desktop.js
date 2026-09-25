// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Google sign-in for the desktop app, for Google Drive sync. This is
// Google's flow for installed apps: open the sign-in page in the user's
// browser, receive the answer on a one-time local address
// (http://127.0.0.1:<port>), and protect the exchange with PKCE. Balimda
// only asks for its own hidden app folder in Drive (drive.appdata).

'use strict';

const http = require('http');
const crypto = require('crypto');
const { SyncError } = require('./sync');

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function page(message) {
  return `<!doctype html><meta charset="utf-8"><title>Balimda</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#222">
<div style="text-align:center"><h2 style="color:#5b5bd6">Balimda</h2><p>${message}</p></div></body>`;
}

/**
 * @param clientId, clientSecret  the "Desktop app" OAuth client from Google Cloud
 * @param openUrl                 opens a URL in the user's browser
 * @param fetch                   fetch implementation
 */
function desktopGoogleAuth({ clientId, clientSecret, openUrl, fetch, timeoutMs = 5 * 60 * 1000 }) {
  let cached = null;  // { secret, token, expires }

  async function tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }).toString()
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // not JSON
    }
    if (!res.ok) {
      if (data.error === 'invalid_grant') throw new SyncError('Google sign-in has expired or was removed. Open Settings → Sync and sign in again.');
      throw new SyncError(`Google sign-in failed: ${data.error_description || data.error || `error ${res.status}`}`);
    }
    return data;
  }

  const remember = (secret, t) => {
    cached = { secret, token: t.access_token, expires: Date.now() + Math.max(60, (t.expires_in || 3600) - 120) * 1000 };
    return t.access_token;
  };

  return {
    async signIn() {
      const verifier = base64url(crypto.randomBytes(32));
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
      const state = base64url(crypto.randomBytes(16));
      const server = http.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const redirectUri = `http://127.0.0.1:${server.address().port}`;
      const code = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new SyncError('Google sign-in timed out. Try again.')), timeoutMs);
        server.on('request', (req, res) => {
          const u = new URL(req.url, redirectUri);
          if (u.pathname !== '/') {
            res.statusCode = 404;
            res.end();
            return;
          }
          const got = u.searchParams.get('state') === state ? u.searchParams.get('code') : null;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page(got ? 'You are signed in. You can close this tab and go back to Balimda.' : 'Sign-in did not finish. You can close this tab and try again in Balimda.'));
          clearTimeout(timer);
          if (got) resolve(got);
          else reject(new SyncError(u.searchParams.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in did not finish. Try again.'));
        });
      });
      try {
        await openUrl(`${AUTH_URL}?${new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent'
        })}`);
        const t = await tokenRequest({ grant_type: 'authorization_code', code: await code, code_verifier: verifier, redirect_uri: redirectUri });
        if (!t.refresh_token) throw new SyncError('Google did not allow offline access. Try signing in again.');
        remember(t.refresh_token, t);
        return { account: null, secret: t.refresh_token };
      } finally {
        server.close();
      }
    },

    async accessToken(secret, { force = false } = {}) {
      if (!secret) throw new SyncError('Sign in to Google again in Settings → Sync.');
      if (!force && cached && cached.secret === secret && Date.now() < cached.expires) return cached.token;
      return remember(secret, await tokenRequest({ grant_type: 'refresh_token', refresh_token: secret }));
    },

    // Removes Balimda's access from the Google account.
    async signOut(secret) {
      cached = null;
      if (!secret) return;
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: secret }).toString()
      }).catch(() => {});
    }
  };
}

module.exports = { desktopGoogleAuth, SCOPE };
