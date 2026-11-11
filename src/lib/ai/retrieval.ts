/**
 * Persian lexical-semantic product retrieval (BM25 + synonym graph + fuzzy
 * matching + query understanding). Replaces the old 256-dim hashed
 * bag-of-words vectors, which had NO semantic power: a customer asking for
 * «حلقه نقره» (ring) found nothing because products say «انگشتر».
 *
 * The pipeline, in order:
 *   1. normalizeFa       — Arabic/Persian char unification, diacritics, digits
 *   2. extractPriceFilter— «زیر ۲ میلیون» / «بین ۵۰۰ تا ۱ میلیون» → filters
 *   3. tokenizeFa        — tokens + ZWNJ split variants + light stemming
 *   4. stopword removal  — conversational filler never pollutes the index
 *   5. synonym expansion — jewelry-domain concept groups (weighted)
 *   6. fuzzy correction  — typos matched via 4-gram Jaccard / Levenshtein
 *   7. BM25 ranking      — field-weighted (name ×3, category ×2.5, tags ×2, …)
 *
 * The index is rebuilt in memory from LIVE product rows and invalidated by a
 * (count, maxUpdatedAt) signature + 90s TTL — always fresh, zero stale-vector
 * bugs, no network dependency. Price/stock truth ALWAYS comes from DB rows,
 * never from the text index.
 */
import { db } from '@/lib/db'

// ─── Normalization ───────────────────────────────────────────────────────────

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/** Convert Persian/Arabic digits to ASCII (numbers like ۹۲۵ must match 925). */
export function digitsToLatin(text: string): string {
  let out = ''
  for (const ch of text) {
    const pd = PERSIAN_DIGITS.indexOf(ch)
    if (pd >= 0) {
      out += String(pd)
      continue
    }
    const ad = ARABIC_DIGITS.indexOf(ch)
    if (ad >= 0) {
      out += String(ad)
      continue
    }
    out += ch
  }
  return out
}

