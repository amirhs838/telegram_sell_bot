import crypto from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { uploadDir } from '@/lib/upload-dir'
import { UPLOAD_ID_RE, partDir, sweepStaleParts } from '@/lib/upload-parts'

const MAX_SIZE = 12 * 1024 * 1024

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const schema = z.object({
  id: z.string().regex(UPLOAD_ID_RE, 'شناسهٔ آپلود نامعتبر است'),
  mime: z.string().trim().max(60),
  total: z.number().int().min(1).max(256),
})

/**
 * Assemble a finished chunked upload: verify every piece arrived, concat in
 * order, publish under the standard upload name, drop the staging dir.
 * Same response shape as the single-shot POST /api/uploads.
 */
export const POST = route(async (req: NextRequest) => {
  await requireAuth()

  const { id, mime, total } = schema.parse(await readJson(req))
  const ext = ALLOWED_MIME[mime.toLowerCase()]
  if (!ext) {
    throw new ApiError(400, 'فرمت فایل مجاز نیست. فرمت‌های مجاز: JPG، PNG، WebP، GIF')
  }

  const dir = partDir(id)
  const names = await readdir(dir).catch(() => null)
  if (!names) throw new ApiError(404, 'بخش‌های آپلود پیدا نشد — از اول تلاش کنید')

  const indexes = names
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b)
  if (indexes.length !== total || indexes[indexes.length - 1] !== total - 1) {
    throw new ApiError(
      400,
      `فقط ${indexes.length} بخش از ${total} بخش رسیده — چند لحظه دیگر دوباره تلاش کنید`,
    )
  }

  const parts: Buffer[] = []
  let size = 0
  for (const i of indexes) {
    const buf = await readFile(path.join(dir, String(i)))
    parts.push(buf)
    size += buf.length
  }
  if (size === 0) throw new ApiError(400, 'فایل خالی است')
  if (size > MAX_SIZE) throw new ApiError(413, 'حجم فایل نباید بیشتر از ۱۲ مگابایت باشد')

  const UPLOAD_DIR = uploadDir()
  await mkdir(UPLOAD_DIR, { recursive: true })
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`
  await writeFile(path.join(UPLOAD_DIR, name), Buffer.concat(parts))
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)

  void sweepStaleParts().catch(() => undefined)
  return ok({ url: `/api/uploads/${name}`, name, size })
})
