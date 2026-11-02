import { loadSecretsIntoEnv } from './firestore/secrets.ts';
import { config } from './config.ts';

/**
 * Entry point for the Firestore-backed server. Loads secrets (Secret Manager in production), then the app.
 * Run: npm run start:fs
 */
await loadSecretsIntoEnv();
const { createApp } = await import('./firestore/app.ts');
createApp().listen(config.port, () => {
  console.log(`Infominer portal (Firestore) on http://localhost:${config.port} (${config.isProd ? 'production' : 'development'})`);
});
