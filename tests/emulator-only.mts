// Imported first by every Firestore test: the tests wipe collections, so they must never reach a real project.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set, so this would wipe the real Firestore. Start `npm run emulator` and run with FIRESTORE_EMULATOR_HOST=127.0.0.1:8089.');
}
