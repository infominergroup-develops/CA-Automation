/**
 * Development only: registers a "Demo PC (simulator)" agent and writes data/demo-agent/agent.json,
 * so `npm run demo:tally` can feed the Tally simulator's books into the local portal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.ts';
import { one, run, now, id } from '../server/db.ts';
import { randomToken, sha256 } from '../server/security/crypto.ts';

if (config.isProd) throw new Error('Development only.');
const dir = path.join(config.dataDir, 'demo-agent');
const file = path.join(dir, 'agent.json');
if (fs.existsSync(file)) { console.log(`Already set up: ${file}`); process.exit(0); }

const director = one<{ id: string }>(`SELECT id FROM users WHERE role = 'director' ORDER BY created_at LIMIT 1`);
if (!director) throw new Error('Run `npm run seed` first.');
const agentId = id();
const secret = randomToken(32);
run('INSERT INTO tally_agents (id, name, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [agentId, 'Demo PC (simulator)', sha256(secret), director.id, now()]);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify({ serverUrl: `http://localhost:${config.port}`, agentKey: `${agentId}.${secret}`, tallyUrl: 'http://localhost:9000', logFile: path.join(dir, 'agent.log') }, null, 2), { mode: 0o600 });
console.log(`Demo agent registered. Config: ${file}`);
