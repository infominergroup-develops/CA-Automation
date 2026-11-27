# Codebase audit report — Infominer CA portal

Audit date: 27–28 November 2026. Scope: this repository (`portal/`): the React frontend (`src/`), the Firestore server that runs in production (`server/firestore`, `server/routes-fs`, `server/index-fs.ts`), the older SQLite server (`server/routes`, `server/index.ts`), the Tally agent (`agent/`), the Docker, nginx and deploy scripts, and the live site https://portal.infominervaluation.com (read-only checks only).

Everything marked as run below was actually run, and its output was read. Anything not run says so.

## 1. Executive summary

The portal is in good shape for a small firm's client portal. Access is decided on the server for every request; files are encrypted per file with keys wrapped by a master key; the audit log is hash-chained; sessions, cookies, CSRF and HTTP headers are done properly; and there are 433 automated checks across 9 suites, all passing.

The audit found and fixed:
- **Critical/High:** two critical and four high dependency vulnerabilities;
- **High:** a GCM tag-length weakness in file decryption;
- **High:** tests writing into the real Google Cloud bucket;
- **Medium:** a race in the wrong-password lockout;
- **Low:** account enumeration through the lock message, a 500 error on crafted ids, and nginx trusting the visitor's Host header.

Four production issues remain, and they cannot be closed in code alone. They are listed in section 12:
- **No second factor at sign-in on the live site:** OTP is off because no SMS provider is set up.
- **A long-lived, all-powerful Google key** sits on a server that is shared with other sites.
- **A GitHub token** is stored in plain text in the git remote URL.
- **Unlimited uploads** let any signed-in user fill the server's disk.

**Production readiness: conditional pass.** It is fine for the current controlled rollout. Before inviting all clients, a second factor for staff and replacing the shared key are needed.

## 2. Existing architecture

| Layer | What it is |
|---|---|
| Frontend | React 19 + Vite + Tailwind, React Router; pages in `src/pages`, shared UI in `src/components/ui.tsx`, one fetch wrapper in `src/api.ts` |
| Server (production) | Express 5 + TypeScript (tsx). `server/firestore/app.ts` sets up middleware in a clear order: headers → `/healthz` → path check → JSON (100 kB) → cookies → session → CSRF → auth routes → privacy routes → `requireAuth` + consent → feature routers → 404 → error handler |
| Data | Firestore (records), Firebase Authentication (passwords), Cloud Storage (encrypted files), Secret Manager (master key etc.) |
| Access control | `server/firestore/authz.ts` (which clients a user may see), `server/firestore/rights.ts` (view/edit/move/download/delete per person), enforced in each route |
| Hosting | Docker on a shared DigitalOcean droplet behind that server's nginx; `scripts/deploy-droplet.sh` ships only committed code (`git archive HEAD`) |

The structure is understandable: one router per area (`admin`, `auth`, `documents`, `tasks`, `time`, `master`, `privacy`, `dashboard`), with data access in `server/firestore/*`. Routes stay thin enough. There are no circular imports, and config loads after secrets.

**The main structural problem is two parallel servers.** `server/routes/*` + `server/index.ts` (SQLite) mirror `server/routes-fs/*` (Firestore) almost route for route. Only the Firestore one is deployed. The SQLite one still carries Tally sync and reports, which are not on Firestore yet. Every feature has to be written twice or the two drift; they already have drifted, since the newer folder, rights and username features exist only on Firestore. **Recommendation:** move Tally to Firestore (the design is already agreed and on hold), then delete the SQLite server. That isn't done here because it would remove a working feature.

## 3. Code quality

- **TypeScript is strict across the project.** `tsc --noEmit` is clean, with no `: any` or `as any` in `server/` or `src/`. Request bodies are validated with zod at every route (`parse(...)`).
- **Naming and comments are consistent.** Names are domain words (`companyScope`, `assertCompany`, `placeFile`, `folderPath`). Comments explain why, not what.
- **Errors go through one handler:** `HttpError` for expected cases and a single error handler that never leaks internals.
- **Large files:** `src/components/DocumentsPanel.tsx` (588 lines), `src/components/ui.tsx` (488), `src/pages/Master.tsx` (439) and `src/pages/Clients.tsx` (403). DocumentsPanel holds the file tree, upload, move, viewer and delete flows. Splitting the viewer and the upload zone into their own files would help, but it's not urgent. I didn't do it, to avoid UI regressions without a UI test run.
- **No ESLint:** `npm run lint` is only `tsc`. Adding ESLint is a reasonable next step. I didn't add it, since that means new dependencies the project hasn't chosen.

## 4. Folder structure