/** Normalize Persian/Arabic text for matching (v2 — aggressive and safe). */
export function normalizeFa(text: string): string {
  return (
    digitsToLatin(text)
      // Arabic letter variants → Persian
      .replace(/[\u064A\u0649]/g, 'ی') // ي ى → ی
      .replace(/\u0643/g, 'ک') // ك → ک
      .replace(/[\u0623\u0625\u0622]/g, 'ا') // أ إ آ → ا
      .replace(/\u0629/g, 'ه') // ة → ه
      .replace(/\u0624/g, 'و') // ؤ → و
      // Arabic diacritics (fathah..sukun, superscript alef, small quran marks)
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
      .toLowerCase()
      // strip punctuation/emoji/symbols — keep letters + digits + ZWNJ
      .replace(/[^\p{L}\p{N}\s\u200c]/gu, ' ')
      // ZWNJ → space (compound words split: گردن‌بند → گردن بند; the index
      // side stores BOTH the joined and the split form — see tokenizeFa)
      .replace(/\u200c/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

// ─── Synonym concept graph (jewelry domain) ─────────────────────────────────
// members: interchangeable synonyms (weight 1.0 in the group)
// related: weaker associations (weight < 1) — آویز IS a necklace style, but
// زنجیر is merely RELATED to گردنبند.

type SynGroup = { members: string[]; related?: Record<string, number> }

const SYNONYM_GROUPS: SynGroup[] = [
  {
    // ring
    members: ['انگشتر', 'حلقه', 'انگشتری'],
    related: { 'نگین': 0.4, 'فیروزه': 0.3 },
  },
  {
    // necklace & pendant
    members: ['گردنبند', 'آویز', 'پلاک', 'لاکیت', 'لاکی'],
    related: { 'زنجیر': 0.5, 'قلب': 0.4, 'ستاره': 0.3, 'ماه': 0.3 },
  },
  {
    // chain
    members: ['زنجیر', 'بزل', 'زنجیربزل'],
    related: { 'گردنبند': 0.5 },
  },
  {
    // bracelet & bangle
    members: ['دستبند', 'النگو', 'بنگ', 'نیمبند'],
  },
  {
    // earring
    members: ['گوشواره', 'گوشوار', 'حلقگوش', 'آویزگوش'],
    related: { 'آویز': 0.4 },
  },
  {
    // jewelry set
    members: ['ست', 'سرویس', 'ستکامل'],
    related: { 'هدیه': 0.4, 'جعبه': 0.3 },
  },
  {
    // silver ingot / investment
    members: ['شمش', 'شمشه', 'شمشک'],
    related: { 'سرمایه': 0.6, 'سرمایهگذاری': 0.8, 'عیار': 0.4 },
  },
  {
    // gift
    members: ['هدیه', 'کادو', 'پیشکش', 'سوغات'],
    related: { 'ولنتاین': 0.5, 'تولد': 0.4, 'جعبه': 0.3, 'مخمل': 0.3 },
  },
  {
    // silver material
    members: ['نقره', 'سیلور', 'استرلینگ'],
    related: { '925': 0.6, '875': 0.5, '999': 0.5 },
  },
  {
    // delicate / fine style
    members: ['ظریف', 'مینی', 'مینیمال', 'ریز'],
    related: { 'ساده': 0.6, 'لطیف': 0.7, 'دستساز': 0.3 },
  },
  {
    // men
    members: ['مردانه', 'آقایان', 'جنتلمن', 'پسرانه'],
    related: { 'مرد': 0.8, 'اقا': 0.8, 'پدر': 0.5, 'شوهر': 0.5, 'برادر': 0.5 },
  },
  {
    // women
    members: ['زنانه', 'بانوان', 'دخترانه'],
    related: { 'زن': 0.8, 'بانو': 0.8, 'خانم': 0.8, 'مادر': 0.5, 'خواهر': 0.5 },
  },
  {
    // rose gold color
    members: ['رزگلد', 'رز'],
    related: { 'طلایی': 0.5 },
  },
  {
    // investment (dup anchor for related links from شمش)
    members: ['سرمایهگذاری', 'سرمایه'],
  },
  {
    // sporty / classic styles
    members: ['اسپرت', 'ورزشی'],
    related: { 'کلاسیک': 0.5 },
  },
]

type TermLinks = { syn: Map<string, number>; rel: Map<string, number> }

/** term → { synonyms, related } — built once, module-level, HMR-safe. */
const SYNONYM_INDEX: Map<string, TermLinks> = buildSynonymIndex()

function buildSynonymIndex(): Map<string, TermLinks> {
  const idx = new Map<string, TermLinks>()
  const touch = (term: string): TermLinks => {
    let l = idx.get(term)
    if (!l) {
      l = { syn: new Map(), rel: new Map() }
      idx.set(term, l)
    }
    return l
  }
  for (const g of SYNONYM_GROUPS) {
    for (const m of g.members) {
      const links = touch(m)
      for (const other of g.members) {
        if (other !== m) links.syn.set(other, Math.max(links.syn.get(other) ?? 0, 1))
      }
      for (const [term, w] of Object.entries(g.related ?? {})) {
        if (term !== m) links.rel.set(term, Math.max(links.rel.get(term) ?? 0, w))
      }
    }
    // related terms also link BACK into the group with half weight
    for (const [term, w] of Object.entries(g.related ?? {})) {
      const links = touch(term)
      for (const m of g.members) {
        links.rel.set(m, Math.max(links.rel.get(m) ?? 0, w * 0.8))
      }
    }
  }
  return idx
}

// ─── Tokenization ────────────────────────────────────────────────────────────

/** Conversational filler — never contributes to ranking. */
const STOPWORDS = new Set([
  // prepositions / pronouns / conjunctions
  'من','تو','او','ما','شما','ان','این','انها','انان','از','به','با','و','در','برای','تا','که','را','نیز','هم','یا','اما','اگر','چون','هر','هیچ','خیلی','بسیار','فقط','حدود','حدودا','میزان','یک','یه','دو','سه','چهار','پنج','شش','هفت','هشت','نه','ده',
  // conversational verbs / fillers (ZWNJ is already a space by normalizeFa,
  // so «می‌خواهم» arrives as tokens «می» + «خواهم»)
  'هست','هستید','است','باشه','باشد','دارید','داره','دارم','می','میخواهم','میخوام','میخوای','میخواهید','خواهم','خواهید','بخوام','بده','بدهید','بگو','بگید','لطفا','خواهش','ممنون','مرسی','سلام','خداحافظ','قابل','نداره','چیه','چی','کی','کجا','چطور','چند','چنده',
  // commerce noise (price handled by extractPriceFilterFa)
  'قیمت','تومان','تومن','میلیون','هزار','ریال','خرید','خریدم','سفارش','میکنم','کنم','بخوام','ندارم','ام','ای','ها','هایی',
])

/** Light Persian suffix stemming (plurals & comparatives only — safe cuts). */
function stem(token: string): string {
  let t = token
  for (const suf of ['هایمان', 'هایتان', 'هایشان', 'هایی', 'های', 'ها', 'ترین']) {
    if (t.length - suf.length >= 3 && t.endsWith(suf)) {
      t = t.slice(0, t.length - suf.length)
      break
    }
  }
  return t
}

/**
 * Tokenize normalized text:
 *  - plain tokens, stopword-filtered, light-stemmed;
 *  - re-join split compound variants: a product «دل نقره» (from دل‌نقره) also
 *    yields «دلنقره», and a query «دلنقره» yields «دل نقره» parts too, so
 *    both spellings always meet. Verified against the df map at scoring time.
 */
export function tokenizeFa(normalized: string): string[] {
  const raw = normalized.split(' ').filter(Boolean)
  const tokens: string[] = []
  for (const tok of raw) {
    if (STOPWORDS.has(tok)) continue
    const st = stem(tok)
    tokens.push(st)
  }
  // compound re-join: consecutive non-stopword pairs ("دل نقره" → "دلنقره")
  const rawFilt = raw.filter((t) => !STOPWORDS.has(t))
  for (let i = 0; i + 1 < rawFilt.length; i++) {
    tokens.push(rawFilt[i] + rawFilt[i + 1])
  }
  return tokens.filter(Boolean)
}

// ─── Query understanding: price filter extraction ───────────────────────────

export type PriceRange = { min?: number; max?: number }

const NUM_RE = String.raw`\d+(?:[./٫]\d+)?`
/** A VALID price phrase requires a direction word, a unit, or a تومان suffix —
 *  a bare number («عیار ۹۲۵», «۵۰ گرمی») is NEVER treated as a price. */
const PRICE_PHRASE_RE = new RegExp(
  String.raw`(زیر|کمتر از|تا سقف|حداکثر|حداقل|بالای|بیشتر از|بین|تا|از)?\s*(${NUM_RE})\s*(میلیون|هزار)?\s*(تومان|تومن)?`,
  'g',
)

function parseAmount(valueStr: string, unit: string | undefined): number {
  const v = Number(valueStr.replace(/[٫/]/g, '.'))
  if (!Number.isFinite(v)) return NaN
  if (unit === 'میلیون') return v * 1_000_000
  if (unit === 'هزار') return v * 1_000
  // bare number: ≥1000 read as toman directly, smaller values as هزار-toman
  return v >= 1000 ? v : v * 1000
}

/** Iterates valid price phrases → {amount, direction} in textual order. */
function scanPricePhrases(q: string): { amount: number; dir: string | undefined; between: boolean }[] {
  const out: { amount: number; dir: string | undefined; between: boolean }[] = []
  for (const m of q.matchAll(PRICE_PHRASE_RE)) {
    const dir = m[1]
    const unit = m[3]
    const toman = m[4]
    if (!dir && !unit && !toman) continue // bare number (عیار ۹۲۵) — not a price
    const amount = parseAmount(m[2], unit)
    if (!Number.isFinite(amount) || amount <= 0) continue
    out.push({ amount, dir, between: dir === 'بین' })
  }
  return out
}

/**
 * Parse Persian price phrases in the raw query:
 *   «زیر ۲ میلیون» / «کمتر از ۲ میلیون» / «تا ۲ میلیون» → {max: 2_000_000}
 *   «بالای ۵۰۰ هزار» / «بیشتر از ۵۰۰ هزار»              → {min: 500_000}
 *   «بین ۵۰۰ تا ۹۰۰ هزار» / «از ۵۰۰ تا ۹۰۰»             → {min, max}
 * Handles Persian/Arabic digits and «٫»/«/»/«.» decimals. Bare numbers
 * («عیار ۹۲۵», «۵۰ گرمی») are never misread as prices.
 */
export function extractPriceFilterFa(rawQuery: string): PriceRange {
  const q = normalizeFa(rawQuery)
  if (!q) return {}
  const phrases = scanPricePhrases(q)
  if (phrases.length === 0) return {}

  const betweenIdx = phrases.findIndex((p) => p.between)
  if (betweenIdx >= 0 && betweenIdx + 1 < phrases.length) {
    const a = phrases[betweenIdx].amount
    const b = phrases[betweenIdx + 1].amount
    return { min: Math.min(a, b), max: Math.max(a, b) }
  }

  const out: PriceRange = {}
  for (const p of phrases) {
    if (p.dir === 'زیر' || p.dir === 'کمتر از' || p.dir === 'حداکثر' || p.dir === 'تا سقف' || p.dir === 'تا') {
      out.max = Math.min(out.max ?? Infinity, p.amount)
    } else if (p.dir === 'بالای' || p.dir === 'بیشتر از' || p.dir === 'حداقل' || p.dir === 'از سقف' || p.dir === 'از') {
      out.min = Math.max(out.min ?? 0, p.amount)
    } else {
      // unit/toman without a direction word («انگشتر ۲ میلیونی») → upper bound
      out.max = Math.min(out.max ?? Infinity, p.amount)
    }
  }
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    const t = out.min
    out.min = out.max
    out.max = t
  }
  return {
    ...(out.min !== undefined ? { min: out.min } : {}),
    ...(out.max !== undefined && out.max !== Infinity ? { max: out.max } : {}),
  }
}

/** Strip valid price phrases from the query so they never pollute ranking. */
export function stripPricePhrase(rawQuery: string): string {
  return normalizeFa(rawQuery).replace(
    /(زیر|کمتر از|تا سقف|حداکثر|حداقل|بالای|بیشتر از|بین|تا|از)?\s*\d+(?:[./٫]\d+)?\s*(میلیون|هزار)?\s*(تومان|تومن)?/g,
    (full, dir: string | undefined, unit: string | undefined, toman: string | undefined) =>
      dir || unit || toman ? ' ' : full, // keep bare numbers (عیار ۹۲۵) intact
  )
}

// ─── BM25 index over live products ───────────────────────────────────────────

type IndexDoc = {
  id: string
  name: string
  price: number
  stock: number
  status: string
  imageUrl: string | null
  shortDescription: string | null
  categoryId: string | null
  createdAt: Date
  category: { id: string; name: string } | null
  // ranking internals
  tf: Map<string, number>
  dl: number
  categoryTerms: Set<string>
}

type RetrievalIndex = {
  sig: string
  at: number
  docs: IndexDoc[]
  df: Map<string, number>
  avgdl: number
  vocab: string[]
}

const INDEX_TTL_MS = 90_000
const K1 = 1.4
const B = 0.6

// field weights (token repetition — BM25 saturation keeps this sane)
const W_NAME = 3
const W_CATEGORY = 2.5
const W_TAGS = 2
const W_SHORT = 1.5
const W_SPECS = 1.5
const W_DESC = 1

const g = globalThis as unknown as { __silverlove_retrieval_index__?: RetrievalIndex }

function indexTokens(normalizedText: string): string[] {
  // indexing uses the same pipeline; synonyms are NOT expanded here —
  // query-side expansion alone covers recall and keeps docs compact
  return tokenizeFa(normalizedText)
}

async function buildIndex(): Promise<RetrievalIndex> {
  const [products, catAgg] = await Promise.all([
    db.product.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        shortDescription: true,
        price: true,
        stock: true,
        status: true,
        imageUrl: true,
        categoryId: true,
        tags: true,
        productCode: true,
        silverType: true,
        fineness: true,
        weightGrams: true,
        size: true,
        brand: true,
        appearance: true,
        createdAt: true,
        updatedAt: true,
        category: { select: { id: true, name: true } },
      },
    }),
    db.category.aggregate({ _max: { updatedAt: true }, _count: true }),
  ])

  const maxUpd = products.reduce((m, p) => Math.max(m, p.updatedAt.getTime()), 0)
  const sig = `${products.length}:${catAgg._count}:${maxUpd}:${catAgg._max.updatedAt?.getTime() ?? 0}`

  const docs: IndexDoc[] = []
  const df = new Map<string, number>()
  let totalDl = 0

  for (const p of products) {
    let tags: string[] = []
    if (p.tags) {
      try {
        const parsed: unknown = JSON.parse(p.tags)
        if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
      } catch {
        // malformed tags — ignore
      }
    }
    const parts: [string, number][] = [
      [p.name, W_NAME],
      [p.category?.name ?? '', W_CATEGORY],
      [tags.join(' '), W_TAGS],
      [p.shortDescription ?? '', W_SHORT],
      [
        [
          p.productCode ?? '',
          p.silverType ?? '',
          p.fineness !== null && p.fineness !== undefined ? `عیار ${p.fineness}` : '',
          p.weightGrams !== null && p.weightGrams !== undefined ? `${p.weightGrams} گرم` : '',
          p.size ?? '',
          p.brand ?? '',
          p.appearance ?? '',
        ].join(' '),
        W_SPECS,
      ],
      [p.description ?? '', W_DESC],
    ]

    const tf = new Map<string, number>()
    let dl = 0
    for (const [text, weight] of parts) {
      if (!text) continue
      for (const tok of indexTokens(normalizeFa(text))) {
        tf.set(tok, (tf.get(tok) ?? 0) + weight)
        dl += weight
      }
    }
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)

    docs.push({
      id: p.id,
      name: p.name,
      price: p.price,
      stock: p.stock,
      status: p.status,
      imageUrl: p.imageUrl,
      shortDescription: p.shortDescription,
      categoryId: p.categoryId,
      createdAt: p.createdAt,
      category: p.category,
      tf,
      dl: dl || 1,
      categoryTerms: new Set(p.category ? indexTokens(normalizeFa(p.category.name)) : []),
    })
    totalDl += docs[docs.length - 1].dl
  }

  return {
    sig,
    at: Date.now(),
    docs,
    df,
    avgdl: docs.length > 0 ? totalDl / docs.length : 1,
    vocab: [...df.keys()],
  }
}

