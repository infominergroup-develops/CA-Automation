/**
 * npm run seed            → creates the first Director from SEED_DIRECTOR_* in .env
 * npm run seed -- --demo  → also creates demo manager, employee and client accounts (development only)
 *
 * Generated passwords are written to data/initial-credentials.txt (mode 600), never printed.
 * Read it once, sign in, change the password, then delete the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { one, run, tx, now, id } from './db.ts';
import { audit } from './audit.ts';
import { hashPassword, randomToken } from './security/crypto.ts';

const demo = process.argv.includes('--demo');
if (demo && config.isProd) throw new Error('--demo is not allowed in production.');

const lines: string[] = [];
const genPassword = () => `${randomToken(9)}9a`; // ~72 bits, meets the 12-char letters+digits policy

async function staff(role: 'director' | 'manager' | 'employee', name: string, email: string, mobile: string | null) {
  const existing = one<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return existing.id;
  const pw = genPassword();
  const userId = id();
  run(`INSERT INTO users (id, role, name, email, mobile, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, role, name, email.toLowerCase(), mobile, await hashPassword(pw), now(), now()]);
  audit({ action: 'user.created', objectType: 'user', objectId: userId, details: { role, via: 'seed' } });
  lines.push(`${role.padEnd(9)} ${email}  password: ${pw}`);
  return userId;
}

const name = process.env.SEED_DIRECTOR_NAME;
const email = process.env.SEED_DIRECTOR_EMAIL;
const mobile = process.env.SEED_DIRECTOR_MOBILE;
if (!name || !email) throw new Error('Set SEED_DIRECTOR_NAME and SEED_DIRECTOR_EMAIL (SEED_DIRECTOR_MOBILE optional) in .env');
await staff('director', name, email, mobile || null);

if (demo) {
  const managerId = await staff('manager', 'Demo Manager', 'manager@demo.test', '9000000002');
  await staff('employee', 'Demo Employee', 'employee@demo.test', '9000000003');
  if (!one('SELECT 1 FROM users WHERE mobile = ?', ['9000000004'])) {
    const groupId = id(), companyId = id(), clientId = id();
    tx(() => {
      run('INSERT INTO client_groups (id, name, created_at) VALUES (?, ?, ?)', [groupId, 'Demo Traders Group', now()]);
      run(`INSERT INTO companies (id, group_id, legal_name, pan, gstin, tally_name, manager_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, groupId, 'Demo Traders Pvt Ltd', 'AAACD1234E', '09AAACD1234E1Z5', 'Demo Traders', managerId, now()]);
      run(`INSERT INTO users (id, role, name, mobile, client_group_id, created_at, updated_at) VALUES (?, 'client', ?, ?, ?, ?, ?)`,
        [clientId, 'Demo Client', '9000000004', groupId, now(), now()]);
    });
    lines.push('client    mobile 9000000004  (one-time code is printed in the API console in development)');
  }
}

if (lines.length) {
  const file = path.join(config.dataDir, 'initial-credentials.txt');
  fs.appendFileSync(file, `# Created ${now()}. Change these passwords after first sign-in, then delete this file.\n${lines.join('\n')}\n\n`, { mode: 0o600 });
  console.log(`Created ${lines.length} account(s). Credentials written to ${file}`);
} else {
  console.log('Nothing to create; accounts already exist.');
}
