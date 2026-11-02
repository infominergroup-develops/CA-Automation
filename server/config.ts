import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader so secrets never need to be passed on the command line.
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv(path.resolve(process.cwd(), '.env'));

function key(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set. See .env.example.`);
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded.`);
  return buf;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 3001), // Cloud Run sets PORT
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  masterKey: key('MASTER_KEY'),
  otpSecret: key('OTP_SECRET'),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  // Encrypted document files: a Cloud Storage bucket in production, or local disk (dataDir/files) when unset.
  docsBucket: process.env.DOCS_BUCKET || undefined,
  // 'off' = temporary: staff sign in with password only and client sign-in is refused (clients have no password).
  otpProvider: (process.env.OTP_PROVIDER ?? 'console') as 'console' | 'file' | 'sms' | 'off',

  // Session policy
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 12,
  cookieName: isProd ? '__Host-sid' : 'sid',

  // Login policy
  otpTtlMinutes: 5,
  otpMaxAttempts: 5,
  maxFailedLogins: 5,
  lockMinutes: 15,

  // Documents
  maxUploadBytes: 25 * 1024 * 1024,

  // Task-based document access ends after this many days even if the task stays open.
  accessGrantDays: 30,

  // Time tracking: a running timer with no heartbeat for this long is stopped at its last activity.
  timerStaleMinutes: 20,
  manualEntryApprovalHours: 2,
};

if (isProd && (config.otpProvider === 'console' || config.otpProvider === 'file')) {
  throw new Error(`OTP_PROVIDER=${config.otpProvider} is not allowed in production.`);
}
if (isProd && !config.appOrigin.startsWith('https://')) {
  throw new Error('APP_ORIGIN must be https in production.');
}

fs.mkdirSync(path.join(config.dataDir, 'files'), { recursive: true, mode: 0o700 });
