// Imported first by every Firestore test: the tests wipe data and accounts, so they must never reach a real project.
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Refusing to run: FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must both be set, or this would wipe the real project. Start `npm run emulator` and run with FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099.');
}
// Start every test with no Firebase accounts.
await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-infominer'}/accounts`,
  { method: 'DELETE', headers: { authorization: 'Bearer owner' } });
export {};