The structure is sound: `server/firestore` (data and rules), `server/routes-fs` (HTTP), `server/security` (crypto), `src/pages` and `src/components`, and `tests` with one file per area. One thing to tidy: `firestore-debug.log` is committed and `firebase-debug.log` is untracked. Both are emulator logs and belong in `.gitignore`.

## 5. Security findings

| # | Severity | Finding | Status |
|---|---|---|---|
| S1 | Critical | Dependencies: `shell-quote` command injection and `concurrently`, both dev tools only | **Fixed** (`npm audit fix`) |
| S2 | High | Dependencies: `body-parser` and `multer` DoS, `zod` memory exhaustion, `vite` dev-server command execution | **Fixed** (`npm audit fix`) |
| S3 | High | AES-GCM decryption didn't fix the tag length, so a stored tag cut down to 4 bytes was accepted (shown with a test: the old code accepted it), making forgery far easier for anyone who can edit file metadata | **Fixed:** `authTagLength: 16` on all three decipher calls in `server/security/crypto.ts`; test added |
| S4 | High | Tests used the real `DOCS_BUCKET` from `.env`, so every test run wrote encrypted test files into the production bucket: 323 files, about 629 MB, under test company names. Real client folders were not touched. | **Fixed** in `tests/emulator-only.mts`. Cleaning up the files already there needs your approval (it's a permanent deletion). |
| S5 | High | No second factor: production runs with `OTP_PROVIDER=off`, so staff and clients sign in with a password alone (live `/api/auth/me` confirms `clientPassword: true`) | **Open.** Needs an SMS provider (the code path is there) or TOTP for staff |
| S6 | High | The service account key on the droplet never expires, has wide rights, and sits on a server shared with other sites | **Open:** narrow its roles, rotate it, or use Workload Identity |
| S7 | Medium | Lockout race: failures were counted read-then-write, so parallel guesses counted once | **Fixed:** counted in a Firestore transaction; test sends 5 at once |
| S8 | Medium | Unlimited uploads (asked for) let any signed-in user, including a client, fill the droplet's disk with a huge upload | **Open, by design.** Recommend a per-file cap that matches the disk, or a free-space check |
| S9 | Medium | Staff with access to a client can set that client's password, which is effectively a takeover (it's a feature while OTP is off) | Accepted. It's audited (`user.password_set`) and ends the client's sessions. Consider telling the client. |
| S10 | Medium | GitHub token stored in plain text in `.git/config` (remote URL), in an iCloud folder | **Open:** revoke it, then use `gh auth` or the macOS keychain |
| S11 | Low | Account enumeration: a locked account answered "too many attempts" to any password, which proved the username exists | **Fixed:** wrong password gives the same 401 whether locked or not; test added |
| S12 | Low | An id with an encoded slash, backslash, `.`/`..` or a reserved `__name__` reached Firestore and gave a 500 | **Fixed:** checked once in `app.ts` and refused with 404; test added |
| S13 | Low | nginx used the visitor's `Host` header in the redirect and upstream Host (Semgrep) | **Fixed:** the domain is fixed in `scripts/nginx-portal.conf` |
| S14 | Low | Lockout DoS: anyone who knows a username can lock it for 15 minutes with 5 guesses | Accepted, standard trade-off; per-IP limit is 20 per 15 minutes |
| S15 | Low | Uploaded files aren't virus-scanned | Open: programs and scripts are refused by name and by content, and files are never shown in the browser in a way that runs them |
| S16 | Low | The SQLite server (not deployed) has no upload size limit and keeps files in memory | Open: only matters if someone runs `server/index.ts` |

**Checked and passing:**
- **Sessions:** a 256-bit random token in an `httpOnly`, `SameSite=Strict`, `Secure`, `__Host-` cookie. Only its SHA-256 is stored, with a 30-minute idle and 12-hour absolute expiry. A new token is issued at sign-in, so session fixation doesn't work. Logout destroys the session server-side, and changing a password ends the other sessions.
- **CSRF:** a required custom header plus an Origin check, and no CORS is enabled.
- **Passwords:** held by Firebase Authentication (scrypt). The policy is at least 12 characters with letters and digits. Sign-in is limited to 20 per 15 minutes per IP and password change to 10 per 15 minutes.
- **IDOR:** every company, document and task id is checked against `companyScope`, and an out-of-scope id gets 404 rather than 403. The test suites cover employees, managers and clients against other clients' ids.
- **Mass assignment:** zod schemas list fields explicitly. The role change and rights routes are director-only and refuse a user's own role.
- **Injection:** there's no SQL on Firestore, and queries are typed `where` tuples. On SQLite every statement uses bound parameters. No shell commands are run with user input. File names are cleaned, and storage paths are built from cleaned folder names plus the record id.
- **XSS:** React escaping throughout, with no `dangerouslySetInnerHTML`. Word previews render in a sandboxed iframe with links filtered. Downloads are always `Content-Disposition: attachment`.
- **Headers (live):** strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), HSTS with one year and subdomains, `nosniff`, `no-referrer` and COOP/CORP. HTTP redirects to HTTPS and TLS 1.1 is refused.
- **Firestore rules:** they deny all direct client access. Only the server, using the Admin SDK, reads and writes.
- **Production config guards:** `OTP_PROVIDER=console` or `file` refuses to start in production, as does a non-HTTPS `APP_ORIGIN`.
- **Secrets:** no secrets in git history, and `.env`, `data/` and the initial-credentials files are git-ignored and kept out of the Docker build.

