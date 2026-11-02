# Infominer CA Practice Portal

Client portal and practice workflow for the firm: clients upload documents and track work; directors and managers assign tasks, grant document access and approve; employees log time. Built to the spec in `../CA Firm Practice Portal — Requirements Spec.pdf`.

**Phase 1 (done):** logins for 4 roles, encrypted document upload by category / FY / month, task workflow with access requests and approval, time tracking, tamper-evident audit trail, and DPDP Act tooling.
**Phase 2 (done):** Tally sync agent for every Tally PC, and one-click Balance Sheet, Profit & Loss, Trial Balance, ledger statements, debtors and creditors, on screen, as PDF and as Excel.
**Next phases:** quality-check rules on the synced books (Phase 3), WhatsApp bot (Phase 4).

## Run it locally

Needs Node 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env          # then generate MASTER_KEY and OTP_SECRET as the file explains, and fill SEED_DIRECTOR_*
npm run seed                  # creates the first Director; add `-- --demo` for demo manager/employee/client
npm run dev                   # API on :3001, web on http://localhost:5173
```

Generated passwords go to `data/initial-credentials.txt` (never printed). In development, one-time codes are printed in the API console.

## Try Tally sync without Tally

```bash
npm run demo:setup     # once: registers a "Demo PC (simulator)" agent
npm run demo:tally     # Tally simulator on :9000 + the agent, feeding two years of sample books
```

Then sign in as Director, open **Tally sync**, link *Demo Traders* to *Demo Traders Pvt Ltd*, and open the company's **Reports** tab within a minute. Real PCs are set up from the same page; see `agent/README.md`.

## How Tally sync works

| Step | What happens |
| --- | --- |
| Agent on each Tally PC | Every minute reports which companies Tally has open (`/api/agent/hello`). Authenticates with its own key; only a hash is stored. |
| Portal decides | Sync the current FY every 2 hours, last FY daily, or now if a client pressed *Request fresh data*. Only the company's **primary** PC is asked. |
| Agent reads Tally | Groups, ledgers, month-end balances, stock value and vouchers through Tally's XML interface (read-only), gzip, upload. |
| Portal checks | Trial balance tallies; every voucher balances; opening + vouchers = Tally's closing for every ledger. Failures show as warnings to staff. |
| Reports | Built from one data model, so screen, PDF and Excel always agree. PDFs carry the viewer's name and time; every view and download is audited. |

Managers control, per company and FY, whether clients can see the figures and whether they are final (removes the *Provisional, unaudited* label).

**Verify on real data before go-live:** the agent was built against Tally's XML interface and tested end to end against the bundled simulator (`tools/mock-tally.ts`), not yet against a live TallyPrime. On the first real company, compare the portal's Balance Sheet, P&L and two ledger statements with Tally to the rupee (Phase 2 acceptance criterion).

## UI checks (Playwright + axe)

```bash
npm run test:ui
```

Builds an isolated, fully populated copy of the portal (`.test-data/`, ports 3201/5273, Tally simulator on 9301), signs in as each role, visits every page on desktop (1440 px) and phone (Pixel 7), saves full-page screenshots to `test-results/screens/`, and fails on any serious or critical WCAG 2.1 AA issue or browser console error. Never touches `./data`.

Design system notes: tokens live in `src/index.css` (brand colours, accessible greys, soft shadows, easing); motion lives in `src/motion.ts` (GSAP reveal-on-enter, count-up numbers, login entrance) and is skipped entirely for users who prefer reduced motion.

## Stack

| Part | Choice |
| --- | --- |
| Web | React 19, Vite, Tailwind v4, brand colours from `development/color.md` |
| API | Express 5, TypeScript (run with tsx), zod validation |
| Database | SQLite (WAL) in `DATA_DIR`; schema in `server/schema.sql` |
| Files | Encrypted blobs in `DATA_DIR/files` |

SQLite is enough for one firm (hundreds of clients, tens of staff) on one server. The data layer is plain SQL in `server/db.ts`, so moving to Postgres later is a contained change.

## Security design

| Concern | How it is handled | Where |
| --- | --- | --- |
| Sign-in | Clients: mobile/email + 6-digit OTP. Staff: password (scrypt) + OTP. Codes are HMAC-hashed, expire in 5 min, max 5 tries. Unknown accounts get the same response (no enumeration). Account locks for 15 min after 5 wrong passwords. Rate limits on login and verify. | `routes/auth.ts`, `security/otp.ts` |
| Sessions | 256-bit random token in an httpOnly, SameSite=Strict cookie (`__Host-` + Secure in production); only its SHA-256 is stored. 30-min idle and 12-h absolute timeout. Password change signs out other devices; disabling a user ends all sessions. | `security/session.ts` |
| CSRF | SameSite=Strict, plus a required `X-Requested-With` header and Origin check on every state-changing request. | `security/session.ts` |
| Authorization | Decided on the server for every request. Managers see their clients; employees see a client only while assigned an open task, and only document categories a manager granted, until approval or 30 days. Unknown or out-of-scope ids return 404. Reviewer ≠ assignee; nobody approves their own time. | `authz.ts` |
| Document confidentiality | Each file gets its own AES-256-GCM key; that key is wrapped with `MASTER_KEY`. The document id is bound as associated data, so ciphertexts cannot be swapped between records. No public URLs; downloads stream through the API with `no-store`. | `security/crypto.ts`, `routes/documents.ts` |
| Document integrity and authenticity | SHA-256 of every file is recorded at upload and shown in the UI. Every download is decrypted, authenticated (GCM tag) and re-hashed; a mismatch is refused and logged as `document.integrity_failure`. Duplicate uploads are flagged. | `routes/documents.ts` |
| Upload safety | File type decided from the bytes (PDF, images, Office, CSV, ZIP only), 25 MB limit, names sanitised. | `routes/documents.ts` |
| Audit trail | Append-only, hash-chained log of sign-ins, views, downloads, uploads, task and access decisions, privacy actions. Database triggers block UPDATE and DELETE; the Director can re-verify the whole chain from the UI. | `audit.ts` |
| Headers | Helmet with a strict CSP, frame-ancestors none, no-referrer, HSTS in production, no-store on all API responses. | `index.ts` |
| Errors | Internal errors are logged server-side; the browser gets a generic message. | `index.ts` |

## DPDP Act, 2023 mapping

| Requirement | Implementation |
| --- | --- |
| Notice and consent (s.5, s.6) | Clients see an itemised notice and give purpose-specific consent before any use of the portal. Consent records store notice version, purposes, time and IP. Changing the notice version asks everyone again. |
| Withdrawal as easy as giving (s.6(4)) | One click on the Privacy page; withdrawing service consent signs the client out and opens a request for the firm. |
| Right to access (s.11) | "Download my data" gives a JSON summary of profile, companies, uploads, consents and activity. |
| Correction, erasure, nomination, grievance (s.12–s.14) | Request form with due dates; Director queue to respond. Erasure guidance reminds that statutory records are retained. |
| Grievance Officer contact (s.8(10)) | Set in Privacy settings; shown in the notice. |
| Security safeguards (s.8(5)) | See the table above. |
| Breach intimation (s.8(6)) | Breach register with Board intimation and individual notification timestamps. |
| Purpose limitation and minimisation | Employees see only granted categories for the task; clients never see staff names or internal comments. |
| Employee data | Staff acknowledge a plain notice of what is tracked before any timer runs. No screenshots, keystrokes, camera or location. |

Check timelines (response days, breach reporting) against the DPDP Rules in force and set `dpdp_response_days` accordingly.

## Deploy to DigitalOcean

One droplet runs the app in Docker with Caddy in front for automatic HTTPS. The database and encrypted files live in `/opt/portal/data` on the droplet.

1. **Create the droplet.** Marketplace image *Docker on Ubuntu*, region **Bangalore (BLR1)** (keeps data in India), Basic 2 GB RAM or more, SSH key login, and tick **Backups → Daily**.
2. **Point your domain.** Add an `A` record, e.g. `portal.infominers.in` → the droplet's IP. Wait until it resolves.
3. **Open only SSH and web ports** on the droplet:
   ```bash
   ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
   ```
4. **Copy the project, with your data and keys,** from your Mac (stop `npm run dev` first so the database is not mid-write):
   ```bash
   rsync -av --exclude node_modules --exclude dist --exclude data-demo-backup --exclude .git ./ root@DROPLET_IP:/opt/portal/
   ```
5. **Set production values** in `/opt/portal/.env` on the droplet:
   ```
   DOMAIN=portal.infominers.in
   APP_ORIGIN=https://portal.infominers.in
   OTP_PROVIDER=off
   ```
   Keep `MASTER_KEY` and `OTP_SECRET` exactly as they are; documents encrypted with one key cannot be read with another. `NODE_ENV`, `DATA_DIR` and `API_PORT` are set by `docker-compose.yml`.
6. **Start it:**
   ```bash
   cd /opt/portal && chown -R 1000:1000 data && chmod 600 .env && docker compose up -d --build
   docker compose logs -f app   # expect "Infominer portal API on ... (production)"
   ```
7. Open `https://portal.infominers.in`, sign in as the Director, then delete `/opt/portal/data/initial-credentials.txt` once everyone has their password.

