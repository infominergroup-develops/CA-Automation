import { db } from './client.ts';
import { getById } from './store.ts';
import { C } from './types.ts';

/** Firm-wide settings (one document per key), with defaults. Shown in the public privacy notice. */
export const SETTING_DEFAULTS: Record<string, string> = {
  privacy_notice_version: '2026-10-01',
  grievance_officer_name: '',
  grievance_officer_email: '',
  grievance_officer_phone: '',
  dpdp_response_days: '30',
  firm_name: 'Infominer',
};

export async function getSetting(key: string): Promise<string> {
  const d = await getById<{ value: string }>(C.settings, key);
  return d?.value ?? SETTING_DEFAULTS[key] ?? '';
}

export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(keys.map(async (k) => [k, await getSetting(k)] as const));
  return Object.fromEntries(entries);
}

export const setSetting = (key: string, value: string) => db.collection(C.settings).doc(key).set({ key, value });

/** Writes any missing default settings. Safe to call repeatedly. */
export async function ensureSettingDefaults(): Promise<void> {
  await Promise.all(Object.entries(SETTING_DEFAULTS).map(async ([k, v]) => {
    if (!(await getById(C.settings, k))) await db.collection(C.settings).doc(k).set({ key: k, value: v });
  }));
}