## 6. OWASP Top 10 (2021) coverage

| Risk | Result |
|---|---|
| A01 Broken access control | Pass: server-side scope and rights on every route; 404 for out-of-scope ids; tested per role |
| A02 Cryptographic failures | Pass after fix S3: AES-256-GCM per file, wrapped keys, SHA-256 integrity, HSTS |
| A03 Injection | Pass: zod validation, no string-built queries, no shell |
| A04 Insecure design | Partial: no second factor in production (S5); unlimited uploads (S8) |
| A05 Security misconfiguration | Pass for app and nginx; open for the shared key (S6) |
| A06 Vulnerable components | Pass after fix: 6 moderate left, all inside Google client libraries (`glob`/`minimatch` via `rimraf`), not reachable from user input |
| A07 Identification and authentication failures | Partial: lockout fixed (S7, S11); second factor missing (S5) |
| A08 Software and data integrity | Pass: hash-chained audit log, file hashes checked on every download; deploy ships only committed code |
| A09 Logging and monitoring | Pass for the audit trail; no alerting on `document.integrity_failure` or repeated `auth.login_failed` |
| A10 SSRF | Not applicable: the server fetches no user-supplied URLs |

## 7. Dependency vulnerabilities

`npm audit` before: 15 (2 critical, 4 high, 8 moderate, 1 low). After `npm audit fix`, which only changed `package-lock.json` and made no major version jumps: 6 moderate, in `glob`, `minimatch`, `rimraf`, `gaxios`, `gcp-metadata` and `google-gax`. These are pulled in by `@google-cloud/firestore` and `@google-cloud/secret-manager`, and only `rimraf` (a file-cleanup helper) uses them. They clear when Google ships new versions of those libraries.

## 8. Performance and reliability

- **Uploads and downloads stream.** Measured on a 300 MB file, the server's live memory grew less than 100 MB, versus 600 MB or more when files were held in memory. A test checks this.
- **Main bundle:** 842 kB (243 kB gzipped). Every page loads up front; only the Excel and Word previews load on demand. Lazy-loading the routes would roughly halve the first load. Low priority for a staff tool.
- **Whole-collection reads:** the documents list for a client returns at most 5,000 files at once; `userNames()` and `companyMap()` read whole collections (noted in the code as a known limit). Fine at one firm's scale; paging is needed past a few thousand records.
- **No indexes are needed:** queries use equality filters only and sort in memory.
- **Background cleanup:** sessions, challenges and stale timers are cleaned every 5 minutes, with the timer set not to keep the process alive (`unref`). Docker restarts the portal if it stops (`restart: unless-stopped`).

## 9. Testing results (all run on emulators, 28 Nov 2026)

| Suite | Result |
|---|---|
| `test:fs:clientpw` (OTP off) | 158 passed, 0 failed |
| `test:fs` identity | 38 passed, 0 failed (1 new) |
| `test:fs:docs` | 43 passed, 0 failed (2 new) |
| `test:fs:flow` | 31 passed, 0 failed |
| `test:fs:privacy` | 13 passed, 0 failed |
| `test:place` | 9 passed, 0 failed |
| `test:csv` | 5 passed, 0 failed |
| `test:fs:portal` | 119 passed, 0 failed (includes the 300 MB, memory and tamper checks) |
| `test:fs:http` | 17 passed, 0 failed (2 new) |
| Type check `tsc --noEmit` | Clean |
| Production build `vite build` | Built; warning that the main chunk is over 500 kB |
| Playwright UI tests (`test:ui`) | **Not run:** needs the UI test stack started |

## 10. Issues by severity

- **Critical:** S1 (fixed).
- **High:** S2, S3, S4 (fixed); S5, S6 (open).
- **Medium:** S7 (fixed); S8, S10 (open); S9 (accepted).
- **Low:** S11, S12, S13 (fixed); S14 (accepted); S15, S16 (open).
- **Maintainability:** two parallel servers (section 2); large components (section 3); no ESLint (section 3).