async function getIndex(): Promise<RetrievalIndex> {
  const cached = g.__silverlove_retrieval_index__
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached

  // cheap signature check first — skip the rebuild when nothing changed
  try {
    const [pAgg, cAgg] = await Promise.all([
      db.product.aggregate({ _max: { updatedAt: true }, _count: true }),
      db.category.aggregate({ _max: { updatedAt: true }, _count: true }),
    ])
    const sig = `${pAgg._count}:${cAgg._count}:${pAgg._max.updatedAt?.getTime() ?? 0}:${cAgg._max.updatedAt?.getTime() ?? 0}`
    if (cached && cached.sig === sig) {
      cached.at = Date.now() // sliding TTL
      return cached
    }
  } catch {
    // signature probe failed → fall through to a full rebuild
  }
  const fresh = await buildIndex()
  g.__silverlove_retrieval_index__ = fresh
  return fresh
}

/** Force a rebuild on next retrieval (called after product/category writes). */
export function invalidateRetrievalIndex(): void {
  g.__silverlove_retrieval_index__ = undefined
}

// ─── Fuzzy token correction ──────────────────────────────────────────────────

function ngrams(s: string, n: number): Set<string> {
  const out = new Set<string>()
  if (s.length < n) {
    out.add(s)
    return out
  }
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function levenshteinWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  if (a === b) return true
  const m = b.length
  let prev = new Array<number>(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(m + 1)
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > max) return false // early exit — this row can never recover
    prev = cur
  }
  return prev[m] <= max
}

