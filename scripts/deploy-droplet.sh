#!/usr/bin/env bash
# Deploys (or updates) the portal on a DigitalOcean droplet. Run it yourself, from your Mac:
#   bash scripts/deploy-droplet.sh DROPLET_IP              (address: https://<ip-with-dashes>.sslip.io)
#   bash scripts/deploy-droplet.sh DROPLET_IP your.domain  (after pointing the domain at the droplet)
# Sends only committed code. The Google key goes from ~/portal-run-key.json to the server the first time; after
# that the file can be deleted from the Mac and later runs keep the copy already on the server.
set -euo pipefail
cd "$(dirname "$0")/.."

IP="${1:?Usage: bash scripts/deploy-droplet.sh DROPLET_IP [domain]}"
[[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "\"$IP\" is not an IP address."; exit 1; }
DOMAIN="${2:-${IP//./-}.sslip.io}"
PROJECT_ID="infominer-dev-fdbfa"
KEY="${KEY:-$HOME/portal-run-key.json}"
remote() { ssh -o StrictHostKeyChecking=accept-new "root@$IP" "$@"; }

echo "== 1. Prepare the server =="
# Before changing anything: the web ports must be free, or already held by this portal.
TAKEN=$(remote 'docker ps --format "{{.Names}}" 2>/dev/null | grep -qx portal-caddy-1 || ss -Hltnp "( sport = :80 or sport = :443 )"')
[ -z "$TAKEN" ] || { printf 'Stopped, nothing changed: something else on this server already uses the web ports:\n%s\n' "$TAKEN"; exit 1; }
# Rules only matter if a firewall is already on; switching one on could cut off other services on the server.
remote 'set -e; export DEBIAN_FRONTEND=noninteractive
  docker compose version >/dev/null 2>&1 || { apt-get update -q && apt-get install -y -q docker.io docker-compose-v2; }
  if command -v ufw >/dev/null; then ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null; fi
  mkdir -p /opt/portal && chmod 700 /opt/portal'

echo "== 2. Settings and Google key =="
printf '%s\n' "DOMAIN=$DOMAIN" "APP_ORIGIN=https://$DOMAIN" NODE_ENV=production PORT=3001 OTP_PROVIDER=off \
  "GOOGLE_CLOUD_PROJECT=$PROJECT_ID" "DOCS_BUCKET=$PROJECT_ID-documents" \
  "INFOMINER_SECRETS_ID=projects/$PROJECT_ID/secrets/infominer-secrets" \
  | remote 'umask 077; cat > /opt/portal/.env'
if [ -f "$KEY" ]; then
  # Over stdin, so the key never appears in a command line or in the output.
  { printf 'GOOGLE_CREDENTIALS_BASE64='; base64 < "$KEY" | tr -d '\n'; echo; } | remote 'umask 077; cat > /opt/portal/key.env'
else
  remote 'test -s /opt/portal/key.env' || { echo "No Google key: $KEY is missing here and the server has none."; exit 1; }
fi

echo "== 3. Send the code ($(git log -1 --format='%h %s')) =="
git archive HEAD | remote 'set -e; rm -rf /opt/portal/new; mkdir /opt/portal/new; tar -x -C /opt/portal/new
  rm -rf /opt/portal/app; mv /opt/portal/new /opt/portal/app'

echo "== 4. Build and start (the first time takes a few minutes) =="
remote 'cd /opt/portal/app && docker compose --env-file ../.env up -d --build --remove-orphans'

echo "== 5. Wait for https://$DOMAIN =="
for _ in $(seq 1 "${TRIES:-36}"); do
  if curl -fsS --max-time 5 "https://$DOMAIN/healthz" 2>/dev/null | grep -q firestore; then
    echo "Live: https://$DOMAIN"; exit 0
  fi
  sleep 5
done
echo "Not answering yet. Last log lines:"
remote 'cd /opt/portal/app && docker compose --env-file ../.env logs --tail 25'
exit 1
