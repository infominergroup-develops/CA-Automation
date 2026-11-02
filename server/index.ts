import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import { config } from './config.ts';
import { companyScope } from './authz.ts';
import { all, one } from './db.ts';
import { adminRouter } from './routes/admin.ts';
import { authRouter } from './routes/auth.ts';
import { documentsRouter } from './routes/documents.ts';
import { privacyRouter } from './routes/privacy.ts';
import { tasksRouter } from './routes/tasks.ts';
import { agentRouter, tallyRouter } from './routes/tally.ts';
import { sweepStaleTimers, timeRouter } from './routes/time.ts';
import { purgeExpiredChallenges } from './security/otp.ts';
import { HttpError, csrfGuard, loadSession, requireAuth, requireConsent } from './security/session.ts';

const app = express();
app.disable('x-powered-by');
// Behind one reverse proxy (nginx / load balancer) in production, so req.ip is the real client.
if (config.isProd) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
    },
  },
  strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  next();
});

// Tally sync agents use their own key (no cookies) and send larger, compressed bodies, so they are routed first.
app.use('/api/agent', agentRouter);

app.use('/api', express.json({ limit: '100kb' }), cookieParser(), loadSession, csrfGuard);
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api/auth', authRouter);
app.use('/api', privacyRouter); // reachable before consent, so clients can read the notice and give consent
app.use('/api', requireAuth, requireConsent);
app.use('/api', adminRouter, documentsRouter, tasksRouter, timeRouter, tallyRouter);

app.get('/api/dashboard', (req, res) => {
  const u = req.user!;
  const scope = companyScope(u);
  const sc = scope ? JSON.stringify(scope) : null;
  // Bound as parameters: `sc` is passed twice wherever inScope appears.
  const inScope = 'AND (? IS NULL OR company_id IN (SELECT value FROM json_each(?)))';
  const S = [sc, sc];
  const count = (sql: string, args: (string | null)[] = []) => one<{ n: number }>(sql, args)?.n ?? 0;
  if (u.role === 'client') {
    return res.json({
      openTasks: count(`SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('approved','cancelled') ${inScope}`, S),
      reuploadDocs: count(`SELECT COUNT(*) n FROM documents WHERE review_status = 'reupload' AND deleted_at IS NULL ${inScope}`, S),
      recentlyCompleted: all(`SELECT id, title, approved_at, client_note FROM tasks WHERE status = 'approved' ${inScope} ORDER BY approved_at DESC LIMIT 5`, S),
    });
  }
  res.json({
    myOpenTasks: count(`SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status IN ('assigned','in_progress','rework')`, [u.id]),
    myRework: count(`SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status = 'rework'`, [u.id]),
    toReview: u.role === 'employee' ? 0 : count(`SELECT COUNT(*) n FROM tasks WHERE status = 'submitted' AND (reviewer_id = ? OR ? = 'director')`, [u.id, u.role]),
    accessRequests: u.role === 'employee' ? 0 : count(
      `SELECT COUNT(*) n FROM access_grants g JOIN tasks t ON t.id = g.task_id WHERE g.status = 'requested' AND (t.reviewer_id = ? OR t.created_by = ? OR ? = 'director')`,
      [u.id, u.id, u.role]),
    clientRequests: u.role === 'employee' ? 0 : count(`SELECT COUNT(*) n FROM tasks WHERE status = 'requested' ${inScope}`, S),
    pendingDocs: u.role === 'employee' ? 0 : count(`SELECT COUNT(*) n FROM documents WHERE review_status = 'pending' AND deleted_at IS NULL ${inScope}`, S),
    overdue: count(`SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('approved','cancelled','requested') AND due_date < date('now') ${u.role === 'employee' ? 'AND assignee_id = ?' : inScope}`, u.role === 'employee' ? [u.id] : S),
    privacyOpen: u.role === 'director' ? count(`SELECT COUNT(*) n FROM dpdp_requests WHERE status IN ('open','in_progress')`) : 0,
    upcoming: all(
      `SELECT t.id, t.title, t.status, t.due_date, c.legal_name AS company FROM tasks t JOIN companies c ON c.id = t.company_id
       WHERE t.status NOT IN ('approved','cancelled','requested') AND t.due_date IS NOT NULL
       ${u.role === 'employee' ? 'AND t.assignee_id = ?' : inScope.replace('company_id', 't.company_id')}
       ORDER BY t.due_date LIMIT 8`, u.role === 'employee' ? [u.id] : S),
  });
});

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

setInterval(() => {
  sweepStaleTimers();
  purgeExpiredChallenges();
}, 5 * 60e3).unref();

app.listen(config.port, () => {
  console.log(`Infominer portal API on http://localhost:${config.port} (${config.isProd ? 'production' : 'development'})`);
});
