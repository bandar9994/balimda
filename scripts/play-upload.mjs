// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

// Uploads an app bundle to Google Play with Google's own publishing API
// (no third-party action sees the key). Used by the "Android app bundle
// (Google Play)" workflow:
//
//   PLAY_SERVICE_ACCOUNT_JSON='{…}' node scripts/play-upload.mjs \
//     --aab Najwa-AI-android.aab --package com.bandaraltariqi.najwa \
//     --track internal [--notes "What's new"] [--status completed]
//
// The service account needs access to the app in the Play Console (Users and
// permissions), with permission to release to that track.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const b64url = (data) => Buffer.from(data).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// An access token for the service account (OAuth 2.0 JWT bearer flow).
export async function accessToken(account, { fetch = globalThis.fetch, now = Date.now() } = {}) {
  const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 }));
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), account.private_key));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Google didn't accept the service account (${data.error_description || data.error || res.status}).`);
  return data.access_token;
}

/**
 * One release: a new edit, the bundle, the track, then commit.
 * @returns { versionCode, track }
 */
export async function uploadBundle({ account, packageName, aab, track = 'internal', notes = '', status = 'completed', language = 'en-US', fetch = globalThis.fetch }) {
  const token = await accessToken(account, { fetch });
  const auth = { Authorization: `Bearer ${token}` };
  const call = async (method, url, { body, type = 'application/json' } = {}) => {
    const res = await fetch(url, { method, headers: { ...auth, ...(body ? { 'Content-Type': type } : {}) }, body });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const msg = (data.error && data.error.message) || text || `error ${res.status}`;
      throw new Error(`Google Play: ${msg}`);
    }
    return data;
  };
  const app = `${API}/${encodeURIComponent(packageName)}`;
  let edit;
  try {
    edit = await call('POST', `${app}/edits`, { body: '{}' });
  } catch (err) {
    // The first call that needs access to the app: say which account and app,
    // since a mismatch is the usual cause.
    if (/permission|not found|403|404/i.test(err.message)) {
      throw new Error(`${err.message} (signed in as ${account.client_email}, app ${packageName}). In the Play Console, Users and permissions must list exactly this email, with permission to release, and the app's package name must be ${packageName}.`);
    }
    throw err;
  }
  const e = encodeURIComponent(edit.id);
  const bundle = await call('POST', `${UPLOAD}/${encodeURIComponent(packageName)}/edits/${e}/bundles?uploadType=media`, { body: aab, type: 'application/octet-stream' });
  const versionCode = String(bundle.versionCode);
  const release = { versionCodes: [versionCode], status };
  if (notes.trim()) release.releaseNotes = [{ language, text: notes.trim().slice(0, 500) }];
  await call('PUT', `${app}/edits/${e}/tracks/${encodeURIComponent(track)}`, { body: JSON.stringify({ track, releases: [release] }) });
  await call('POST', `${app}/edits/${e}:commit`);
  return { versionCode, track };
}

export function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not set.');
  let account;
  try {
    account = JSON.parse(raw);
  } catch {
    throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not valid JSON: paste the whole key file into the secret.');
  }
  if (!account.client_email || !account.private_key) throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not a service account key (no client_email or private_key).');
  console.log(`Signing in to Google Play as ${account.client_email}`);
  const { versionCode, track } = await uploadBundle({
    account,
    packageName: a.package,
    aab: await fs.readFile(a.aab),
    track: a.track || 'internal',
    notes: a.notes || '',
    status: a.status || 'completed'
  });
  console.log(`Uploaded version ${versionCode} to the ${track} track on Google Play.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`::error title=Google Play upload::${err.message}`);
    process.exit(1);
  });
}