## 11. Fixes made

| File | Change |
|---|---|
| `package-lock.json` | `npm audit fix` (S1, S2) |
| `server/security/crypto.ts` | Full 16-byte GCM tags required on decrypt (S3) |
| `tests/emulator-only.mts` | Tests never use the real bucket (S4) |
| `server/firestore/users.ts` | `recordLoginFailure(userId)` counts in a transaction (S7) |
| `server/routes-fs/auth.ts` | A wrong password gets the same answer whether or not the account is locked (S11) |
| `server/firestore/app.ts` | Unsafe path segments refused with 404 before any route (S12) |
| `scripts/nginx-portal.conf` | Fixed domain instead of `$host` (S13) |
| Tests | New checks for S3, S7, S11 and S12, and the existing lockout test updated to the new signature |

No UI, API contracts or database schema were changed. The only behaviour visible to users: a locked account given a wrong password now says "Incorrect email or password" instead of "Too many failed attempts"; with the right password it still says it is locked.

## 12. Remaining risks (need a decision or an action outside the code)

1. **S5 second factor:** set up a DLT-registered SMS provider (the `sms` branch in `deliverCode`), or add authenticator-app codes for staff. Do at least the director's account first.
2. **S6 Google key:**
   - Give the service account only Firestore User, Storage Object Admin on the one bucket, Secret Accessor on the one secret, and Firebase Auth Admin.
   - Rotate the key, and delete `~/portal-run-key.json` from the Mac once the server has its copy.
3. **S10 GitHub token:** revoke it on GitHub, then remove it from the remote URL (`git remote set-url origin https://github.com/infominergroup-develops/CA-Automation.git`) and sign in with `gh auth login`.
4. **S8 upload size:** choose a cap that fits the droplet's free disk, or accept the risk, since uploaders are known people.
5. **Test files in the bucket:** delete the 323 test files (permanent; waiting for your approval).
6. **Firebase console:** turn off public sign-up and phone sign-in if they aren't used. The portal doesn't use either.
7. **Backups:** Firestore has no scheduled export set up in this repo. Turn on Firestore PITR or scheduled exports, and object versioning or soft delete on the bucket. I couldn't verify these from here.
8. **Alerting:** nothing alerts on `document.integrity_failure`, repeated failed sign-ins, or the portal restarting.

## 13. Commands run and results

| Command | Result |
|---|---|
| `npm audit` | 15 vulnerabilities (2 critical, 4 high) |
| `npm audit fix` then `npm audit` | 6 moderate left (Google library internals) |
| `gitleaks git --redact .` | 34 commits, no leaks |
| `gitleaks dir --redact .` | 10 hits, all in git-ignored local files (`.env`, `data/`, `.test-data/`, `data-demo-backup/`) |
| `semgrep scan` with OWASP Top 10, TypeScript, Node.js, React, secrets, Dockerfile and nginx rules (155 rules, 96 files) | 5 findings (3 GCM tag length, 2 nginx `$host`); after fixes, 0 |
| `npx tsc --noEmit -p .` | Clean |
| `npx vite build` | Built |
| The 9 test suites (section 9) | 433 passed, 0 failed |
| `curl -sI` on the live site, `/api/auth/me`, HTTP redirect, `--tls-max 1.1` | Headers as in section 5; HTTPS redirect; OTP off; TLS 1.1 refused |
| OWASP ZAP | **Not run:** not installed, and an active scan of the live site needs your go-ahead |

## 14. Deployment recommendations

1. Commit these fixes and deploy with `bash scripts/deploy-droplet.sh 64.227.173.202 portal.infominervaluation.com`. The new nginx template goes live with the deploy.
2. Do items 1–3 of section 12 before inviting all clients.
3. Add the emulator logs to `.gitignore`.
4. Run `npm run test:ui` on the UI test stack before each release.
5. Plan the Tally move to Firestore, then remove the SQLite server.

## Scorecard

| Category | Status |
|---|---|
| Architecture | Pass (two parallel servers noted) |
| Code Quality | Pass |
| Maintainability | Pass (large components and the duplicate server noted) |
| Authentication | **Fail** until a second factor is on in production (S5) |
| Authorization | Pass |
| API Security | Pass |
| Database Security | Pass (backups not verified) |
| Frontend Security | Pass |
| Infrastructure Security | **Fail** until the shared Google key is narrowed or rotated (S6) |
| Performance | Pass |
| Testing | Pass (UI end-to-end tests not run) |
| Production Readiness | Not Verified: conditional on section 12, items 1–3 |
