#!/bin/sh
# ================================================================
# entrypoint.sh — chạy backend + frontend trong 1 container.
#
# - backend : Fastify API + RTDB queue consumer, lắng nghe cổng nội bộ
#             CRONJOB_MANAGER_BACKEND_PORT (mặc định 8080), phục vụ
#             localhost trong container.
# - frontend: Next.js, lắng nghe PORT (= APP_PORT compose inject, mặc định
#             3000) — đây là cổng public sau Tinyauth.
# - Frontend proxy tới backend qua BACKEND_URL=http://127.0.0.1:${BACKEND_PORT}.
#
# NAMESPACE: mọi biến cấu hình của app dùng tiền tố CRONJOB_MANAGER_ để không
# đụng với biến của docker-stack-template. PORT và BACKEND_URL là biến
# runtime/nội bộ (entrypoint tự set), nên KHÔNG mang tiền tố.
#
# Nếu backend hoặc frontend chết → container thoát để Docker restart (fail-fast).
# ================================================================
set -e

BACKEND_PORT="${CRONJOB_MANAGER_BACKEND_PORT:-8080}"
FRONT_PORT="${PORT:-3000}"

: "${CRONJOB_MANAGER_API_SECRET:?CRONJOB_MANAGER_API_SECRET is required}"
export CRONJOB_MANAGER_API_SECRET
export BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"

echo "[entrypoint] starting backend on 127.0.0.1:${BACKEND_PORT} ..."
(
  cd /app/backend
  PORT="${BACKEND_PORT}" \
  CRONJOB_MANAGER_EXEC_HANDLERS_DIR="${CRONJOB_MANAGER_EXEC_HANDLERS_DIR:-/app/backend/handlers}" \
  node dist/index.js
) &
BACKEND_PID=$!

echo "[entrypoint] starting frontend (Next.js) on 0.0.0.0:${FRONT_PORT} ..."
(
  cd /app/frontend
  PORT="${FRONT_PORT}" \
  BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}" \
  node_modules/.bin/next start -p "${FRONT_PORT}" -H 0.0.0.0
) &
FRONT_PID=$!

term() {
  echo "[entrypoint] shutting down ..."
  kill -TERM "$BACKEND_PID" "$FRONT_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  wait "$FRONT_PID" 2>/dev/null || true
  exit 0
}
trap term TERM INT

# Poll: nếu 1 trong 2 tiến trình biến mất → dừng container (fail-fast).
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONT_PID" 2>/dev/null; do
  sleep 3
done

echo "[entrypoint] a child process exited — stopping container."
kill -TERM "$BACKEND_PID" "$FRONT_PID" 2>/dev/null || true
exit 1
