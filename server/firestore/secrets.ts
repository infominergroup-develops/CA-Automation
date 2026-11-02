/**
 * Loads secrets into process.env BEFORE the app's config is read, so keys (MASTER_KEY, OTP_SECRET, SMS
 * creds) never sit in a file on the server. Must not import ./config.ts or anything that does.
 *
 * In production (Cloud Run) set INFOMINER_SECRETS from Google Secret Manager — the recommended way is to
 * mount the secret as the environment itself, in which case this is a no-op. If instead you set
 * INFOMINER_SECRETS_ID to a secret's resource name, this fetches that JSON secret at boot. For local dev
 * and tests, env / .env is used and this does nothing.
 */
export async function loadSecretsIntoEnv(): Promise<void> {
  const id = process.env.INFOMINER_SECRETS_ID;
  if (!id) return; // dev/test, or secrets already mounted into the environment

  // Imported lazily (non-literal specifier) so the Secret Manager SDK is only a dependency at deploy time.
  const pkg = '@google-cloud/secret-manager';
  const mod = (await import(pkg)) as { SecretManagerServiceClient: new () => { accessSecretVersion(req: { name: string }): Promise<[{ payload?: { data?: { toString(): string } } }]> } };
  const client = new mod.SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: id.includes('/versions/') ? id : `${id}/versions/latest` });
  const payload = version.payload?.data?.toString();
  if (!payload) throw new Error(`Secret ${id} has no payload.`);

  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { throw new Error(`Secret ${id} must be JSON: {"MASTER_KEY":"…", …}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Secret ${id} must be a JSON object.`);

  let loaded = 0;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (process.env[k] === undefined && v != null) { process.env[k] = String(v); loaded++; }
  }
  console.log(`Loaded ${loaded} secret value(s) from Secret Manager.`);
}
