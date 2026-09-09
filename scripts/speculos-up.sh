#!/usr/bin/env bash
# Boot the Ledger Ethereum app in the Speculos emulator (no hardware needed).
# Downloads the app ELF once, then runs Speculos headless with the API on :5111.
set -euo pipefail
cd "$(dirname "$0")/.."

ELF=".speculos/app-1.22.3-nanox.elf"
if [ ! -f "$ELF" ]; then
  mkdir -p .speculos
  gh release download 1.22.3 --repo LedgerHQ/app-ethereum --pattern "app-1.22.3-nanox.elf" --dir .speculos --clobber
fi

SEED="glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin"

docker rm -f speculos >/dev/null 2>&1 || true
docker run -d --name speculos \
  -v "$(pwd)/.speculos:/app" \
  -p 5111:5000 -p 9998:9999 \
  ghcr.io/ledgerhq/speculos:latest \
  --model nanox --display headless --api-port 5000 --apdu-port 9999 \
  --seed "$SEED" \
  /app/app-1.22.3-nanox.elf >/dev/null

echo -n "waiting for Speculos API on :5111 "
for i in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' localhost:5111/ 2>/dev/null)" = "200" ]; then
    echo "— up"; exit 0
  fi
  echo -n "."; sleep 1
done
echo " — timed out"; docker logs speculos 2>&1 | tail -10; exit 1
