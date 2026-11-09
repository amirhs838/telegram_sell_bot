#!/usr/bin/env bash
# Silver Love — daily full backup → Telegram.
#
# Packs the ENTIRE project directory (source, database, .env secrets, media)
# into one tarball and sends it to the store owner's Telegram chat.
# Regenerable artifacts (node_modules/.next/.git) are excluded.
#
# Source of truth: the Setting table (same DB the panel/bot use):
#   telegramBotToken     → the sales bot token (sendDocument via this bot)
#   telegramAdminChatId  → the owner's chat id (auto-captured by the bot engine
#                          the first time the owner messages the bot)
#
# Install (server): see scripts/deploy — systemd units silverlove-backup.{service,timer}
set -uo pipefail

ROOT="${ROOT:-/home/debian/silverlove}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
OUT_DIR="${OUT_DIR:-/var/backups/silverlove}"
KEEP_LOCAL="${KEEP_LOCAL:-14}"
MAX_TG_BYTES=$((49 * 1024 * 1024)) # Telegram sendDocument hard limit: 50MB

TS=$(date +%Y%m%d-%H%M%S)
STAMP=$(date '+%Y-%m-%d %H:%M')
TARBALL="$OUT_DIR/silverlove-$TS.tar.gz"
STATE="$OUT_DIR/last-backup.status"

mkdir -p "$OUT_DIR"

log() { echo "[backup $TS] $*"; }

finish() {
  # local retention: keep the newest KEEP_LOCAL tarballs, drop the rest
  ls -1t "$OUT_DIR"/silverlove-*.tar.gz 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f
  rm -f "$TARBALL".part.* 2>/dev/null || true
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" > "$STATE"
}
trap 'finish "incomplete"' ERR

# ─── 1. flush the SQLite WAL so custom.db in the tarball is complete ─────────
if [ -f "$ROOT/db/custom.db" ]; then
  (cd "$ROOT" && "$BUN" -e '
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
await db.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)")
await db.$disconnect()
' >/dev/null 2>&1) || log "WARN: WAL checkpoint failed — tarball continues anyway"
fi

# ─── 2. pack the whole project (everything except regenerable artifacts) ─────
BASE_DIR=$(dirname "$ROOT")
PROJ=$(basename "$ROOT")
tar czf "$TARBALL" \
  --exclude="$PROJ/node_modules" \
  --exclude="$PROJ/.next" \
  --exclude="$PROJ/.git" \
  --exclude="$PROJ/server.log" \
  --exclude="$PROJ/dev.log" \
  --exclude="$PROJ/mini-services/bot-service/.bot-lock" \
  -C "$BASE_DIR" "$PROJ" 2>/dev/null
SIZE=$(stat -c%s "$TARBALL" 2>/dev/null || echo 0)
if [ "$SIZE" -eq 0 ]; then
  log "ERROR: tarball is empty — aborting"
  finish "failed:empty-tarball"
  exit 1
fi
log "tarball ready: $TARBALL ($SIZE bytes)"

# ─── 3. credentials from the DB (single source of truth) ─────────────────────
read_db() {
  (cd "$ROOT" && "$BUN" -e '
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const key = process.argv[2]
const r = await db.setting.findUnique({ where: { key } })
process.stdout.write(r?.value?.trim() || "")
await db.$disconnect()
' "$1" 2>/dev/null)
}
TOKEN="$(read_db telegramBotToken)"
CHAT="$(read_db telegramAdminChatId)"

if [ -z "$TOKEN" ]; then
  log "no bot token in settings yet → local backup only (Telegram upload skipped)"
  finish "local-only:no-token"
  exit 0
fi
if [ -z "$CHAT" ]; then
  log "owner chat id unknown yet (owner must message the bot once) → local backup only"
  finish "local-only:no-chat"
  exit 0
fi

# ─── 4. upload to Telegram (single file, or split parts if > ~49MB) ──────────
send_doc() { # $1 = file, $2 = caption
  curl -s --max-time 180 \
    -F chat_id="$CHAT" \
    -F caption="$2" \
    -F document=@"$1" \
    "https://api.telegram.org/bot$TOKEN/sendDocument" 2>/dev/null
}

if [ "$SIZE" -le "$MAX_TG_BYTES" ]; then
  RESP=$(send_doc "$TARBALL" "💾 Silver Love backup — $STAMP | حجم: $(du -h "$TARBALL" | cut -f1)")
  if echo "$RESP" | grep -q '"ok":true'; then
    log "telegram: sent OK → chat $CHAT"
    finish "sent:$TARBALL"
    exit 0
  fi
  log "telegram: single upload failed — $RESP"
else
  log "tarball exceeds 49MB → split upload"
fi

# fallback path (oversized or failed single upload): split into 48MB parts
split -b 48M -d "$TARBALL" "$TARBALL.part."
PARTS=$(ls -1 "$TARBALL".part.* 2>/dev/null | wc -l)
log "sending $PARTS part(s)"
OK=0
N=0
for f in "$TARBALL".part.*; do
  N=$((N + 1))
  RESP=$(send_doc "$f" "💾 Silver Love backup — $STAMP | بخش $N از $PARTS")
  if echo "$RESP" | grep -q '"ok":true'; then OK=$((OK + 1)); else log "part $N failed — $RESP"; fi
  rm -f "$f"
done
log "telegram: $OK/$PARTS parts sent → chat $CHAT"
if [ "$OK" -eq "$PARTS" ] && [ "$PARTS" -gt 0 ]; then
  finish "sent:$PARTS-parts"
  exit 0
fi
finish "failed:telegram"
exit 1
