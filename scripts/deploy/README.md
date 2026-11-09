# Silver Love — server deployment (Debian, systemd + Caddy)

Units for a fresh Debian 12/13 box (app on :3000, bot on :3002, Caddy :80 → :3000,
daily Telegram backup at 04:00).

1. Provision: bun, git, Caddy (see repo README).
2. `git clone` the repo to `/home/debian/silverlove`; put `.env` + `db/custom.db`.
3. `bun install && bunx prisma generate && bunx prisma db push && bun scripts/seed.ts`
4. `bun run build`
5. Copy `silverlove-*.service` → `/etc/systemd/system/`, Caddyfile → `/etc/caddy/Caddyfile`
   (fix perms: chmod 644), `systemctl daemon-reload`, `systemctl enable --now silverlove-app silverlove-bot caddy`
6. Backup: copy `silverlove-backup.{service,timer}` the same way and
   `systemctl enable --now silverlove-backup.timer`.
   First Telegram delivery requires: bot token in the panel + the owner
   (@amirhs_8311) messaging the bot once — the engine auto-captures the chat id.