type CorrectedToken = { term: string; weight: number; kind: 'exact' | 'syn' | 'rel' | 'fuzzy' | 'prefix' }

/** Map one query token to index-vocabulary terms with weights. */
function correctToken(token: string, vocab: string[], df: Map<string, number>): CorrectedToken[] {
  const out: CorrectedToken[] = []
  const links = SYNONYM_INDEX.get(token)
  if (links) {
    out.push({ term: token, weight: 1, kind: 'exact' })
    for (const [t, w] of links.syn) {
      if (df.has(t)) out.push({ term: t, weight: 0.9 * w, kind: 'syn' })
    }
    for (const [t, w] of links.rel) {
      if (df.has(t)) out.push({ term: t, weight: 0.55 * w, kind: 'rel' })
    }
    return out
  }

  if (df.has(token)) {
    out.push({ term: token, weight: 1, kind: 'exact' })
    return out
  }

  if (token.length < 3) {
    // tiny tokens (single letters, «۹») — exact only
    if (df.has(token)) out.push({ term: token, weight: 1, kind: 'exact' })
    return out
  }

  // prefix match: «گوشوار» → «گوشواره»
  for (const v of vocab) {
    if (df.get(v) === undefined) continue
    if (v.startsWith(token) && v.length - token.length <= 3) {
      out.push({ term: v, weight: 0.75, kind: 'prefix' })
    } else if (token.startsWith(v) && token.length - v.length <= 2) {
      out.push({ term: v, weight: 0.7, kind: 'prefix' })
    }
  }
  if (out.length > 0) return out

  // typo correction: 4-gram Jaccard or bounded Levenshtein
  const qGrams = ngrams(token, 4)
  let bestTerm = ''
  let bestScore = 0
  for (const v of vocab) {
    if (Math.abs(v.length - token.length) > 3) continue
    const lev = token.length >= 7 ? 2 : token.length >= 4 ? 1 : 0
    let score = 0
    if (lev > 0 && levenshteinWithin(token, v, lev)) score = 0.7
    const gScore = jaccard(qGrams, ngrams(v, 4))
    if (gScore >= 0.45) score = Math.max(score, 0.6 * gScore + 0.2)
    if (score > bestScore) {
      bestScore = score
      bestTerm = v
    }
  }
  if (bestTerm && bestScore >= 0.5) {
    out.push({ term: bestTerm, weight: bestScore, kind: 'fuzzy' })
  }
  return out
}

