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
const { sweepStaleTimers } = await import('./firestore/time.ts');
const { purgeExpiredChallenges } = await import('./firestore/challenges.ts');
const { purgeExpiredSessions } = await import('./firestore/sessions.ts');

setInterval(() => {
  Promise.all([sweepStaleTimers(), purgeExpiredChallenges(), purgeExpiredSessions()])
    .catch((e) => console.error(`[${new Date().toISOString()}] cleanup`, e));
}, 5 * 60e3).unref();

createApp().listen(config.port, () => {
  console.log(`Infominer portal (Firestore) on http://localhost:${config.port} (${config.isProd ? 'production' : 'development'})`);
});
