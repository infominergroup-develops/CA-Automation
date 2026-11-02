import { Firestore } from '@google-cloud/firestore';

/**
 * Firestore client. In production (Cloud Run) it uses the service's own credentials and the project from
 * the environment. For local development and tests, set FIRESTORE_EMULATOR_HOST (the emulator needs no
 * credentials) — see `npm run emulator`.
 */
const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? 'demo-infominer';
export const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

export const db = new Firestore({
  projectId,
  // ignoreUndefinedProperties keeps the data layer close to SQLite's NULL handling: a field left undefined
  // is simply absent, rather than throwing.
  ignoreUndefinedProperties: true,
});

if (!onEmulator && projectId === 'demo-infominer') {
  // Guard against accidentally pointing at a real project with the demo id, or forgetting the emulator in dev.
  console.warn('Firestore: using project "demo-infominer" without an emulator host. Set GOOGLE_CLOUD_PROJECT (prod) or FIRESTORE_EMULATOR_HOST (dev).');
}
