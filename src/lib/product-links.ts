// ─── Product set links (کدهای متصل) ──────────────────────────────────────────
// Admin enters OTHER products' codes on a product; those products become a
// "set": buying any member suggests the others at checkout (one step before
// payment). Links are symmetric and stored as canonical pairs (the smaller
// product id always sits in productId) so one row = the two-way link.
import { ApiError } from '@/lib/api'
import type { PrismaClient, Prisma } from '@prisma/client'

export const MAX_SET_LINKS = 20

/**
 * Normalizes the admin's linked-codes input array:
 * trims, drops empties, dedupes case-insensitively (first spelling wins).
 */
export function normalizeLinkedCodes(raw: string[] | null | undefined): string[] {
  if (!raw?.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of raw) {
    const code = r.trim()
    if (!code) continue
    const key = code.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(code)
  }
  return out
}

type LinkDb = Pick<PrismaClient, 'product' | 'productLink'> | Prisma.TransactionClient

/**
 * Resolves a list of product codes to product ids (case-insensitive, trim).
 * Throws 422 with a Persian message naming the unknown codes.
 * Self-linking is silently dropped (the product is already part of its own set).
 */
export async function resolveLinkedIds(
  db: LinkDb,
  codes: string[],
  selfId: string | null,
): Promise<string[]> {
  const wanted = normalizeLinkedCodes(codes)
  if (!wanted.length) return []
  if (wanted.length > MAX_SET_LINKS) {
    throw new ApiError(422, `حداکثر ${MAX_SET_LINKS} اتصال ست مجاز است`)
  }
  const rows = await db.product.findMany({
    where: { productCode: { not: null } },
    select: { id: true, productCode: true },
  })
  const byCode = new Map<string, string>()
  for (const r of rows) {
    const key = (r.productCode ?? '').trim().toLowerCase()
    if (key && !byCode.has(key)) byCode.set(key, r.id)
  }
  const unknown: string[] = []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const code of wanted) {
    const id = byCode.get(code.toLowerCase())
    if (!id) {
      unknown.push(code)
      continue
    }
    if (selfId && id === selfId) continue // self-link → ignore silently
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (unknown.length) {
    throw new ApiError(
      422,
      `این کدها برای هیچ محصولی ثبت نشده‌اند: ${unknown.join('، ')}`,
    )
  }
  return ids
}

/** Current neighbor ids of a product (either direction of the symmetric pair). */
export async function getLinkedIds(db: LinkDb, productId: string): Promise<string[]> {
  const rows = await db.productLink.findMany({
    where: { OR: [{ productId }, { linkedId: productId }] },
    select: { productId: true, linkedId: true },
  })
  return rows.map((r) => (r.productId === productId ? r.linkedId : r.productId))
}

/**
 * Replaces the whole link set of a product (PATCH semantics):
 *  - adds canonical pairs for codes that are not linked yet
 *  - removes pairs that are no longer listed
 *  - never touches links between OTHER products
 */
export async function setProductLinks(
  db: LinkDb,
  productId: string,
  linkedIds: string[],
): Promise<void> {
  const current = await getLinkedIds(db, productId)
  const currentSet = new Set(current)
  const wanted = [...new Set(linkedIds.filter((id) => id !== productId))]

  const toAdd = wanted.filter((id) => !currentSet.has(id))
  const wantedSet = new Set(wanted)
  const toRemove = current.filter((id) => !wantedSet.has(id))

  if (toRemove.length) {
    await db.productLink.deleteMany({
      where: {
        OR: toRemove.map((id) => ({
          OR: [{ productId: productId, linkedId: id }, { productId: id, linkedId: productId }],
        })),
      },
    })
  }

  for (const id of toAdd) {
    // canonical order: smaller id first — guarantees @@unique holds in both directions
    const [a, b] = [productId, id].sort()
    await db.productLink.upsert({
      where: { productId_linkedId: { productId: a, linkedId: b } },
      create: { productId: a, linkedId: b },
      update: {},
    })
  }
}

/** Neighbor product codes (for the panel form prefill / API response). */
export async function getLinkedCodes(
  db: LinkDb,
  productId: string,
): Promise<string[]> {
  const rows = await db.productLink.findMany({
    where: { OR: [{ productId }, { linkedId: productId }] },
    select: {
      productId: true,
      linked: { select: { id: true, productCode: true } },
      product: { select: { id: true, productCode: true } },
    },
  })
  const codes = rows.map((r) => {
    const other = r.productId === productId ? r.linked : r.product
    return (other.productCode ?? '').trim()
  })
  return codes.filter(Boolean)
}
