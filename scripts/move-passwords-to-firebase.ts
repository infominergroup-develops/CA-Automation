/**
 * One-off: copies every user's password from Firestore into Firebase Authentication (same id, same password).
 *   GOOGLE_CLOUD_QUOTA_PROJECT=infominer-dev-fdbfa npx tsx scripts/move-passwords-to-firebase.ts
 * Then deploy, check that people can sign in, and only then delete the old hashes from Firestore:
 *   GOOGLE_CLOUD_QUOTA_PROJECT=infominer-dev-fdbfa npx tsx scripts/move-passwords-to-firebase.ts --remove-hashes
 * Safe to run again. It runs as you (gcloud auth application-default login).
 */
await import('../server/config.ts'); // loads .env
const { db, projectId } = await import('../server/firestore/client.ts');
const { accounts, checkPassword, deleteAccount } = await import('../server/firestore/firebase-auth.ts');
const { hashPassword, randomToken } = await import('../server/security/crypto.ts');
const { FieldValue, query } = await import('../server/firestore/store.ts');
const { C } = await import('../server/firestore/types.ts');
type UserDoc = import('../server/firestore/types.ts').UserDoc;

interface Row { id: string; email: string; name: string; hash: string; disabled: boolean }
const webSafe = (b64: string) => Buffer.from(b64, 'base64').toString('base64url');

async function importAccounts(rows: Row[]) {
  const r = await accounts(':batchCreate', {
    hashAlgorithm: 'STANDARD_SCRYPT', cpuMemCost: 1 << 15, blockSize: 8, parallelization: 1, dkLen: 32, allowOverwrite: true,
    users: rows.map((u) => {
      const [, N, rr, p, salt, hash] = u.hash.split('$');
      if (`${N}/${rr}/${p}` !== '32768/8/1') throw new Error(`Unexpected password hash settings for ${u.email}.`);
      return { localId: u.id, email: u.email, displayName: u.name, disabled: u.disabled, salt: webSafe(salt), passwordHash: webSafe(hash) };
    }),
  });
  if (r.error?.length) throw new Error(`Firebase refused part of the import: ${JSON.stringify(r.error)}`);
}

console.log('Project:', projectId);
const users = await query<UserDoc>(C.users);
const withHash = users.filter((u) => u.email && u.password_hash);

if (process.argv.includes('--remove-hashes')) {
  const found = withHash.length ? await accounts(':lookup', { localId: withHash.map((u) => u.id) }) : {};
  const have = new Set((found.users ?? []).filter((u: any) => u.passwordHash).map((u: any) => u.localId));
  const missing = withHash.filter((u) => !have.has(u.id));
  if (missing.length) throw new Error(`Not removing anything: no Firebase password for ${missing.map((u) => u.email).join(', ')}.`);
  await Promise.all(withHash.map((u) => db.collection(C.users).doc(u.id).update({ password_hash: FieldValue.delete() })));
  console.log(`Removed ${withHash.length} old password hash(es) from Firestore.`);
} else {
  // Prove on a throwaway account that Firebase accepts our hashes before touching a real one.
  const probe = { id: 'migration-check', email: 'migration-check@example.invalid' };
  const password = randomToken();
  try {
    await importAccounts([{ ...probe, name: 'Migration check', hash: await hashPassword(password), disabled: false }]);
    if (!(await checkPassword(probe, password)) || await checkPassword(probe, `${password}x`)) {
      throw new Error('Stopped: Firebase did not accept an imported password, so no real account was touched.');
    }
  } finally {
    await deleteAccount(probe.id).catch(() => {});
  }
  // Someone else may already hold one of these emails under another uid; importing over it would merge two people.
  const taken = withHash.length ? (await accounts(':lookup', { email: withHash.map((u) => u.email) })).users ?? [] : [];
  const clash = taken.filter((a: any) => !withHash.some((u) => u.id === a.localId));
  if (clash.length) throw new Error(`Stopped: Firebase already has other accounts for ${clash.map((a: any) => a.email).join(', ')}. Delete them in the console first.`);
  await importAccounts(withHash.map((u) => ({ id: u.id, email: u.email!, name: u.name, hash: u.password_hash!, disabled: u.status !== 'active' })));
  for (const u of withHash) console.log(`copied ${u.role} ${u.email}${u.status === 'active' ? '' : ' (disabled)'}`);
  const skipped = users.filter((u) => !withHash.includes(u));
  if (skipped.length) console.log(`skipped (no email or password): ${skipped.map((u) => u.name).join(', ')}`);
}
await db.terminate();
export {};
