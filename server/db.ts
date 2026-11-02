import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';

export const db = new DatabaseSync(path.join(config.dataDir, 'portal.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
db.exec(fs.readFileSync(new URL('./schema-tally.sql', import.meta.url), 'utf8'));

export const DEFAULT_CATEGORIES = [
  'Bank statements', 'Sales invoices', 'Purchase bills', 'Expense bills', 'GST documents',
  'TDS / TCS', 'Payroll and PF/ESI', 'Fixed assets', 'Loans', 'Investments', 'Income tax',
  'ROC / MCA', 'KYC', 'Others',
];
{
  const insert = db.prepare('INSERT OR IGNORE INTO document_categories (name, sort) VALUES (?, ?)');
  DEFAULT_CATEGORIES.forEach((name, i) => insert.run(name, i));
}

export const SETTING_DEFAULTS: Record<string, string> = {
  privacy_notice_version: '2026-10-01',
  grievance_officer_name: '',
  grievance_officer_email: '',
  grievance_officer_phone: '',
  // Days within which a data-principal request must be answered (check against the DPDP Rules in force).
  dpdp_response_days: '30',
  firm_name: 'Infominer',
};
{
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) insert.run(k, v);
}

export type Params = SQLInputValue[] | Record<string, SQLInputValue>;

function bind(sql: string, params?: Params) {
  const stmt = db.prepare(sql);
  return { stmt, args: params === undefined ? [] : Array.isArray(params) ? params : [params] };
}

export function one<T>(sql: string, params?: Params): T | undefined {
  const { stmt, args } = bind(sql, params);
  return stmt.get(...(args as SQLInputValue[])) as T | undefined;
}

export function all<T>(sql: string, params?: Params): T[] {
  const { stmt, args } = bind(sql, params);
  return stmt.all(...(args as SQLInputValue[])) as T[];
}

export function run(sql: string, params?: Params) {
  const { stmt, args } = bind(sql, params);
  return stmt.run(...(args as SQLInputValue[]));
}

let depth = 0;
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const now = () => new Date().toISOString();
export const id = () => randomUUID();

export function setting(key: string): string {
  return one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? SETTING_DEFAULTS[key] ?? '';
}
