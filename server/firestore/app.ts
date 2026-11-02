import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import { config } from '../config.ts';
import { adminRouter } from '../routes-fs/admin.ts';
import { authRouter } from '../routes-fs/auth.ts';
import { dashboardRouter } from '../routes-fs/dashboard.ts';
import { documentsRouter } from '../routes-fs/documents.ts';
import { privacyRouter } from '../routes-fs/privacy.ts';
import { tasksRouter } from '../routes-fs/tasks.ts';
import { timeRouter } from '../routes-fs/time.ts';
import { csrfGuard, HttpError, loadSession, requireAuth, requireConsent } from './http.ts';

/**
 * The Firestore-backed Express app: same routes, order and security as server/index.ts, except Tally sync
 * and reports, which are not on Firestore yet (the app hides them; see `features` in /api/auth/me).
 * Run via server/index-fs.ts.
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProd) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'], 'connect-src': ["'self'"], 'frame-ancestors': ["'none'"], 'form-action': ["'self'"],
      },
    },
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, backend: 'firestore' }));

  app.use('/api', express.json({ limit: '100kb' }), cookieParser(), loadSession, csrfGuard);
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.use('/api/auth', authRouter);
  app.use('/api', privacyRouter); // reachable before consent, so clients can read the notice and give consent
  app.use('/api', requireAuth, requireConsent);
  app.use('/api', adminRouter, documentsRouter, tasksRouter, timeRouter, dashboardRouter);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // Production: serve the built web app.
  if (config.isProd) {
    const dist = path.resolve('dist');
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A file is larger than 25 MB.' : 'Upload rejected.';
      return res.status(413).json({ error: msg });
    }
    if ((err as { type?: string }).type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    if ((err as { type?: string }).type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    // Never leak internals to the browser.
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
