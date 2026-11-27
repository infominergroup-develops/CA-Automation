import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSecretsIntoEnv } from './firestore/secrets.ts';

/**
 * Entry point for the Firestore-backed server. Loads secrets (Secret Manager in production), then the app.
 * Config is imported only after that: a static import would read MASTER_KEY before the secrets arrive.
 * Run: npm run start:fs
 */

// Hosts outside Google Cloud (e.g. DigitalOcean) pass the service-account key as base64 in an env var.
// Google's libraries read credentials from a file, so write it to a private temp file before any client starts.
const keyB64 = process.env.GOOGLE_CREDENTIALS_BASE64;
if (keyB64 && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const json = Buffer.from(keyB64, 'base64').toString('utf8');
  try { JSON.parse(json); } catch { throw new Error('GOOGLE_CREDENTIALS_BASE64 must be a base64-encoded service-account key (JSON).'); }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gcp-')), 'key.json');
  fs.writeFileSync(file, json, { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
}

await loadSecretsIntoEnv();
const { config } = await import('./config.ts');
const { createApp } = await import('./firestore/app.ts');
const { acceptStaffUploads, ensureCategories } = await import('./firestore/documents.ts');
const { audit } = await import('./firestore/audit.ts');
const { ensureWorkTypes } = await import('./routes-fs/master.ts');
const { sweepStaleTimers } = await import('./firestore/time.ts');
const { purgeExpiredChallenges } = await import('./firestore/challenges.ts');
const { purgeExpiredSessions } = await import('./firestore/sessions.ts');

await ensureCategories(); // adds any document type introduced by this version
await ensureWorkTypes();
const { ensureUsernames } = await import('./firestore/users.ts');
const named = await ensureUsernames(); // logins made before usernames get one, made from their email
if (named) console.log(`Usernames given to ${named} existing login${named > 1 ? 's' : ''}.`);
const accepted = await acceptStaffUploads(); // staff uploads need no review
if (accepted) await audit({ action: 'document.staff_uploads_accepted', objectType: 'document', details: { count: accepted } });

setInterval(() => {
  Promise.all([sweepStaleTimers(), purgeExpiredChallenges(), purgeExpiredSessions()])
    .catch((e) => console.error(`[${new Date().toISOString()}] cleanup`, e));
}, 5 * 60e3).unref();

createApp().listen(config.port, () => {
  console.log(`Infominer portal (Firestore) on http://localhost:${config.port} (${config.isProd ? 'production' : 'development'})`);
});
