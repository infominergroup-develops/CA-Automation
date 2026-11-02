/**
 * Starts an isolated, fully populated copy of the portal for Playwright:
 * fresh database in .test-data/, demo accounts, sample tasks and documents, Tally simulator + one agent sync.
 * API :3201, web :5273, Tally simulator :9301. Never touches ./data.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, '.test-data');
const API = 'http://localhost:3201/api';
const env = { ...process.env, NODE_ENV: 'development', API_PORT: '3201', WEB_PORT: '5273', API_PROXY: 'http://localhost:3201', APP_ORIGIN: 'http://localhost:5273', DATA_DIR: DATA, OTP_PROVIDER: 'file', NODE_NO_WARNINGS: '1' };
const kids: ChildProcess[] = [];
const start = (cmd: string, args: string[], extra: Record<string, string> = {}) => {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...env, ...extra }, stdio: ['ignore', 'inherit', 'inherit'] });
  kids.push(p);
  return p;
};
const stopAll = () => kids.forEach((k) => k.kill('SIGTERM'));
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });
process.on('exit', stopAll);

const waitPort = (port: number) => new Promise<void>((resolve, reject) => {
  const t0 = Date.now();
  const tryOnce = () => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.end(); resolve(); });
    s.on('error', () => (Date.now() - t0 > 30000 ? reject(new Error(`port ${port} not up`)) : setTimeout(tryOnce, 250)));
  };
  tryOnce();
});
const tsx = path.join(ROOT, 'node_modules/.bin/tsx');

// 1. Fresh data folder, seeded accounts and a demo agent.
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
execFileSync(tsx, ['server/seed.ts', '--demo'], { cwd: ROOT, env, stdio: 'ignore' });
execFileSync(tsx, ['tools/demo-agent-setup.ts'], { cwd: ROOT, env, stdio: 'ignore' });
const agentCfg = path.join(DATA, 'demo-agent/agent.json');
fs.writeFileSync(agentCfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(agentCfg, 'utf8')), tallyUrl: 'http://localhost:9301' }));

// 2. Simulator and API.
start(tsx, ['tools/mock-tally.ts'], { MOCK_TALLY_PORT: '9301' });
start(tsx, ['server/index.ts']);
await Promise.all([waitPort(9301), waitPort(3201)]);
execFileSync('npm', ['run', 'agent:build', '--silent'], { cwd: ROOT, stdio: 'ignore' });

// 3. Sample work, created through the real API.
const creds = Object.fromEntries(fs.readFileSync(path.join(DATA, 'initial-credentials.txt'), 'utf8').split('\n').filter((l) => l.includes('password:'))
  .map((l) => { const m = l.match(/^(\w+)\s+(\S+)\s+password: (\S+)/)!; return [m[1], { email: m[2], pw: m[3] }]; }));
const mobiles: Record<string, string> = { director: '9000000001', manager: '9000000002', employee: '9000000003', client: '9000000004' };
async function session(role: string) {
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown) => {
    const isForm = body instanceof FormData;
    const r = await fetch(API + p, { method, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'fetch', origin: 'http://localhost:5273', cookie } });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(data)}`);
    return data;
  };
  const login = role === 'client' ? { mode: 'client', identifier: mobiles.client } : { mode: 'staff', identifier: creds[role].email, password: creds[role].pw };
  const { challengeId } = await call('POST', '/auth/login', login);
  const code = JSON.parse(fs.readFileSync(path.join(DATA, 'dev-otp.json'), 'utf8'))[mobiles[role]];
  await call('POST', '/auth/verify', { challengeId, code });
  return call;
}
const dir = await session('director');
const mgr = await session('manager');
const cli = await session('client');
await cli('POST', '/privacy/consent', { purposes: ['service', 'updates'], version: (await cli('GET', '/privacy/notice')).version });
const company = (await dir('GET', '/companies'))[0];
const staff = await dir('GET', '/users');
const emp = staff.find((s: { role: string }) => s.role === 'employee');
const cats = await dir('GET', '/categories');
const cat = (n: string) => cats.find((c: { name: string }) => c.name === n).id;
const day = (n: number) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

for (const [name, category, month] of [['HDFC statement Sep 2026.pdf', 'Bank statements', '9'], ['Purchase bills Sep.pdf', 'Purchase bills', '9'], ['Sales register Q2.csv', 'Sales invoices', '']] as const) {
  const fd = new FormData();
  fd.append('category_id', String(cat(category))); fd.append('fy', '2026-27'); fd.append('month', month);
  const body = name.endsWith('.csv') ? 'date,invoice,amount\n2026-09-01,INV-101,118000\n' : `%PDF-1.4\n% ${name}\n%%EOF\n`;
  fd.append('files', new Blob([body], { type: name.endsWith('.csv') ? 'text/csv' : 'application/pdf' }), name);
  await cli('POST', `/companies/${company.id}/documents`, fd);
}
const t1 = await mgr('POST', '/tasks', { company_id: company.id, type: 'GST return', title: 'GSTR-3B September 2026', period: 'Sep 2026', assignee_id: emp.id, due_date: day(4), statutory_due: day(14), priority: 'high', estimate_hours: 3, instructions: 'Reconcile ITC with GSTR-2B before filing.' });
await mgr('POST', '/tasks', { company_id: company.id, type: 'TDS return', title: 'TDS return Q2 (26Q)', period: 'Q2 FY 2026-27', assignee_id: emp.id, due_date: day(-2), priority: 'urgent', estimate_hours: 2 });
await mgr('POST', '/tasks', { company_id: company.id, type: 'Bank reconciliation', title: 'Bank reconciliation Aug 2026', period: 'Aug 2026', assignee_id: emp.id, due_date: day(9), estimate_hours: 4 });
const e = await session('employee');
await e('POST', '/me/monitoring-ack', {});
await e('POST', `/tasks/${t1.id}/start`, {});
await e('POST', `/tasks/${t1.id}/access-requests`, { category_ids: [cat('Bank statements'), cat('Purchase bills')], reason: 'Need September statements and bills to reconcile ITC.' });
await cli('POST', '/tasks/request', { company_id: company.id, title: 'CA certificate for bank loan', details: 'HDFC needs it by the 20th.' });

// 4. Tally: register the company, link it, sync.
const agent = path.join(ROOT, 'agent/dist/infominer-agent.mjs');
execFileSync('node', [agent, agentCfg, '--once'], { cwd: ROOT, stdio: 'ignore' });
const src = (await dir('GET', '/tally/sources'))[0];
await dir('POST', `/tally/sources/${src.id}/map`, { company_id: company.id });
execFileSync('node', [agent, agentCfg, '--once'], { cwd: ROOT, stdio: 'ignore' });

// 5. Web app last: Playwright waits for this port.
start(path.join(ROOT, 'node_modules/.bin/vite'), ['--strictPort']);
console.log('Test stack ready on http://localhost:5273');
await new Promise(() => {});
