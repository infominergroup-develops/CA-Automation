/**
 * Infominer Tally sync agent.
 * Runs on each PC with Tally. Every minute it tells the portal which companies Tally has open, and the portal
 * answers with what to sync (scheduled refresh, or a client's "Request fresh data"). It only reads from Tally.
 *
 *   node infominer-agent.mjs [path/to/agent.json]       run continuously
 *   node infominer-agent.mjs --once                      one cycle, then exit (for testing)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { TallyClient } from './tally.ts';
import { buildSnapshot } from './sync.ts';

const VERSION = '1.0.0';

interface Config { serverUrl: string; agentKey: string; tallyUrl?: string; logFile?: string }

const args = process.argv.slice(2);
const once = args.includes('--once');
const configPath = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(path.dirname(process.argv[1] ?? '.'), 'agent.json'));

function loadConfig(): Config {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Config;
  if (!c.serverUrl || !c.agentKey) throw new Error(`${configPath} needs serverUrl and agentKey`);
  const u = new URL(c.serverUrl);
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('serverUrl must use https:// (the agent key and your books travel over it).');
  return c;
}

const config = loadConfig();
const logFile = config.logFile ?? path.join(path.dirname(configPath), 'agent.log');
function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5e6) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, line + '\n');
  } catch { /* logging must never stop the agent */ }
}

const tally = new TallyClient(config.tallyUrl ?? 'http://localhost:9000');
const base = config.serverUrl.replace(/\/$/, '') + '/api/agent';
const auth = { Authorization: `Bearer ${config.agentKey}` };

async function api<T>(p: string, body: unknown, gzip = false): Promise<T> {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': gzip ? 'application/gzip' : 'application/json' },
    body: gzip ? new Uint8Array(zlib.gzipSync(Buffer.from(JSON.stringify(body)))) : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(`${p}: ${res.status} ${data.error ?? ''}`.trim());
  return data;
}

interface Due { tallyGuid: string; tallyName: string; fy: string; jobId?: string }

async function cycle(): Promise<number> {
  let companies: Awaited<ReturnType<TallyClient['companies']>> = [];
  let reachable = true;
  try { companies = await tally.companies(); } catch (e) { reachable = false; log(`Tally not reachable: ${(e as Error).message}`); }
  const { due, pollSeconds } = await api<{ due: Due[]; pollSeconds: number }>('/hello', { pcName: os.hostname(), agentVersion: VERSION, tallyReachable: reachable, companies });
  for (const d of due) {
    const company = companies.find((c) => c.guid === d.tallyGuid);
    if (!company) continue;
    log(`Syncing ${d.tallyName} FY ${d.fy}${d.jobId ? ' (requested)' : ''}`);
    try {
      const snap = await buildSnapshot(tally, company, d.fy, VERSION, log);
      const r = await api<{ status: string; checks: { ok: boolean; message: string }[] }>('/snapshot', snap, true);
      log(`  uploaded: ${r.status}${r.checks.filter((c) => !c.ok).map((c) => ` · ${c.message}`).join('')}`);
      if (d.jobId) await api(`/jobs/${d.jobId}/done`, { ok: true });
    } catch (e) {
      log(`  failed: ${(e as Error).message}`);
      if (d.jobId) await api(`/jobs/${d.jobId}/done`, { ok: false, error: (e as Error).message.slice(0, 900) }).catch(() => {});
    }
  }
  return pollSeconds ?? 60;
}

async function main() {
  log(`Infominer sync agent ${VERSION} on ${os.hostname()} → ${config.serverUrl}`);
  let backoff = 30;
  for (;;) {
    let wait: number;
    try {
      wait = await cycle();
      backoff = 30;
    } catch (e) {
      log(`Cycle failed: ${(e as Error).message}`);
      wait = backoff;
      backoff = Math.min(backoff * 2, 900); // portal unreachable: retry with growing gaps, up to 15 minutes
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

main().catch((e) => { log(`Fatal: ${(e as Error).message}`); process.exit(1); });
