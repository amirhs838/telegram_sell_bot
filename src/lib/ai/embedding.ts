// RAG-ready vector layer for products.
// Provider: `local-hash-v1` — a deterministic 256-dim hashed bag-of-words +
// char-3-grams vectorizer with Persian normalization. Pure JS, no network,
// swappable later for a real embedding API (same table, different `model`).
// NOTE: vectors are used for RELEVANCE only — price/stock truth always comes
// from DB rows joined with each hit, never from the vector space.
import { db } from '@/lib/db'

export const EMBEDDING_MODEL = 'local-hash-v1'

const DIM = 256

/** Normalize Persian/Arabic text for matching. */
export function normalizeFa(text: string): string {
  return text
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/\u200c/g, '')
    .toLowerCase()
    // strip punctuation/emoji/symbols — keep unicode letters + digits
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** FNV-1a 32-bit hash (pure, crypto-free). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Deterministic 256-dim local vectorizer:
 * word tokens (weight 1.0) + char 3-grams of each word of length ≥3 (weight 0.5),
 * each hashed with FNV-1a into a 256-bucket accumulator, then L2-normalized.
 */
export function embed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0)
  const norm = normalizeFa(text)
  if (!norm) return vec

  const words = norm.split(' ').filter(Boolean)
  for (const word of words) {
    vec[fnv1a(word) % DIM] += 1.0
    if (word.length >= 3) {
      for (let i = 0; i + 3 <= word.length; i++) {
        vec[fnv1a(word.slice(i, i + 3)) % DIM] += 0.5
      }
    }
  }

  let sumSq = 0
  for (const v of vec) sumSq += v * v
  if (sumSq > 0) {
    const norm2 = Math.sqrt(sumSq)
    for (let i = 0; i < DIM; i++) vec[i] /= norm2
  }
  return vec
}

/** Cosine similarity between two vectors. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

type ProductWithCategory = {
  name: string
  shortDescription?: string | null
  description?: string | null
  tags?: string | null
  category?: { name: string } | null
}

/** Build the text that gets embedded for a product. */
export function buildProductContentText(product: ProductWithCategory): string {
  let tags: string[] = []
  if (product.tags) {
    try {
      const parsed: unknown = JSON.parse(product.tags)
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
    } catch {
      // ignore malformed tags JSON
    }
  }
  return [
    product.name,
    product.shortDescription ?? '',
    product.description ?? '',
    tags.join(' '),
    product.category?.name ?? '',
  ]
    .filter((part) => part !== '')
    .join('\n')
}

/** Compute + upsert the embedding row for one product. No-op if product is missing. */
export async function upsertProductEmbedding(productId: string): Promise<void> {
  const product = await db.product.findUnique({
    where: { id: productId },
    include: { category: { select: { name: true } } },
  })
  if (!product) return

  const content = buildProductContentText(product)
  const vector = embed(content)
  const data = {
    content,
    embedding: JSON.stringify(vector),
    metadata: JSON.stringify({
      productId: product.id,
      name: product.name,
      categoryId: product.categoryId,
      categoryName: product.category?.name ?? null,
      status: product.status,
      price: product.price,
    }),
    model: EMBEDDING_MODEL,
  }

  await db.productEmbedding.upsert({
    where: { productId: product.id },
    create: { productId: product.id, ...data },
    update: data,
  })
}

/** Recompute embeddings for every product. Returns the number rebuilt. */
export async function rebuildAllEmbeddings(): Promise<{ count: number }> {
  const products = await db.product.findMany({ select: { id: true } })
  let count = 0
  for (const p of products) {
    try {
      await upsertProductEmbedding(p.id)
      count++
    } catch (e) {
      console.error(`[ai:embedding] failed for product ${p.id}`, e)
    }
  }
  return { count }
}

export type SemanticSearchProduct = {
  id: string
  name: string
  price: number
  stock: number
  status: string
  imageUrl: string | null
  shortDescription: string | null
  categoryId: string | null
  category: { id: string; name: string } | null
}

export type SemanticSearchHit = { product: SemanticSearchProduct; score: number }

const PRODUCT_SELECT = {
  id: true,
  name: true,
  price: true,
  stock: true,
  status: true,
  imageUrl: true,
  shortDescription: true,
  categoryId: true,
  category: { select: { id: true, name: true } },
} as const

/**
 * Semantic product search over stored embeddings.
 * Only `active` products; numeric/category filters applied in JS;
 * cosine score against the normalized query vector; keeps score > 0.03.
 * Falls back to a plain LIKE search on name/shortDescription when the
 * embedding table has no rows (score = 0).
 */
export async function semanticSearch(
  query: string,
  opts: { limit?: number; categoryId?: string; maxPrice?: number; minPrice?: number } = {},
): Promise<SemanticSearchHit[]> {
  const limit = Math.max(1, opts.limit ?? 8)
  const rows = await db.productEmbedding.findMany({
    include: { product: { select: PRODUCT_SELECT } },
  })

  const matchesFilters = (p: SemanticSearchProduct): boolean => {
    if (p.status !== 'active') return false
    if (opts.categoryId && p.categoryId !== opts.categoryId) return false
    if (opts.minPrice !== undefined && p.price < opts.minPrice) return false
    if (opts.maxPrice !== undefined && p.price > opts.maxPrice) return false
    return true
  }

  if (rows.length === 0) {
    // LIKE fallback — embedding table not populated yet
    const q = query.trim()
    if (!q) return []
    const products = await db.product.findMany({
      where: {
        status: 'active',
        ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
        ...(opts.minPrice !== undefined || opts.maxPrice !== undefined
          ? {
              price: {
                ...(opts.minPrice !== undefined ? { gte: opts.minPrice } : {}),
                ...(opts.maxPrice !== undefined ? { lte: opts.maxPrice } : {}),
              },
            }
          : {}),
        OR: [{ name: { contains: q } }, { shortDescription: { contains: q } }],
      },
      select: PRODUCT_SELECT,
      take: limit,
      orderBy: { createdAt: 'desc' },
    })
    return products.map((product) => ({ product, score: 0 }))
  }

  const queryVec = embed(query)
  const scored: SemanticSearchHit[] = []
  for (const row of rows) {
    const product = row.product
    if (!product || !matchesFilters(product)) continue
    let stored: number[] = []
    try {
      const parsed: unknown = JSON.parse(row.embedding)
      if (Array.isArray(parsed)) stored = parsed.filter((v): v is number => typeof v === 'number')
    } catch {
      continue
    }
    const score = cosine(queryVec, stored)
    if (score > 0.03) scored.push({ product, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
