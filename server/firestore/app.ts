import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { config } from '../config.ts';
import { authRouter } from '../routes-fs/auth.ts';
import { csrfGuard, HttpError, loadSession } from './http.ts';

/**
 * The Firestore-backed Express app. Built in parallel with the SQLite server so the live app stays
 * untouched; routers are mounted here as each slice is wired. Run via server/index-fs.ts.
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

  app.get('/healthz', (_req, res) => res.json({ ok: true, backend: 'firestore' }));

  app.use('/api', express.json({ limit: '100kb' }), cookieParser(), loadSession, csrfGuard);
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.use('/api/auth', authRouter);
  // Further routers (admin, documents, tasks, time, privacy, tally) mount here as they are wired.

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
