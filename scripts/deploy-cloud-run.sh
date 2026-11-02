#!/usr/bin/env bash
# Builds and deploys the portal (Firestore + Cloud Storage) to Cloud Run in Mumbai.
# Run from your Mac after scripts/firebase-setup.sh has created the project, bucket, secret and service account.
#   bash scripts/deploy-cloud-run.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="infominer-dev-fdbfa"
REGION="asia-south1"
SERVICE="infominer-portal"
RUN_SA="portal-run@${PROJECT_ID}.iam.gserviceaccount.com"
DOCS_BUCKET="${PROJECT_ID}-documents"
SECRETS_ID="projects/${PROJECT_ID}/secrets/infominer-secrets"
# Cloud Run's address is fixed by service name and project number, so it is known before the first deploy.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
APP_ORIGIN="${APP_ORIGIN:-https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app}"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" --source . \
  --service-account "$RUN_SA" \
  --allow-unauthenticated \
  --memory 1Gi --max-instances 3 \
  --set-env-vars "NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},DOCS_BUCKET=${DOCS_BUCKET},INFOMINER_SECRETS_ID=${SECRETS_ID},OTP_PROVIDER=off,APP_ORIGIN=${APP_ORIGIN}"

echo
echo "Deployed: ${APP_ORIGIN}"
curl -fsS "${APP_ORIGIN}/healthz" && echo
