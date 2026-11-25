#!/usr/bin/env bash
# Deploys (or updates) the portal on a droplet that already runs nginx with other sites. Run it from your Mac:
#   bash scripts/deploy-droplet.sh DROPLET_IP              (address: https://portal.<ip-with-dashes>.sslip.io)
#   bash scripts/deploy-droplet.sh DROPLET_IP your.domain  (after pointing the domain at the droplet)
# Sends only committed code, and adds one nginx site without touching the others. The Google key goes from
# ~/portal-run-key.json the first time; later runs keep the copy on the server.
set -euo pipefail
cd "$(dirname "$0")/.."

IP="${1:?Usage: bash scripts/deploy-droplet.sh DROPLET_IP [domain]}"
[[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "\"$IP\" is not an IP address."; exit 1; }
DOMAIN="${2:-portal.${IP//./-}.sslip.io}"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ ]] || { echo "\"$DOMAIN\" is not a domain name."; exit 1; }
PROJECT_ID="infominer-dev-fdbfa"
KEY="${KEY:-$HOME/portal-run-key.json}"
remote() { ssh -o StrictHostKeyChecking=accept-new "root@$IP" "$@"; }

echo "== 1. Check the server before changing anything =="
remote 'fail() { echo "Stopped, nothing changed: $1"; exit 1; }
  docker compose version >/dev/null 2>&1 || fail "Docker Compose is not installed."
  command -v certbot >/dev/null && [ -d /var/www/certbot ] || fail "certbot or /var/www/certbot is missing."
  nginx -t >/dev/null 2>&1 || fail "the current nginx settings already have an error (run: nginx -t)."
  docker ps --format "{{.Names}} {{.Ports}}" | grep -q "^portal-app-1 .*:3001->" || [ -z "$(ss -Hltn "sport = :3001")" ] || fail "port 3001 is used by something else."
  mkdir -p /opt/portal && chmod 700 /opt/portal'

echo "== 2. Settings and Google key =="
printf '%s\n' "APP_ORIGIN=https://$DOMAIN" NODE_ENV=production PORT=3001 OTP_PROVIDER=off \
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

echo "== 4. Build and start (several minutes on a small droplet) =="
remote 'cd /opt/portal/app && docker compose build && docker compose up -d --remove-orphans && docker image prune -f >/dev/null
  for i in $(seq 1 30); do curl -fs --max-time 3 http://127.0.0.1:3001/healthz >/dev/null && exit 0; sleep 2; done
  echo "The portal did not start; nginx was not touched. Last log lines:"; docker compose logs --tail 25; exit 1'

echo "== 5. Add the site to nginx =="
# "zz-" sorts last, so the portal never becomes the default site for the server's bare address.
sed "s/DOMAIN/$DOMAIN/g" scripts/nginx-portal.conf | remote "set -e; D=$DOMAIN"'
  SITE=/etc/nginx/sites-available/zz-ca-portal; LINK=/etc/nginx/sites-enabled/zz-ca-portal; NEW=/opt/portal/nginx.new
  cat > $NEW; [ -f $SITE ] && cp $SITE /opt/portal/nginx.bak || rm -f /opt/portal/nginx.bak
  # Puts a file live only if nginx accepts it; otherwise restores what was there, and the other sites never notice.
  use() {
    cp "$1" $SITE; ln -sf $SITE $LINK
    if nginx -t >/opt/portal/nginx.log 2>&1; then systemctl reload nginx; return; fi
    if [ -f /opt/portal/nginx.bak ]; then cp /opt/portal/nginx.bak $SITE; else rm -f $SITE $LINK; fi
    echo "nginx refused the new site, so it was undone:"; cat /opt/portal/nginx.log; exit 1
  }
  if [ ! -f /etc/letsencrypt/live/$D/fullchain.pem ]; then
    sed "/^# --- https/,\$d" $NEW > /opt/portal/nginx.http; use /opt/portal/nginx.http
    certbot certonly --webroot -w /var/www/certbot -d $D --non-interactive --keep-until-expiring --deploy-hook "systemctl reload nginx"
  fi
  use $NEW'

echo "== 6. Check https://$DOMAIN =="
for _ in $(seq 1 "${TRIES:-12}"); do
  if curl -fsS --max-time 5 "https://$DOMAIN/healthz" 2>/dev/null | grep -q firestore; then
    echo "Live: https://$DOMAIN"; exit 0
  fi
  sleep 5
done
echo "Not answering from outside yet. Last log lines:"
remote 'cd /opt/portal/app && docker compose logs --tail 25'
exit 1
