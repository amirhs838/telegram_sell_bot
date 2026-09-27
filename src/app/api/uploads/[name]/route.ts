import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { ApiError, route } from '@/lib/api'

const UPLOAD_DIR = path.join(process.cwd(), 'upload')

const NAME_RE = /^[a-zA-Z0-9._-]+$/

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

export const dynamic = 'force-dynamic'

export const GET = route<{ params: Promise<{ name: string }> }>(
  async (_req: NextRequest, { params }) => {
    const { name } = await params

    if (!NAME_RE.test(name) || name.includes('..') || name.startsWith('.')) {
      throw new ApiError(400, 'نام فایل معتبر نیست')
    }

    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'

    let buffer: Buffer
    try {
      buffer = await readFile(path.join(UPLOAD_DIR, name))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ApiError(404, 'فایل یافت نشد')
      }
      throw e
    }

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  },
)
