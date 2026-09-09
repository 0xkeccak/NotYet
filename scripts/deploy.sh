#!/usr/bin/env bash
# Deploy Notyet to Railway (project "notyet", workspace "ETHOnline 2026").
#
# Railway's FREE tier pins builds to the sfo build region, which is unavailable
# during PT peak hours (8 AM – 8 PM America/Los_Angeles ≈ 8:30 PM – 8:30 AM IST).
# Outside that window a single `railway up` just works. This script retries
# through the window so you can fire-and-forget: it attempts a deploy, and if it
# is turned away for peak hours it waits and tries again, then prints the URL.
#
# Prereqs (already done once): railway login; project/service linked in this dir;
# env vars set on the service. Just run:  bash scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE="notyet"
INTERVAL="${RETRY_INTERVAL:-600}"   # seconds between retries while peak-blocked

echo "→ deploying $SERVICE to Railway (retries every ${INTERVAL}s if peak-blocked)…"
while true; do
  out="$(railway up --service "$SERVICE" --detach 2>&1)" && ok=1 || ok=0
  echo "$out"
  if [ "$ok" = 1 ] && ! echo "$out" | grep -qi "not available during peak"; then
    echo "✓ build uploaded"
    break
  fi
  if echo "$out" | grep -qi "not available during peak"; then
    echo "… free-tier peak window (sfo). retrying in ${INTERVAL}s. Ctrl-C to stop."
    sleep "$INTERVAL"
  else
    echo "✗ deploy failed for a reason other than peak hours — see output above."
    exit 1
  fi
done

echo "→ ensuring a public domain…"
railway domain --service "$SERVICE" 2>&1 || true
echo "✓ done. Check status: railway status ; logs: railway logs --service $SERVICE"
