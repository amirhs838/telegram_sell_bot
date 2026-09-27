import type { NextRequest } from 'next/server'
import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'

function parseData(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export const GET = route(async (req: NextRequest) => {
  await requireAuth()

  const sp = req.nextUrl.searchParams
  const type = sp.get('type')?.trim() || undefined
  const level = sp.get('level')?.trim() || undefined
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(sp.get('pageSize') ?? '30', 10) || 30))

  const where = {
    ...(type ? { type } : {}),
    ...(level ? { level } : {}),
  }

  const [rows, total] = await Promise.all([
    db.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, level: true, type: true, message: true, data: true, createdAt: true },
    }),
    db.activityLog.count({ where }),
  ])

  return ok({
    items: rows.map((r) => ({ ...r, data: parseData(r.data) })),
    total,
    page,
    pageSize,
  })
})
