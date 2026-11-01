// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// scripts/play-upload.mjs against a pretend Google: the service account signs
// in, and one release goes up as an edit (bundle, track, commit).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = { client_email: 'play@najwa.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };
const PKG = 'com.bandaraltariqi.najwa';

function fakeGoogle({ failCommit = false } = {}) {
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body, auth: opts.headers && opts.headers.Authorization });
    if (url === account.token_uri) {
      const form = new URLSearchParams(opts.body);
      assert.strictEqual(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [head, claims, sig] = form.get('assertion').split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      assert.ok(ok, 'signed with the service account key');
      const c = JSON.parse(Buffer.from(claims.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
      assert.strictEqual(c.iss, account.client_email);
      assert.strictEqual(c.scope, 'https://www.googleapis.com/auth/androidpublisher');
      return json(200, { access_token: 'tok', expires_in: 3600 });
    }
    assert.strictEqual(opts.headers.Authorization, 'Bearer tok');
    const app = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;
    if (url === `${app}/edits` && opts.method === 'POST') return json(200, { id: 'e1' });
    if (url === `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PKG}/edits/e1/bundles?uploadType=media`) {
      assert.strictEqual(opts.headers['Content-Type'], 'application/octet-stream');
      return json(200, { versionCode: 7, sha256: 'x' });
    }
    if (url === `${app}/edits/e1/tracks/internal` && opts.method === 'PUT') return json(200, JSON.parse(opts.body));
    if (url === `${app}/edits/e1:commit`) return failCommit ? json(403, { error: { message: 'The caller does not have permission' } }) : json(200, { id: 'e1' });
    return json(404, { error: { message: `no route ${opts.method} ${url}` } });
  };
  return { calls, fetch };
}

test('uploads the bundle to the internal track with release notes, then commits', async () => {
  const { uploadBundle } = await import('../scripts/play-upload.mjs');
  const g = fakeGoogle();
  const r = await uploadBundle({ account, packageName: PKG, aab: Buffer.from('bundle'), track: 'internal', notes: 'Replies keep going in the background.', fetch: g.fetch });
  assert.deepStrictEqual(r, { versionCode: '7', track: 'internal' });
  assert.deepStrictEqual(g.calls.map((c) => c.method + ' ' + c.url.split('/').slice(-2).join('/')), [
    'POST oauth2.googleapis.com/token', 'POST com.bandaraltariqi.najwa/edits', 'POST e1/bundles?uploadType=media', 'PUT tracks/internal', 'POST edits/e1:commit'
  ]);
  const track = JSON.parse(g.calls[3].body);
  assert.deepStrictEqual(track, { track: 'internal', releases: [{ versionCodes: ['7'], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'Replies keep going in the background.' }] }] });
});

test('no access to the app: the error names the account and the app', async () => {
  const { uploadBundle } = await import('../scripts/play-upload.mjs');
  const fetch = async (url, opts) => (url === account.token_uri
    ? new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
    : new Response(JSON.stringify({ error: { message: 'The caller does not have permission' } }), { status: 403 }));
  await assert.rejects(uploadBundle({ account, packageName: PKG, aab: Buffer.from('b'), fetch }),
    /The caller does not have permission \(signed in as play@najwa\.iam\.gserviceaccount\.com, app com\.bandaraltariqi\.najwa\)\. In the Play Console, Users and permissions must list exactly this email/);
});

test('no release notes: none are sent; a refusal from Google is reported clearly', async () => {
  const { uploadBundle, args } = await import('../scripts/play-upload.mjs');
  // The workflow passes an empty --notes when none are given.
  assert.strictEqual(args(['--aab', 'a.aab', '--notes', '', '--track', 'internal']).notes, '');
  const g = fakeGoogle({ failCommit: true });
  await assert.rejects(uploadBundle({ account, packageName: PKG, aab: Buffer.from('b'), fetch: g.fetch }), /Google Play: The caller does not have permission/);
  assert.ok(!('releaseNotes' in JSON.parse(g.calls[3].body).releases[0]));
});
