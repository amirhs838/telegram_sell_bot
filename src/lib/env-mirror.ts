/**
 * .env mirroring — wipe resilience for the Telegram connection.
 *
 * The sandbox boot can recreate .env with a bare DATABASE_URL and the DB can
 * be recreated empty; the bot token previously lived ONLY in the Setting
 * table, so one wipe logged the bot out forever. By mirroring the panel-saved
 * connection into .env (and the /tmp project snapshot copy when present), the
 * token survives a DB wipe (env fallback in bot-service/telegram.ts) and even
 * a partial home restore (snapshot copy). Never throws — mirroring is
 * best-effort and must never break the panel save flow.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ENV_PATH = path.join(process.cwd(), '.env')
/** The environment-level snapshot copy (survives home-dir restores). */
const ENV_SNAPSHOT_PATH = '/tmp/my-project/.env'

export type TelegramEnvMirror = {
  botToken: string
  channelId: string
  adminChatId: string
  botUsername: string
}

function upsertEnvLines(content: string, updates: Array<[string, string]>): string {
  let out = content
  for (const [key, value] of updates) {
    const line = `${key}=${value}`
    const re = new RegExp(`^${key}=.*$`, 'm')
    if (re.test(out)) out = out.replace(re, line)
    else out += (out.endsWith('\n') || out.length === 0 ? '' : '\n') + line + '\n'
  }
  return out
}

/** Write the telegram connection into .env (+ snapshot copy). Best-effort. */
export function mirrorTelegramToEnv(cfg: TelegramEnvMirror): void {
  // TELEGRAM_MOCK=false is deliberate: with a token present in env the bot
  // must go real even if the Setting table is gone (env fallback semantics).
  const updates: Array<[string, string]> = [
    ['TELEGRAM_BOT_TOKEN', cfg.botToken],
    ['TELEGRAM_CHANNEL_ID', cfg.channelId],
    ['TELEGRAM_ADMIN_CHAT_ID', cfg.adminChatId],
    ['TELEGRAM_BOT_USERNAME', cfg.botUsername],
    ['TELEGRAM_MOCK', 'false'],
  ]
  for (const p of [ENV_PATH, ENV_SNAPSHOT_PATH]) {
    try {
      if (!existsSync(p)) continue
      writeFileSync(p, upsertEnvLines(readFileSync(p, 'utf8'), updates))
    } catch {
      // single file failing (e.g. root-owned) must not abort the other
    }
  }
}

function removeEnvLines(content: string, keys: string[]): string {
  let out = content
  for (const key of keys) {
    const re = new RegExp(`^${key}=.*(?:\\r?\\n|$)`, 'gm')
    out = out.replace(re, '')
  }
  return out
}

/**
 * Erase a platform's mirrored connection from .env (+ snapshot copy).
 * Called on panel DISCONNECT: without this, the deleted token would
 * resurrect on the next process restart (systemd env / Next.js dev reload)
 * and silently reconnect a bot the seller just disconnected. Best-effort.
 */
export function unmirrorPlatformFromEnv(platform: 'telegram' | 'bale'): void {
  const keys =
    platform === 'telegram'
      ? ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID', 'TELEGRAM_ADMIN_CHAT_ID', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_MOCK']
      : ['BALE_BOT_TOKEN', 'BALE_CHANNEL_ID', 'BALE_ADMIN_CHAT_ID', 'BALE_BOT_USERNAME', 'BALE_MOCK']
  for (const p of [ENV_PATH, ENV_SNAPSHOT_PATH]) {
    try {
      if (!existsSync(p)) continue
      writeFileSync(p, removeEnvLines(readFileSync(p, 'utf8'), keys))
    } catch {
      // best-effort — never break the disconnect flow
    }
  }
}

/** Same shape as the Telegram mirror — the keys are just BALE_*-prefixed. */
export type BaleEnvMirror = {
  botToken: string
  channelId: string
  adminChatId: string
  botUsername: string
}

/** Write the bale connection into .env (+ snapshot copy). Best-effort. */
export function mirrorBaleToEnv(cfg: BaleEnvMirror): void {
  const updates: Array<[string, string]> = [
    ['BALE_BOT_TOKEN', cfg.botToken],
    ['BALE_CHANNEL_ID', cfg.channelId],
    ['BALE_ADMIN_CHAT_ID', cfg.adminChatId],
    ['BALE_BOT_USERNAME', cfg.botUsername],
    ['BALE_MOCK', 'false'],
  ]
  for (const p of [ENV_PATH, ENV_SNAPSHOT_PATH]) {
    try {
      if (!existsSync(p)) continue
      writeFileSync(p, upsertEnvLines(readFileSync(p, 'utf8'), updates))
    } catch {
      // single file failing (e.g. root-owned) must not abort the other
    }
  }
}
