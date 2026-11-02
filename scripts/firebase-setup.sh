#!/usr/bin/env bash
# One-time setup of the Firebase / Google Cloud backend for the Infominer portal.
# You run this (Claude cannot sign in to your Google account). It is safe to run step by step —
# read each section, then run it. Everything is created in the Mumbai region for DPDP residency.
#
# Prerequisites (install once):
#   - Google Cloud CLI:  https://cloud.google.com/sdk/docs/install   then:  gcloud auth login
#   - Firebase CLI:      npm i -g firebase-tools                     then:  firebase login
#   - A Google Cloud billing account id (gcloud billing accounts list)
#
# Fill these in:
PROJECT_ID="infominer-dev-fdbfa"          # must be globally unique; lowercase, digits, hyphens
REGION="asia-south1"                    # Mumbai — keep client data in India
BILLING_ACCOUNT="0194A7-9C5A58-BCE88E"  # from: gcloud billing accounts list
DOCS_BUCKET="${PROJECT_ID}-documents"   # Cloud Storage bucket for encrypted document files
RUN_SA="portal-run"                     # service account the server runs as (least privilege)

set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. Create the project (skip if it already exists) =="
gcloud projects create "$PROJECT_ID" --name="Infominer Portal" || true
gcloud config set project "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"

echo "== 2. Enable the APIs we use =="
gcloud services enable firestore.googleapis.com secretmanager.googleapis.com \
  run.googleapis.com storage.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

echo "== 3. Create the Firestore database (Native mode, Mumbai) =="
gcloud firestore databases create --location="$REGION" --type=firestore-native || true   # skip if already exists
echo "   Waiting 10 s for DB to finish provisioning..."
sleep 10
gcloud firestore databases update --enable-pitr || true           # point-in-time recovery (backups, best-effort)
gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14d || true

echo "== 4. Deploy the security rules (deny all client access) and indexes =="
# Point .firebaserc at this project first (replace YOUR_FIREBASE_PROJECT_ID), or pass --project below.
firebase deploy --only firestore:rules,firestore:indexes --project "$PROJECT_ID"

echo "== 5. Create the encrypted-documents bucket (private, uniform access) =="
gcloud storage buckets create "gs://${DOCS_BUCKET}" --location="$REGION" --uniform-bucket-level-access --public-access-prevention

echo "== 6. Generate the app's keys and store them in Secret Manager =="
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
OTP_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
printf '{"MASTER_KEY":"%s","OTP_SECRET":"%s"}' "$MASTER_KEY" "$OTP_SECRET" \
  | gcloud secrets create infominer-secrets --data-file=- --replication-policy=automatic
echo "   >>> Back up MASTER_KEY offline now. If it is lost, every stored document is unrecoverable."

echo "== 7. Create the least-privilege service account the server runs as =="
gcloud iam service-accounts create "$RUN_SA" --display-name="Infominer portal (Cloud Run)"
SA_EMAIL="${RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor"
gcloud storage buckets add-iam-policy-binding "gs://${DOCS_BUCKET}" --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectAdmin"

cat <<DONE

== Done. The database and keys exist in your Firebase project. ==

To run the app locally against the REAL Firestore (no emulator):
  gcloud auth application-default login          # one-time: lets your machine use Firestore
  export GOOGLE_CLOUD_PROJECT=${PROJECT_ID}
  export DOCS_BUCKET=${DOCS_BUCKET}
  export INFOMINER_SECRETS_ID=projects/${PROJECT_ID}/secrets/infominer-secrets
  unset FIRESTORE_EMULATOR_HOST
  npm run seed:fs                                # create your first Director (once it's wired)
  npm run start:fs

Deploying to Cloud Run (run as ${SA_EMAIL}, with INFOMINER_SECRETS_ID + GOOGLE_CLOUD_PROJECT + DOCS_BUCKET
set) comes after the remaining routes are wired. See server/firestore/SECURITY.md for the full notes.
DONE
