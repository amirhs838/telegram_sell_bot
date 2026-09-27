import crypto from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { ApiError, ok, requireAuth, route } from '@/lib/api'

const UPLOAD_DIR = path.join(process.cwd(), 'upload')

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const MAX_SIZE = 5 * 1024 * 1024 // 5MB

export const POST = route(async (req: NextRequest) => {
  await requireAuth()

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
    throw new ApiError(400, 'حجم فایل نباید بیشتر از ۵ مگابایت باشد')
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
