import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { NextResponse, type NextRequest } from 'next/server'
import { ApiError, requireAuth, route } from '@/lib/api'

const RECEIPT_DIR = path.join(process.cwd(), 'upload', 'receipts')

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

type Ctx = { params: Promise<{ name: string }> }

/**
 * GET /api/payments/receipts/[name] — AUTHORIZED receipt image access.
 * Receipts live outside the public upload folder and are NEVER publicly
 * reachable; only authenticated panel users may view them.
 */
export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  await requireAuth()
  const { name } = await params

  // strict filename — no traversal, no subfolders
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
    throw new ApiError(400, 'نام فایل نامعتبر است')
  }
  const ext = path.extname(name).toLowerCase()
  const mime = MIME[ext]
  if (!mime) throw new ApiError(400, 'فرمت فایل پشتیبانی نمی‌شود')

  try {
    const buf = await readFile(path.join(RECEIPT_DIR, name))
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch {
    throw new ApiError(404, 'فایل رسید یافت نشد')
  }
})