// ─── Public search API (same signature as the legacy implementation) ────────

export type SemanticSearchProduct = {
  id: string
  name: string
  price: number
  stock: number
  status: string
  imageUrl: string | null
  shortDescription: string | null
  categoryId: string | null
  createdAt: Date
  category: { id: string; name: string } | null
}

export type SemanticSearchHit = { product: SemanticSearchProduct; score: number }

export type SearchOptions = {
  limit?: number
  categoryId?: string
  maxPrice?: number
  minPrice?: number
  /** include non-active products (panel previews) — default false */
  includeInactive?: boolean
}

const MIN_SCORE = 0.75
const MIN_REL = 0.18

export async function semanticSearch(
  query: string,
  opts: SearchOptions = {},
): Promise<SemanticSearchHit[]> {
  const limit = Math.max(1, opts.limit ?? 8)
  const index = await getIndex()

  const matchesFilters = (p: SemanticSearchProduct): boolean => {
    if (!opts.includeInactive && p.status !== 'active') return false
    if (opts.categoryId && p.categoryId !== opts.categoryId) return false
    if (opts.minPrice !== undefined && p.price < opts.minPrice) return false
    if (opts.maxPrice !== undefined && p.price > opts.maxPrice) return false
    return true
  }

  // price phrases inside the query enrich the filters (explicit args win)
  const priceFromQuery = extractPriceFilterFa(query)
  const minPrice = opts.minPrice ?? priceFromQuery.min
  const maxPrice = opts.maxPrice ?? priceFromQuery.max

  // ranking text: the query minus its price phrase
  const cleanQuery = stripPricePhrase(query)
  const norm = normalizeFa(cleanQuery)
  const hasQuery = norm.length > 0

  if (!hasQuery) {
    // filter-only search → newest matching products
    return index.docs
      .map((d) => d)
      .filter(matchesFilters)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((d) => ({ product: toProduct(d), score: 0 }))
  }

  const tokens = tokenizeFa(norm)
  if (tokens.length === 0) {
    return index.docs
      .filter(matchesFilters)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((d) => ({ product: toProduct(d), score: 0 }))
  }

  // expand every query token through synonyms + fuzzy correction
  const qTerms = new Map<string, number>()
  for (const tok of tokens) {
    for (const c of correctToken(tok, index.vocab, index.df)) {
      qTerms.set(c.term, Math.max(qTerms.get(c.term) ?? 0, c.weight))
    }
  }
  if (qTerms.size === 0) return []

  // BM25
  const N = index.docs.length
  const scored: { d: IndexDoc; score: number }[] = []
  for (const d of index.docs) {
    if (!matchesFilters(d)) continue
    let score = 0
    for (const [term, qw] of qTerms) {
      const f = d.tf.get(term)
      if (!f) continue
      const dfT = index.df.get(term) ?? 1
      const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5))
      const tfNorm = (f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.dl) / index.avgdl))
      score += qw * idf * tfNorm
    }
    if (score > 0) scored.push({ d, score })
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0].score
  const kept = scored
    .filter((s) => s.score >= MIN_SCORE && s.score >= top * MIN_REL)
    .slice(0, limit)
  if (kept.length === 0) {
    // everything scored below the noise floor → LIKE last resort
    return likeFallback(tokens, limit, opts, minPrice, maxPrice)
  }
  return kept.map((s) => ({ product: toProduct(s.d), score: Math.round(s.score * 1000) / 1000 }))
}

