/**
 * Creates the first accounts in Firestore.
 *   npm run seed:fs            → the first Director, from SEED_DIRECTOR_* in the environment
 *   npm run seed:fs -- --demo  → also a demo manager, employee and client (local/dev only)
 *
 * Generated passwords are written to data/initial-credentials.txt (mode 600), never printed.
 * Run against real Firestore (GOOGLE_CLOUD_PROJECT + ADC) or the emulator (FIRESTORE_EMULATOR_HOST).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSecretsIntoEnv } from './firestore/secrets.ts';

await loadSecretsIntoEnv();
const { config } = await import('./config.ts');
const { randomToken } = await import('./security/crypto.ts');
const { createStaffUser, createClientUser } = await import('./firestore/users.ts');
const { ensureSettingDefaults } = await import('./firestore/settings.ts');
const { ensureCategories } = await import('./firestore/documents.ts');
const { db } = await import('./firestore/client.ts');
const { newId, now } = await import('./firestore/store.ts');
const { C } = await import('./firestore/types.ts');

const demo = process.argv.includes('--demo');
if (demo && config.isProd) throw new Error('--demo is not allowed in production.');

const lines: string[] = [];
const genPassword = () => `${randomToken(9)}9a`; // ~72 bits, meets the 12-char letters+digits policy

await ensureSettingDefaults();
await ensureCategories();

async function staff(role: 'director' | 'manager' | 'employee', name: string, email: string, mobile: string) {
  const pw = genPassword();
  await createStaffUser({ role, name, email, mobile, password: pw });
  lines.push(`${role.padEnd(9)} ${email}  password: ${pw}`);
}

const name = process.env.SEED_DIRECTOR_NAME, email = process.env.SEED_DIRECTOR_EMAIL, mobile = process.env.SEED_DIRECTOR_MOBILE;
if (!name || !email || !mobile) throw new Error('Set SEED_DIRECTOR_NAME, SEED_DIRECTOR_EMAIL and SEED_DIRECTOR_MOBILE.');
await staff('director', name, email, mobile);

if (demo) {
  await staff('manager', 'Demo Manager', 'manager@demo.test', '9000000002');
  await staff('employee', 'Demo Employee', 'employee@demo.test', '9000000003');
  const groupId = newId();
  await db.collection(C.clientGroups).doc(groupId).set({ name: 'Demo Traders Group', created_at: now() });
  await createClientUser({ name: 'Demo Client', mobile: '9000000004', clientGroupId: groupId });
  lines.push('client    mobile 9000000004  (one-time code is delivered by the configured provider)');
}

const file = path.join(config.dataDir, 'initial-credentials.txt');
fs.appendFileSync(file, `# Created ${now()}. Change these passwords after first sign-in, then delete this file.\n${lines.join('\n')}\n\n`, { mode: 0o600 });
console.log(`Created ${lines.length} account(s) in Firestore. Credentials written to ${file}`);
await db.terminate();
