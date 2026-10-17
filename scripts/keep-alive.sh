#!/usr/bin/env bash
# Keeps the Daypass demo alive during judging.
#
# Safe to restart: the SERVER (same tunnel URL, plugin stays registered).
# Unsafe to restart: cloudflared — a fresh trycloudflare URL means the registered plugin_id is
#   pointing at nothing and re-registration needs a fresh X-MoonX-Access-Token from a human.
#   So a dead tunnel is only reported loudly, never "fixed" automatically.
#
# Usage: setsid ./scripts/keep-alive.sh </dev/null >/tmp/opencode/keep-alive.log 2>&1 &
set -u

PROJECT="/home/lucky-israel/Desktop/Projects/PayBoxHackathon"
TUNNEL_URL_FILE="/tmp/opencode/tunnel-url.txt"
CHECK_SECONDS="${CHECK_SECONDS:-60}"
MERCHANT_ADDRESS="${MERCHANT_ADDRESS:-0x441035c24111a37c19e092cf13ae59d38d02985e}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

server_port_pid() {
  ss -ltnp 2>/dev/null | grep ':8787' | grep -o -E 'pid=[0-9]+' | head -1 | cut -d= -f2
}

start_server() {
  cd "$PROJECT" || return 1
  setsid env PUBLIC_URL="$TUNNEL_URL" MERCHANT_ADDRESS="$MERCHANT_ADDRESS" \
    npx tsx src/plugin/server.ts >/tmp/opencode/daypass.log 2>&1 </dev/null &
  for _ in $(seq 1 30); do
    curl -s --max-time 2 http://localhost:8787/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

TUNNEL_URL="$(cat "$TUNNEL_URL_FILE" 2>/dev/null || true)"
log "watchdog started · tunnel=${TUNNEL_URL:-UNKNOWN} · every ${CHECK_SECONDS}s"

while true; do
  if ! curl -s --max-time 10 "$TUNNEL_URL/health" >/dev/null 2>&1; then
    log "🔴 TUNNEL DEAD — a fresh trycloudflare URL invalidates the registered plugin."
    log "   Human action needed: restart cloudflared, then DELETE+POST /connections with the"
    log "   new URL (the plugin_id changes). A fresh X-MoonX-Access-Token is required."
  fi

  if ! curl -s --max-time 5 http://localhost:8787/health >/dev/null 2>&1; then
    log "🟡 server down — restarting (tunnel URL unchanged, plugin stays registered)"
    if start_server; then log "🟢 server back up"; else log "🔴 server failed to come back"; fi
  fi

  sleep "$CHECK_SECONDS"
done
