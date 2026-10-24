#!/bin/bash
# Проверки интерфейса в настоящем браузере (Chromium через Playwright). Нужен: pip install playwright && playwright install chromium
# Запуск: bash test/e2e/run.sh   — поднимет тестовый сервер с демо-данными (test/devserver.mjs) и пройдёт сценарии.
cd "$(dirname "$0")/.." || exit 1
mkdir -p /tmp/kmbp-shots
node --no-warnings --import ./register.mjs devserver.mjs > /tmp/kmbp-dev.log 2>&1 &
PID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.5; curl -s -m 1 localhost:8099/healthz > /dev/null && break; done
RC=0
for f in e2e/vote_flow.py e2e/menu_draw_forum.py e2e/login_gate_admin.py; do
  echo "── $f"; kill $PID 2>/dev/null; wait $PID 2>/dev/null
  node --no-warnings --import ./register.mjs devserver.mjs > /tmp/kmbp-dev.log 2>&1 & PID=$!
  for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.5; curl -s -m 1 localhost:8099/healthz > /dev/null && break; done
  python3 "$f" || RC=1
done
kill $PID 2>/dev/null
echo "скриншоты: /tmp/kmbp-shots"; exit $RC
