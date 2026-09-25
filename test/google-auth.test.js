// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { desktopGoogleAuth, SCOPE } = require('../src/google-auth-desktop');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Plays Google: the "browser" follows the sign-in URL straight back to the
// app's local address, and the token endpoint checks PKCE.
function fakeGoogle({ deny = false } = {}) {
  const g = { tokenCalls: [], revoked: [] };
  let challenge = null;
  g.openUrl = async (url) => {
    const u = new URL(url);
    assert.strictEqual(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.strictEqual(u.searchParams.get('scope'), SCOPE);
    assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(u.searchParams.get('access_type'), 'offline');
    challenge = u.searchParams.get('code_challenge');
    const back = new URL(u.searchParams.get('redirect_uri'));
    assert.strictEqual(back.hostname, '127.0.0.1');
    back.search = deny ? 'error=access_denied' : `code=the-code&state=${u.searchParams.get('state')}`;
    // Like a browser, don't wait for the app before returning.
    setImmediate(() => fetch(back).then((r) => r.text()));
  };
  g.fetch = async (url, opts) => {
    const body = new URLSearchParams(opts.body);
    if (url === 'https://oauth2.googleapis.com/revoke') {
      g.revoked.push(body.get('token'));
      return new Response('', { status: 200 });
    }
    assert.strictEqual(url, 'https://oauth2.googleapis.com/token');
    assert.strictEqual(body.get('client_id'), 'cid');
    assert.strictEqual(body.get('client_secret'), 'csecret');
    g.tokenCalls.push(Object.fromEntries(body));
    if (body.get('grant_type') === 'authorization_code') {
      assert.strictEqual(body.get('code'), 'the-code');
      assert.strictEqual(b64url(crypto.createHash('sha256').update(body.get('code_verifier')).digest()), challenge);
      return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
    }
    if (body.get('refresh_token') === 'revoked') return Response.json({ error: 'invalid_grant' }, { status: 400 });
    return Response.json({ access_token: `access-${g.tokenCalls.length}`, expires_in: 3600 });
  };
  return g;
}

test('signs in through the browser with PKCE and keeps a refresh token', async () => {
  const g = fakeGoogle();
  const auth = desktopGoogleAuth({ clientId: 'cid', clientSecret: 'csecret', openUrl: g.openUrl, fetch: g.fetch });
  const signed = await auth.signIn();
  assert.deepStrictEqual(signed, { account: null, secret: 'refresh-1' });

  // Cached until it expires or Drive rejects it.
  assert.strictEqual(await auth.accessToken('refresh-1'), 'access-1');
  assert.strictEqual(g.tokenCalls.length, 1);
  assert.strictEqual(await auth.accessToken('refresh-1', { force: true }), 'access-2');
  assert.strictEqual(g.tokenCalls[1].grant_type, 'refresh_token');

  await auth.signOut('refresh-1');
  assert.deepStrictEqual(g.revoked, ['refresh-1']);
});

test('reports a cancelled sign-in and a removed grant clearly', async () => {
  const g = fakeGoogle({ deny: true });
  const auth = desktopGoogleAuth({ clientId: 'cid', clientSecret: 'csecret', openUrl: g.openUrl, fetch: g.fetch });
  await assert.rejects(auth.signIn(), /cancelled/);
  await assert.rejects(auth.accessToken('revoked'), /sign in again/);
});
