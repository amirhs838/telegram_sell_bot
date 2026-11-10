// RAG retrieval layer for products.
//
// The ranking engine lives in `retrieval.ts` (BM25 + Persian synonym graph +
// fuzzy matching over LIVE product rows — always fresh, no stale vectors).
// This module keeps the legacy surface: the ProductEmbedding table + the
// local-hash-v1 vectorizer are still maintained for the panel's
// /api/ai/embeddings status & rebuild endpoints, while `semanticSearch`
// now delegates to the real retrieval engine.
import { db } from '@/lib/db'
import {
  semanticSearch,
  normalizeFa,
  invalidateRetrievalIndex,
  type SemanticSearchHit,
  type SemanticSearchProduct,
  type SearchOptions,
} from '@/lib/ai/retrieval'

export const EMBEDDING_MODEL = 'local-hash-v1'

export { normalizeFa }
export type { SemanticSearchHit, SemanticSearchProduct, SearchOptions }
export { semanticSearch, invalidateRetrievalIndex }

const DIM = 256

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
  // the live retrieval index is built from product rows — refresh its cache
  invalidateRetrievalIndex()
  return { count }
}
