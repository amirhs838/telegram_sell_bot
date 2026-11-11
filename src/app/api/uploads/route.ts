import crypto from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { ApiError, ok, requireAuth, route } from '@/lib/api'
import { uploadDir } from '@/lib/upload-dir'

const UPLOAD_DIR = uploadDir()

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// 12MB — generous headroom: phone photos arrive over slow, unstable mobile
// links and the browser pre-shrinks them anyway (src/lib/image-compress.ts).
const MAX_SIZE = 12 * 1024 * 1024

export const POST = route(async (req: NextRequest) => {
  await requireAuth()

  // Fail fast BEFORE buffering the body: a slow mobile link must not spend
  // minutes pushing bytes we are going to reject anyway.
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_SIZE + 64 * 1024) {
    throw new ApiError(413, 'حجم فایل نباید بیشتر از ۱۲ مگابایت باشد')
  }

  const form = await req.formData().catch(() => {
    throw new ApiError(400, 'فرم ارسالی معتبر نیست')
  })
  const file = form.get('file')
  if (!(file instanceof File)) {
    throw new ApiError(400, 'فایلی ارسال نشده است')
  }

  const mime = file.type.toLowerCase().trim()
  const ext = ALLOWED_MIME[mime]
  if (!ext) {
    throw new ApiError(400, 'فرمت فایل مجاز نیست. فرمت‌های مجاز: JPG، PNG، WebP، GIF')
  }
  if (file.size > MAX_SIZE) {
    throw new ApiError(400, 'حجم فایل نباید بیشتر از ۱۲ مگابایت باشد')
  }
  if (file.size === 0) {
    throw new ApiError(400, 'فایل خالی است')
  }

  await mkdir(UPLOAD_DIR, { recursive: true })
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())
  await writeFile(path.join(UPLOAD_DIR, name), buffer)

  return ok({ url: `/api/uploads/${name}`, name, size: file.size })
})
