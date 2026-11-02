# Firestore data model

The app was built on SQLite (relational). Firestore is document-based, so this maps the tables to
collections and records the design decisions that replace what the database used to enforce for us.
Dates stay ISO-8601 strings (they sort correctly and all existing date logic keeps working).

## Collections (top-level, document id = entity id)

| Collection | From table | Key queries | Notes |
|---|---|---|---|
| `users` | users | by email, mobile (login); by role; by client_group_id | password_hash, status, lockout fields |
| `unique_user_email` / `unique_user_mobile` | — | — | uniqueness lookups (see below) |
| `client_groups` | client_groups | — | |
| `companies` | companies | by group_id, manager_id, gstin | |
| `document_categories` | document_categories | all active | small, seeded |
| `documents` | documents | by company_id+category_id+fy; by company_id+sha256 (dup) | file bytes in Cloud Storage; metadata here |
| `tasks` | tasks | by assignee+status, reviewer+status, company+status | composite indexes |
| `tasks/{id}/events` | task_events | by task ordered by created_at | subcollection |
| `access_grants` | access_grants | by employee+company+status; by status; by task | category_ids is an array |
| `time_entries` | time_entries | by user+started_at; running (ended_at missing) per user | one-running-timer via uniqueness |
| `sessions` | sessions | doc id = token hash; cleanup by expires_at | |
| `login_challenges` | login_challenges | by id; cleanup by expires_at | |
| `audit_log` | audit_log | by action prefix; ordered by seq | append-only hash chain (see below) |
| `counters/audit` | (sqlite AUTOINCREMENT) | — | transactional sequence for audit seq |
| `consents`, `dpdp_requests`, `breach_register` | same | by user_id; by status | |
| `settings` | settings | doc id = key | |
| `tally_agents`, `tally_companies`, `sync_requests`, `report_settings` | same | various | report_settings id = `${companyId}__${fy}` |
| `tally_snapshots` | tally_snapshots | by company_id+fy ordered by synced_at | |
| `tally_data/{companyId__fy}` | groups + ledgers + stock + monthEnds | one read | holds groups[], ledgers[], monthEnds[], stock[] (fits < 1 MB) |
| `tally_data/{companyId__fy}/balances/{monthEnd}` | tally_balances | one read per month-end | `{ closing: { ledgerName: number } }` map |
| `tally_data/{companyId__fy}/vouchers/{guid}` | tally_vouchers (+entries embedded) | by date range | entries stored as an array on the voucher |
| `tally_data/{companyId__fy}/ledger_entries/{id}` | tally_entries | by ledger + date range | denormalised for ledger statements (composite index) |

## Replacing what SQLite enforced

- **Uniqueness** (email, mobile, one running timer per user): Firestore has no UNIQUE constraint. We write a
  lookup document (`unique_user_email/{email}` → `{ ownerId }`) inside the same transaction as the entity,
  via `reserveUnique` / `releaseUnique` in `store.ts`. A duplicate is rejected atomically.
- **Foreign keys / CHECK**: enforced in app code (zod validation on input, explicit existence checks).
- **Transactions**: `txn()` wraps `runTransaction`. Firestore requires all reads before any writes.
- **Audit log append-only**: `audit_log` has no auto-increment, so `counters/audit` is incremented inside a
  transaction to assign `seq`, reading the previous entry's hash in the same transaction to keep the hash
  chain intact. The chain is what makes tampering detectable. Security rules (`firestore.rules`) deny all
  direct client access and lock `audit_log` to create-only as defence in depth; the Admin SDK on the server
  bypasses rules, so server code must only ever append — never update or delete — audit entries.

## Why the Tally data is denormalised

Balance Sheet / P&L / Trial Balance read `tally_data/{companyId__fy}` (groups, ledgers) plus the relevant
`balances/{monthEnd}` documents — a handful of reads, not thousands. Only the ledger statement drills into
individual entries, which is why `ledger_entries` carries `ledger` + `date` for a composite-index query.
This keeps the common reports cheap despite Firestore billing per document read.
