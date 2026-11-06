/**
 * bot-service — receipt image handling (Silver Love manual payment flow).
 *
 * Receipts are stored OUTSIDE the public upload folder (upload/receipts/) and
 * are served only through the authorized panel API — never via public URLs.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { callTelegramApi, isMockMode, loadConfig } from './telegram'

/** 1×1 transparent PNG — used as a placeholder in simulation mode. */
const PLACEHOLDER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function projectRootCandidates(): string[] {
  return [
    path.resolve(process.cwd(), '..', '..'),
    path.resolve(process.cwd(), '..'),
    process.cwd(),
  ]
}

/** upload/receipts directory shared with the Next.js panel API. */
export function receiptsDir(): string {
  const dirs = projectRootCandidates().map((root) => path.join(root, 'upload', 'receipts'))
  for (const dir of dirs) {
    try {
      if (fsSync.existsSync(dir)) return dir
    } catch {
      // ignore
    }
  }
  return dirs[0]
}

/**
 * Persist an incoming receipt photo.
 *  - real mode + fileId → download via getFile and store the actual image
 *  - simulation (name provided) → store a tiny placeholder so the whole flow
 *    is testable from the panel simulator
 * Returns the stored filename (basename only) or null on failure.
 */
export async function saveIncomingReceipt(
  photo?: { fileId?: string; name?: string },
): Promise<string | null> {
  try {
    const dir = receiptsDir()
    await fs.mkdir(dir, { recursive: true })
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`

    if (photo?.fileId && !isMockMode()) {
      await loadConfig()
      const info = await callTelegramApi('getFile', { file_id: photo.fileId })
      const filePath =
        info.ok && info.result && typeof (info.result as { file_path?: unknown }).file_path === 'string'
          ? (info.result as { file_path: string }).file_path
          : null
      if (!filePath) return null
      const cfg = await loadConfig()
      if (!cfg.botToken) return null
      const res = await fetch(`https://api.telegram.org/file/bot${cfg.botToken}/${filePath}`, {
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      await fs.writeFile(path.join(dir, name), buf)
      return name
    }

    // simulation path — placeholder image so the panel flow is demonstrable
    await fs.writeFile(
      path.join(dir, name),
      Buffer.from(PLACEHOLDER_PNG_BASE64, 'base64'),
    )
    return name
  } catch (e) {
    console.error('[bot-service] receipt save failed:', e)
    return null
  }
}