**Updating later:** copy the code without touching the server's data or keys, then rebuild.
```bash
rsync -av --exclude node_modules --exclude dist --exclude data --exclude data-demo-backup --exclude .env --exclude .git ./ root@DROPLET_IP:/opt/portal/
ssh root@DROPLET_IP "cd /opt/portal && docker compose up -d --build"
```

**Backups:** droplet backups cover the whole disk. Also keep an offline copy of `MASTER_KEY`; without it, a backup's documents cannot be decrypted.

## Before go-live checklist

- [ ] Host in an India region (e.g. AWS Mumbai) on an encrypted disk; run behind nginx/ALB with HTTPS; set `NODE_ENV=production` and `APP_ORIGIN=https://…`.
- [ ] Generate production `MASTER_KEY` and `OTP_SECRET`; store them in a secrets manager and keep an offline copy of `MASTER_KEY`. Losing it means losing every document.
- [ ] Wire a DLT-registered SMS or WhatsApp OTP provider in `server/security/otp.ts` (the console provider is refused in production).
- [ ] Nightly encrypted backups of `DATA_DIR` (database + files) to a second location; test a restore.
- [ ] Each week, record the audit chain's latest hash (Audit trail → Verify integrity) outside the system, e.g. by email, so history cannot be rewritten unnoticed.
- [ ] Appoint the Grievance Officer and fill Privacy settings; have the privacy notice text reviewed.
- [ ] Remove `data/initial-credentials.txt` after first sign-in.
- [ ] Independent penetration test before onboarding clients.

## Project layout

```
server/
  index.ts            app, security headers, dashboard, error handling
  config.ts           env + policy constants
  schema.sql, db.ts   schema and SQL helpers
  authz.ts            who can see which company, document and task
  audit.ts            hash-chained audit log
  security/           crypto, sessions/CSRF, OTP
  routes/             auth, admin (users/clients/settings), documents, tasks, time, privacy (+ audit API), tally (agents, reports)
  tally/              snapshot ingestion and checks, report engine, PDF/Excel rendering
  seed.ts             first Director / demo data
src/
  pages/              Login, Gates, Dashboard, Clients, Reports, Tally, Tasks, Review, Time, Team, Audit, Privacy
agent/                Tally sync agent (src, Windows installer, setup guide)
tools/                Tally simulator and demo setup
  components/         Layout, DocumentsPanel, InfominerLogo, ui primitives
```
# CA-Automation
