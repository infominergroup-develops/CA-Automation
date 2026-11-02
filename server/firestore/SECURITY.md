# Database: privacy & security setup (Firestore)

How the Firestore database is locked down, and the steps to create it in Google Cloud with the privacy and
security the app requires (DPDP Act, 2023; ICAI confidentiality).

## Guarantees built into the data layer

| Concern | How it's handled | Where |
|---|---|---|
| No browser ever touches the DB | All access is through the Express API using the Admin SDK. `firestore.rules` denies **every** client read/write. The Firestore client SDK is never shipped to the browser. | `firestore.rules` |
| Uniqueness (email, mobile, one running timer) | Lookup documents reserved inside the same transaction as the entity — a duplicate is rejected atomically, with no partial write. | `store.ts`, `users.ts` |
| Passwords | scrypt hashes only; the plaintext is never stored. | `security/crypto.ts` |
| Sign-in codes | Only an HMAC of the code is stored; single-use; expire in 5 min; lock after 5 wrong tries; unknown identifiers still get a challenge (no account enumeration). | `challenges.ts` |
| Sessions | The 256-bit token lives only in the user's `__Host-` httpOnly, SameSite=Strict cookie. The DB stores `sha256(token)`, so a DB leak can't impersonate anyone. Idle + absolute timeouts. | `sessions.ts` |
| Tamper-evident audit log | Append-only, hash-chained via a transactional counter; `verifyAuditChain()` re-computes the chain and reports the first altered entry. Rules lock `audit_log` to create-only; server code only ever appends. | `audit.ts`, `firestore.rules` |
| Consent (DPDP) | Clients must hold consent for the current notice version before processing; every give/withdraw recorded, never deleted. | `consents.ts` |
| Document files | Not in Firestore. Stored in Cloud Storage, each file encrypted by the app (AES-256-GCM envelope, per-file key wrapped with the master key) and fingerprinted (SHA-256) — same scheme as the SQLite build. | (documents slice) |

## Create the database in Google Cloud (one-time)

Run as a project owner. Replace `PROJECT` with your project id.

```bash
# 1. Firestore in Native mode, in Mumbai — keeps client data in India (DPDP residency).
gcloud firestore databases create --location=asia-south1 --type=firestore-native --project=PROJECT

# 2. Lock down access and declare indexes (from this folder's firestore.rules / firestore.indexes.json).
firebase deploy --only firestore:rules,firestore:indexes --project PROJECT

# 3. Encryption at rest: Google-managed keys are on by default. For customer-managed keys (CMEK),
#    create a KMS key in asia-south1 and set it as the database's encryption key.
#    (gcloud firestore databases update --kms-key-name=… once CMEK is enabled for your org.)

# 4. Backups: turn on Point-in-Time Recovery and a daily backup schedule.
gcloud firestore databases update --enable-pitr --project=PROJECT
gcloud firestore backups schedules create --database='(default)' \
  --recurrence=daily --retention=14d --project=PROJECT   # keep long-term exports in a bucket for 8-yr records
```

## Least-privilege service identity

- Cloud Run runs as a dedicated service account, **not** the default. Grant it only `roles/datastore.user`
  (read/write data — never `datastore.owner`), `roles/secretmanager.secretAccessor`, and object
  read/write on the one documents bucket. No human uses this account.
- Keys (`MASTER_KEY`, `OTP_SECRET`, SMS creds) live in **Secret Manager**, injected at boot — never in the
  image or the database.

## Backups & retention

- **PITR** (above) covers accidental deletes/corruption for the recent window.
- **Daily scheduled backups** for operational restore.
- **Long-term**: export to a Cloud Storage bucket (SSE, lifecycle to Archive) to meet the 8-year retention
  for tax/audit records. The bucket is private, uniform access, no public objects.

## Verifying integrity

The Director's **Audit trail → Verify integrity** button calls `verifyAuditChain()`. Record the reported
head hash outside the system periodically (e.g. email it weekly) to prove later that history was not
rewritten — the same practice as the SQLite build.
