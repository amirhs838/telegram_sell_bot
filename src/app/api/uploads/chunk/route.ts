import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { ApiError, ok, requireAuth, route } from '@/lib/api'
import {
  MAX_CHUNK_BYTES,
  MAX_PART_INDEX,
  UPLOAD_ID_RE,
  partDir,
  sweepStaleParts,
} from '@/lib/upload-parts'

/**
 * One small piece of a resumable upload. The browser splits the file into
 * ≤64KB chunks and POSTs each one separately (with retries): a flaky mobile
 * link that kills a 253KB transfer after a minute will happily carry 64KB
 * pieces, and a failed piece only retries itself — progress never restarts
 * from zero. Body: raw bytes. Query: id (upload session), i (piece index).
 */
export const POST = route(async (req: NextRequest) => {
  await requireAuth()

  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  const idx = Number(url.searchParams.get('i'))
  if (!UPLOAD_ID_RE.test(id)) throw new ApiError(400, 'شناسهٔ آپلود نامعتبر است')
  if (!Number.isInteger(idx) || idx < 0 || idx > MAX_PART_INDEX) {
    throw new ApiError(400, 'شمارهٔ بخش نامعتبر است')
  }

  const body = Buffer.from(await req.arrayBuffer())
  if (body.length === 0) throw new ApiError(400, 'بخش خالی است')
  if (body.length > MAX_CHUNK_BYTES) throw new ApiError(413, 'حجم بخش بیشتر از حد مجاز است')

  const dir = partDir(id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, String(idx)), body)

  void sweepStaleParts().catch(() => undefined)
  return ok({ received: body.length, index: idx })
})