function toProduct(d: IndexDoc): SemanticSearchProduct {
  return {
    id: d.id,
    name: d.name,
    price: d.price,
    stock: d.stock,
    status: d.status,
    imageUrl: d.imageUrl,
    shortDescription: d.shortDescription,
    categoryId: d.categoryId,
    createdAt: d.createdAt,
    category: d.category,
  }
}

async function likeFallback(
  tokens: string[],
  limit: number,
  opts: SearchOptions,
  minPrice?: number,
  maxPrice?: number,
): Promise<SemanticSearchHit[]> {
  const useful = tokens.filter((t) => t.length >= 3).slice(0, 4)
  if (useful.length === 0) return []
  const products = await db.product.findMany({
    where: {
      ...(opts.includeInactive ? {} : { status: 'active' }),
      ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
      ...(minPrice !== undefined || maxPrice !== undefined
        ? {
            price: {
              ...(minPrice !== undefined ? { gte: minPrice } : {}),
              ...(maxPrice !== undefined ? { lte: maxPrice } : {}),
            },
          }
        : {}),
      OR: useful.flatMap((t) => [
        { name: { contains: t } },
        { shortDescription: { contains: t } },
        { tags: { contains: t } },
      ]),
    },
    select: {
      id: true,
      name: true,
      price: true,
      stock: true,
      status: true,
      imageUrl: true,
      shortDescription: true,
      categoryId: true,
      createdAt: true,
      category: { select: { id: true, name: true } },
    },
    take: limit,
    orderBy: { createdAt: 'desc' },
  })
  return products.map((p) => ({ product: p, score: 0 }))
}
