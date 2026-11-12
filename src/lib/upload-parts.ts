import { readdir, rmdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { uploadDir } from '@/lib/upload-dir'

/**
 * Staging area for chunked/resumable uploads (see /api/uploads/chunk +
 * /api/uploads/complete). The seller's link to the server is often a slow,
 * reset-prone mobile route: big single POST bodies die mid-transfer and
 * restart from zero. We instead store many small parts here and assemble
 * them only when every part has landed. Lives INSIDE the upload dir (but
 * under a dot-folder the public GET route refuses to serve).
 */

export const PARTS_ROOT = uploadDir('.parts')

export const UPLOAD_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/
export const MAX_CHUNK_BYTES = 256 * 1024
export const MAX_PART_INDEX = 255

/** Abandoned staging dirs older than this are swept on the next request. */
const PART_TTL_MS = 2 * 60 * 60 * 1000

export function partDir(id: string): string {
  return path.join(PARTS_ROOT, id)
}

/** Delete stale staging dirs — cheap (few entries), runs alongside requests. */
export async function sweepStaleParts(): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(PARTS_ROOT)
  } catch {
    return // staging dir doesn't exist yet
  }
  const cutoff = Date.now() - PART_TTL_MS
  for (const entry of entries) {
    const full = path.join(PARTS_ROOT, entry)
    try {
      const st = await stat(full)
      if (st.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true })
      } else {
        // Fresh dirs can linger EMPTY after complete() raced its own dir
        // removal — drop them (rmdir only succeeds when truly empty).
        await rmdir(full).catch(() => undefined)
      }
    } catch {
      /* racing cleanup is fine */
    }
  }
}
