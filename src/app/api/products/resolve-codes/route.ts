import type { NextRequest } from 'next/server'
import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'

/**
 * Live validation of the admin's «کدهای متصل (ست)» input.
 * GET /api/products/resolve-codes?codes=NC-102، ER-55&excludeId=<id?>
 * → { resolved: { "NC-102": { id, name, productCode } | null } }
 *
 * Accepts Latin and Persian commas (،) as separators. Matching is
 * trim- + case-insensitive, mirroring product-code lookup everywhere else.
 */
export const GET = route(async (req: NextRequest) => {
  await requireAuth()

  const raw = req.nextUrl.searchParams.get('codes')?.trim() ?? ''
  const excludeId = req.nextUrl.searchParams.get('excludeId')?.trim() || null

  const codes = raw
    .split(/[,،\n]/)
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 30)

  const resolved: Record<string, { id: string; name: string; productCode: string } | null> = {}
  if (!codes.length) return ok({ resolved })

  const rows = await db.product.findMany({
    where: { productCode: { not: null } },
    select: { id: true, name: true, productCode: true },
  })
  const byCode = new Map<string, { id: string; name: string; productCode: string }>()
  for (const r of rows) {
    const key = (r.productCode ?? '').trim().toLowerCase()
    if (key && !byCode.has(key)) byCode.set(key, { id: r.id, name: r.name, productCode: r.productCode! })
  }

  for (const code of codes) {
    const hit = byCode.get(code.toLowerCase())
    // excludeId: the product itself is never a valid link target.
    if (hit && excludeId && hit.id === excludeId) {
      resolved[code] = null
      continue
    }
    resolved[code] = hit ?? null
  }

  return ok({ resolved })
})
