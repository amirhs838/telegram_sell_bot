/**
 * bot-service — conversation engine (state machine persisted in BotSession).
 *
 * Pure-ish core: handleUpdate(input) → Reply[]. It returns replies instead of
 * sending them itself; the caller (/simulate response or the polling loop) is
 * responsible for delivery. A Reply may carry a `photo` source — the polling
 * loop delivers it via sendPhoto (multipart) while /simulate reports it
 * JSON-safely. Side effects inside (orders, payments, notifications) are
 * wrapped and never throw.
 *
 * All customer-facing strings are Persian.
 *
 * Pricing law: product captions ALWAYS show the stored `price` — never a value
 * computed from silver rate × weight (see prisma/schema.prisma Product.price).
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type InlineButton,
  aiReplyToTelegramHtml,
  escapeHtml,
  formatMoney,
  formatNumber,
  orderStatusFa,
  isBroadDiscoveryQuery,
  classifySmallTalk,
  smallTalkReplyFa,
  detectBareTypeAsk,
} from '../../src/lib/telegram-render'
import { buildWelcomeMessage } from '../../src/lib/bot-templates'
import { db } from './db'
import {
  InsufficientStockError,
  ProductUnavailableError,
  createOrder,
  setOrderStatus,
} from './orders'
import {
  getActivePaymentDestinations,
  getCategory,
  getProduct,
  getStoreSettings,
  listActiveDiscountedProducts,
  listActiveProductsByCategory,
  listChildCategories,
  listRootCategories,
  searchActiveProducts,
} from './store'
import {
  answerCallback,
  downloadFile,
  getFileInfo,
  loadConfig,
  type Platform,
  type PhotoSource,
  notifyAdmin,
} from './telegram'

export type Reply = { text: string; keyboard?: InlineButton[][]; photo?: PhotoSource }

export type BotFlow =
  | 'await_quantity'
  | 'await_name'
  | 'await_phone'
  | 'await_address'
  | 'await_confirm'
  | 'await_search'
  | 'await_receipt'

export type BotState = {
  flow?: BotFlow
  productId?: string
  quantity?: number
  name?: string
  phone?: string
  address?: string
  /** set while flow === 'await_receipt' — the order awaiting its payment receipt */
  orderId?: string
}

export type UpdateInput = {
  telegramUserId: string
  /** Bale customers arrive with the `bale:` prefix (platform-scoped identity) */
  firstName?: string
  username?: string
  text?: string
  /** largest photo in a private-chat message (Telegram/Bale) */
  photo?: { fileId: string; caption?: string }
  callbackData?: string
  callbackId?: string
  action?: string // 'reset' (simulator convenience)
  /** which messenger this update came from — defaults to 'telegram' */
  platform?: Platform
}

const SESSION_TTL_MS = 30 * 60 * 1000
const PRODUCTS_PER_PAGE = 5
const DEFAULT_LOW_STOCK = 5
const PHOTO_CAPTION_MAX = 1000 // Telegram photo caption limit is 1024
const EXTRA_PHOTOS_MAX = 4

// ─── Local file helpers (product photos + receipts) ──────────────────────────

const META_DIR = (import.meta as unknown as { dir?: string }).dir
/** Project root (this file lives at <root>/mini-services/bot-service). */
const PROJECT_ROOT = META_DIR ? path.resolve(META_DIR, '..', '..') : process.cwd()

function uploadCandidates(name: string): string[] {
  const safe = path.basename(name) // no path traversal
  const dirs = [path.join(process.cwd(), 'upload'), path.join(PROJECT_ROOT, 'upload')]
  return [...new Set(dirs.map((d) => path.join(d, safe)))]
}

async function readLocalUpload(name: string): Promise<Buffer | null> {
  for (const p of uploadCandidates(name)) {
    try {
      return await readFile(p)
    } catch {
      // try next candidate
    }
  }
  return null
}

/** Save a downloaded receipt photo → /api/receipts/<name> (private serving). */
async function saveReceiptFile(buf: Buffer): Promise<string | null> {
  try {
    const dir = path.join(PROJECT_ROOT, 'upload', 'receipts')
    await mkdir(dir, { recursive: true })
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.jpg`
    await writeFile(path.join(dir, name), buf)
    return `/api/receipts/${name}`
  } catch (e) {
    console.error('[bot-service] saveReceiptFile failed:', e)
    return null
  }
}

/**
 * Resolve a stored image URL to a sendPhoto source:
 *  - http(s) URL  → used as-is (Telegram fetches it)
 *  - /api/uploads/<name> → local file read from <root>/upload/<name>
 *  - anything else / missing file → null (caller falls back to a text card)
 */
async function resolvePhotoSource(url: string | null | undefined): Promise<PhotoSource | null> {
  if (!url) return null
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/api/uploads/')) {
    const buf = await readLocalUpload(trimmed.slice('/api/uploads/'.length))
    if (buf) return { buffer: buf, filename: path.basename(trimmed) }
  }
  return null
}

// ─── Menus ───────────────────────────────────────────────────────────────────

/**
 * Bottom REPLY keyboard — the persistent shop menu that sits above the input
 * field (user-requested layout, matches photo exactly):
 *   row 1: 🛒 سبد خرید | 📦 سفارش‌های من
 *   row 2: 🛍 محصولات (full width)
 *   row 3: ❓ سوالات متداول | 💬 گفتگو با فروشنده
 * Text buttons submit their label as a normal message; handleText() matches
 * these exact strings BEFORE any active flow so the menu always works.
 * deliver() attaches it to every outgoing reply that has no inline keyboard.
 */
export const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '🛒 سبد خرید' }, { text: '📦 سفارش‌های من' }],
    [{ text: '🛍 محصولات' }],
    [{ text: '❓ سوالات متداول' }, { text: '💬 گفتگو با فروشنده' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
}

const BOTTOM_BUTTONS: ReadonlySet<string> = new Set(
  MAIN_KEYBOARD.keyboard.flat().map((b) => b.text),
)

const MAIN_MENU: InlineButton[][] = [
  [{ text: '🛍 مشاهده محصولات', callback_data: 'menu:products' }, { text: '🔎 جستجوی محصول', callback_data: 'menu:search' }],
  [{ text: '✨ مشاوره خرید', callback_data: 'menu:ai' }, { text: '💳 سفارش‌های من', callback_data: 'menu:orders' }],
  [{ text: '📞 ارتباط با فروشگاه', callback_data: 'menu:support' }, { text: 'ℹ️ درباره Silver Love', callback_data: 'menu:about' }],
]

const CANCEL_ORDER_ROW: InlineButton[] = [{ text: '❌ انصراف', callback_data: 'order:cancel' }]
const HOME_ROW: InlineButton[] = [{ text: '🏠 منوی اصلی', callback_data: 'menu:main' }]

// ─── Session persistence ─────────────────────────────────────────────────────

async function loadSession(telegramUserId: string): Promise<BotState> {
  const row = await db.botSession.findUnique({ where: { telegramUserId } })
  if (!row) return {}
  // stale flow (> 30 min) → start fresh
  if (Date.now() - row.updatedAt.getTime() > SESSION_TTL_MS) return {}
  try {
    return JSON.parse(row.state) as BotState
  } catch {
    return {}
  }
}

async function saveSession(telegramUserId: string, state: BotState): Promise<void> {
  const json = JSON.stringify(state)
  await db.botSession.upsert({
    where: { telegramUserId },
    create: { telegramUserId, state: json },
    update: { state: json },
  })
}

async function clearFlow(telegramUserId: string): Promise<void> {
  await saveSession(telegramUserId, {})
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'

function toLatinDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
}

/** Accepts 09xxxxxxxxx / 9xxxxxxxxx / +989xxxxxxxxx / 00989xxxxxxxxx (fa digits ok). */
function normalizePhone(raw: string): string | null {
  const s = toLatinDigits(raw).replace(/[\s\-().]/g, '')
  if (/^\+989\d{9}$/.test(s)) return '0' + s.slice(3)
  if (/^00989\d{9}$/.test(s)) return '0' + s.slice(5)
  if (/^989\d{9}$/.test(s)) return '0' + s.slice(2)
  if (/^09\d{9}$/.test(s)) return s
  if (/^9\d{9}$/.test(s)) return '0' + s
  return null
}

function lowStockThreshold(p: { stock: number; lowStockThreshold?: number | null }): number {
  return p.lowStockThreshold ?? DEFAULT_LOW_STOCK
}

function stockLine(p: { stock: number; lowStockThreshold?: number | null }): string {
  if (p.stock <= 0) return '🔴 ناموجود'
  if (p.stock <= lowStockThreshold(p)) return `⚠️ فقط ${formatNumber(p.stock)} عدد باقی مانده`
  return `📦 موجودی: ${formatNumber(p.stock)} عدد`
}

function productButtonLabel(p: { name: string; price: number }): string {
  return `${p.name} — ${formatMoney(p.price)}`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function formatWeight(grams: number): string {
  return `${grams.toLocaleString('fa-IR', { maximumFractionDigits: 2 })} گرم`
}

// ─── Views ───────────────────────────────────────────────────────────────────

/**
 * Main menu — text-only on purpose: deliver() attaches the persistent bottom
 * reply keyboard (MAIN_KEYBOARD) automatically, matching the requested layout.
 */
function mainMenuReply(text = '🏠 منوی اصلی. از دکمه‌های پایین صفحه استفاده کنید:'): Reply {
  return { text }
}

/** Consult intro shared by the bottom-keyboard button, menu:ai and /start deep link. */
function aiConsultIntro(): Reply {
  return {
    text: '✨ گفتگو با فروشنده\n\nکافی است سؤال یا درخواست خود را بنویسید؛ مثلاً:\n«یه دستبند نقره برای هدیه تا دو میلیون می‌خوام»\n\nدستیار فروش ما نیازتان را می‌فهمد، محصولات موجود را با قیمت واقعی پیشنهاد می‌دهد و تا ثبت سفارش همراهتان است 💎',
  }
}

/** Cart view — the order flow is per-product, so an empty-cart state is the truth. */
function cartReply(): Reply {
  return {
    text: '🛒 سبد خرید شما خالی است.\n\nبرای انتخاب محصول، بخش محصولات را ببینید؛ پس از انتخاب محصول، مراحل ثبت سفارش را قدم‌به‌قدم همراهتان انجام می‌دهم.',
  }
}

/** FAQ — plain HTML-formatted answers to the most common silver-shop questions. */
function faqReply(): Reply {
  return {
    text: [
      '❓ <b>سوالات متداول</b>',
      '',
      '💎 <b>اصالت محصولات</b>\nهمه محصولات نقره ۹۲۵ هستند؛ با مهر عیار و ضمانت اصالت ارسال می‌شوند.',
      '',
      '🚚 <b>زمان و هزینه ارسال</b>\nپس از تأیید پرداخت، سفارش با پست پیشتاز ارسال می‌شود (۲ تا ۴ روز کاری). هزینه ارسال هنگام ثبت سفارش اعلام می‌شود.',
      '',
      '💳 <b>روش پرداخت</b>\nکارت به کارت به کارت‌های اعلام‌شده؛ سپس تصویر رسید را در همین ربات ارسال کنید تا سریع تأیید شود.',
      '',
      '↩️ <b>بازگشت کالا</b>\nتا ۷ روز پس از دریافت، در صورت مغایرت با توضیحات محصول، بازگرداندن کالا بدون سؤال انجام می‌شود.',
      '',
      '📏 <b>سایز انگشتر و دستبند</b>\nراهنمای اندازه‌گیری سایز هنگام سفارش برایتان ارسال می‌شود.',
      '',
      '🧼 <b>نگهداری نقره</b>\nاز تماس با عطر و مواد شوینده دور نگه دارید و با دستمال جواهر تمیز کنید.',
      '',
      'سؤال دیگری دارید؟ همین‌جا بنویسید تا فوری پاسخ بدهم 🌸',
    ].join('\n'),
  }
}

/**
 * Products-menu keyboard — EXACT layout the owner approved (RTL pairing):
 *   row 1: ⬅️ بازگشت (full width)
 *   row 2: 👨 زیور مردانه وارداتی | 👩 زیور زنانه وارداتی   (first category on the RIGHT)
 *   row 3: 💎 سرمایه‌گذاری | 🔥 آفرهای هفتگی
 *   row 4: 🏠 منوی اصلی (full width)
 * Generic rule: categories pair 2-per-row in menu order (sortOrder, then
 * creation order), first of each pair rendered on the RIGHT so Persian reads
 * naturally. Odd leftover gets a full-width row. The same builder is reused
 * for SUBcategory keyboards inside a category page. "آفرهای هفتگی" is smart —
 * see categoryPageReply().
 */
function categoryKeyboardRows(cats: Array<{ id: string; name: string }>): InlineButton[][] {
  const kb: InlineButton[][] = []
  for (let i = 0; i < cats.length; i += 2) {
    const pair = cats.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `cat:${c.id}` }))
    kb.push(pair.length === 2 ? [pair[1], pair[0]] : [pair[0]])
  }
  return kb
}

async function categoriesReply(): Promise<Reply> {
  // Top-level categories only — subcategories appear inside their parent's page.
  const cats = await listRootCategories()
  const backRow: InlineButton[] = [{ text: '⬅️ بازگشت', callback_data: 'back:products' }]
  if (cats.length === 0) {
    return { text: 'هنوز دسته‌ای ثبت نشده است.', keyboard: [backRow, ...MAIN_MENU] }
  }
  const kb: InlineButton[][] = [backRow, ...categoryKeyboardRows(cats), HOME_ROW]
  return { text: '🛍 محصولات\nدستهٔ موردنظر را انتخاب کنید:', keyboard: kb }
}

/**
 * Consultative answer used whenever the AI layer is unreachable or unusable:
 * CONTEXT-AWARE needs-assessment — a message that names a product type gets
 * THAT type's follow-up questions («انگشتر مردانه یا زنانه؟ بودجه؟») plus the
 * matching category buttons; gift messages get gift questions; anything else
 * gets the generic needs-assessment + category quick-pick. Never mentions any
 * technical failure and never blasts product cards.
 */
const GIFT_INTENT_RE = /هدیه|کادو|برای\s?(مادر|پدر|همسر|خواهر|برادر|دوست|استاد|معلم|همکار)/i

/**
 * Category quick-pick for a named product type: the subcategories whose name
 * contains the type fragment (e.g. «انگشتر زنانه»، «انگشتر مردانه»), falling
 * back to the root categories when no dedicated subcategory exists.
 */
async function typeQuickPickCategories(base: string): Promise<Array<{ id: string; name: string }>> {
  const roots = await listRootCategories().catch(() => [])
  const matches: Array<{ id: string; name: string }> = []
  for (const r of roots) {
    const kids = await listChildCategories(r.id).catch(() => [])
    for (const k of kids) {
      if (k.name.includes(base) && !matches.some((m) => m.id === k.id)) matches.push(k)
    }
  }
  return matches.length > 0 ? matches : roots
}

async function consultCategoriesReply(userText?: string): Promise<Reply> {
  const text = (userText ?? '').trim()
  const base = detectBareTypeAsk(text)

  // Named product type → the user's own example of a RIGHT question:
  // «انگشتر مردانه یا زنانه؟ تا چه قیمتی؟» + that type's category buttons.
  if (base) {
    const cats = await typeQuickPickCategories(base)
    const kb: InlineButton[][] =
      cats.length > 0 ? [...categoryKeyboardRows(cats), HOME_ROW] : MAIN_MENU
    return {
      text: [
        `${base}های متنوعی داریم 😊`,
        '',
        '۱️⃣ مردانه می‌خواهید یا زنانه؟',
        '۲️⃣ حدود بودجه‌تان چقدر است؟',
        '',
        'یا مستقیم یکی از دسته‌های زیر را انتخاب کنید 👇',
      ].join('\n'),
      keyboard: kb,
    }
  }

  const cats = await listRootCategories().catch(() => [])
  const gift = text ? GIFT_INTENT_RE.test(text) : false
  const lines: string[] = []
  if (gift) {
    lines.push(
      'چه خوب! برای انتخاب هدیهٔ مناسب کوتاه راهنمایی‌ام کنید 😊',
      '',
      '۱️⃣ دقیقاً برای چه کسی می‌خواهید؟ (مادر، همسر، …)',
      '۲️⃣ حدود بودجه‌تان چقدر است؟',
    )
  } else {
    lines.push(
      'برای اینکه بهترین پیشنهاد را به شما بدهم، لطفاً کوتاه راهنمایی‌ام کنید 😊',
      '',
      '۱️⃣ برای خودتان می‌خواهید یا برای هدیه؟',
      '۲️⃣ حدود بودجه‌تان چقدر است؟',
    )
  }
  if (cats.length > 0) {
    lines.push('', 'یا مستقیم یکی از دسته‌ها را انتخاب کنید تا گزینه‌هایش را ببینید 👇')
  }
  const replyText = lines.join('\n')
  if (cats.length === 0) {
    return { text: replyText, keyboard: MAIN_MENU }
  }
  const kb: InlineButton[][] = [...categoryKeyboardRows(cats), HOME_ROW]
  return { text: replyText, keyboard: kb }
}

/**
 * Category page — works for BOTH main and sub categories:
 *  - subcategories of this category (if any) pair 2-per-row ABOVE the products
 *    (same RTL pairing rule as the products menu — owner-approved layout);
 *  - products assigned DIRECTLY to this category are listed below them;
 *  - «بازگشت» returns to the parent category page for subs, or to the
 *    products menu for main categories;
 *  - 🔥 آفرهای هفتگی stays smart: it always lists live-discounted products
 *    across the whole shop and never holds subcategories.
 */
async function categoryPageReply(catId: string, page: number): Promise<Reply> {
  const cat = await getCategory(catId)
  if (!cat) {
    return { text: 'این دسته یافت نشد.', keyboard: MAIN_MENU }
  }
  // 🔥 آفرهای هفتگی — smart category: ALWAYS lists live-discounted products
  // (compareAtPrice > price) across the whole shop, never a manual assignment.
  const isOffers = cat.slug === 'weekly-offers'
  const subs = isOffers ? [] : await listChildCategories(catId)
  const listing = isOffers
    ? listActiveDiscountedProducts(page, PRODUCTS_PER_PAGE)
    : listActiveProductsByCategory(catId, page, PRODUCTS_PER_PAGE)
  const { items, total } = await listing
  // Back target: the parent category page for subs, products menu for mains.
  const backRow: InlineButton[] = [
    { text: '⬅️ بازگشت', callback_data: cat.parentId ? `cat:${cat.parentId}` : 'back:products' },
  ]
  if (subs.length === 0 && items.length === 0) {
    return {
      text: `دسته: ${escapeHtml(cat.name)}\n\nمحصولی در این دسته موجود نیست.`,
      keyboard: [backRow, HOME_ROW],
    }
  }
  const totalPages = Math.max(1, Math.ceil(total / PRODUCTS_PER_PAGE))
  const kb: InlineButton[][] = []
  const textParts: string[] = [`دسته: ${escapeHtml(cat.name)}`]
  if (subs.length > 0) {
    textParts.push('زیر‌مجموعهٔ موردنظر را انتخاب کنید:')
    kb.push(...categoryKeyboardRows(subs))
  }
  if (items.length > 0) {
    if (subs.length > 0) textParts.push('محصولات این دسته:')
    textParts.push(`صفحه ${formatNumber(page)} از ${formatNumber(totalPages)}`)
    kb.push(...items.map((p) => [{ text: productButtonLabel(p), callback_data: `prod:${p.id}` }]))
    const navRow: InlineButton[] = []
    if (page > 1) navRow.push({ text: '◀️', callback_data: `page:${catId}:${page - 1}` })
    if (page < totalPages) navRow.push({ text: '▶️', callback_data: `page:${catId}:${page + 1}` })
    if (navRow.length > 0) kb.push(navRow)
  }
  kb.push(backRow, HOME_ROW)
  return { text: textParts.join('\n\n'), keyboard: kb }
}

// ─── Product cards ───────────────────────────────────────────────────────────

type ProductFull = NonNullable<Awaited<ReturnType<typeof getProduct>>>

/** Silver spec lines — only shown when the admin actually filled them in. */
function specLines(p: ProductFull): string[] {
  const lines: string[] = []
  if (p.productCode) lines.push(`🔖 کد محصول: ${escapeHtml(p.productCode)}`)
  if (p.fineness) lines.push(`✨ عیار: ${formatNumber(p.fineness)}`)
  if (p.weightGrams) lines.push(`⚖️ وزن: ${formatWeight(p.weightGrams)}`)
  if (p.size) lines.push(`📏 سایز: ${escapeHtml(p.size)}`)
  if (p.silverType) lines.push(`🪙 نوع نقره: ${escapeHtml(p.silverType)}`)
  return lines
}

/** Persian photo caption (≤1000 chars) — price is ALWAYS the stored `price`. */
function productCaption(p: ProductFull): string {
  const head = `🛍️ <b>${escapeHtml(p.name)}</b>`
  const priceLines = [
    `💰 قیمت: <b>${formatMoney(p.price)}</b>`,
    ...(p.compareAtPrice && p.compareAtPrice > p.price
      ? [`🏷️ قبلاً: <s>${formatMoney(p.compareAtPrice)}</s>`]
      : []),
    '',
    stockLine(p),
  ]
  const specs = specLines(p)
  let caption = [
    head,
    '',
    p.shortDescription ? escapeHtml(truncate(p.shortDescription, 300)) : '',
    '',
    ...priceLines,
    ...(specs.length > 0 ? ['', ...specs] : []),
  ]
    .filter((l) => l !== '')
    .join('\n')
  if (caption.length > PHOTO_CAPTION_MAX) {
    caption = [head, '', ...priceLines, ...(specs.length > 0 ? ['', ...specs] : [])].join('\n')
  }
  if (caption.length > PHOTO_CAPTION_MAX) {
    caption = `${caption.slice(0, PHOTO_CAPTION_MAX - 1)}…`
  }
  return caption
}

function productCardKeyboard(p: ProductFull, includeMore: boolean): InlineButton[][] {
  const kb: InlineButton[][] = []
  if (p.stock > 0) kb.push([{ text: '🛒 ثبت سفارش', callback_data: `order:${p.id}` }])
  if (includeMore && p.images.length > 1) {
    kb.push([{ text: '📸 تصاویر بیشتر', callback_data: `moreimgs:${p.id}` }])
  }
  // Back returns to the product's OWN category page (sub or main) so browsing
  // flows stay in place; products without a category fall back to the menu.
  const backCb = p.categoryId ? `cat:${p.categoryId}` : 'back:products'
  kb.push([{ text: '⬅️ بازگشت', callback_data: backCb }])
  return kb
}

/** Full text card (fallback when no photo is available). */
function textProductCard(p: ProductFull): string {
  const lines: string[] = [`🛍️ <b>${escapeHtml(p.name)}</b>`]
  if (p.shortDescription) lines.push('', escapeHtml(p.shortDescription))
  lines.push('', `💰 قیمت: <b>${formatMoney(p.price)}</b>`)
  if (p.compareAtPrice && p.compareAtPrice > p.price) {
    lines.push(`🏷️ قبلاً: <s>${formatMoney(p.compareAtPrice)}</s>`)
  }
  lines.push('', stockLine(p))
  const specs = specLines(p)
  if (specs.length > 0) lines.push('', ...specs)
  if (p.description) lines.push('', escapeHtml(truncate(p.description, 700)))
  return lines.join('\n')
}

/** Product card: photo (when resolvable) + Persian caption, else rich text card. */
async function productCardReply(
  productId: string,
  notFoundKeyboard: InlineButton[][] = MAIN_MENU,
): Promise<Reply[]> {
  const p = await getProduct(productId)
  if (!p || p.status !== 'active') {
    return [{ text: 'این محصول یافت نشد یا فعال نیست.', keyboard: notFoundKeyboard }]
  }
  const primaryUrl = p.images[0]?.url ?? p.imageUrl
  const photo = await resolvePhotoSource(primaryUrl)
  if (photo) {
    return [{ text: productCaption(p), keyboard: productCardKeyboard(p, true), photo }]
  }
  return [{ text: textProductCard(p), keyboard: productCardKeyboard(p, p.images.length > 1) }]
}

/** Remaining gallery photos (≤4) — "تصویر N از M — <name>". */
async function moreImagesReply(productId: string): Promise<Reply[]> {
  const p = await getProduct(productId)
  if (!p || p.status !== 'active') {
    return [{ text: 'این محصول یافت نشد یا فعال نیست.', keyboard: MAIN_MENU }]
  }
  if (p.images.length <= 1) {
    return [
      { text: 'تصویر بیشتری برای این محصول ثبت نشده است.', keyboard: productCardKeyboard(p, false) },
    ]
  }
  const rest = p.images.slice(1, 1 + EXTRA_PHOTOS_MAX)
  const total = p.images.length
  const out: Reply[] = []
  for (let i = 0; i < rest.length; i++) {
    const idx = i + 2 // image 1 was the card photo
    const caption = [
      `📸 تصویر ${formatNumber(idx)} از ${formatNumber(total)} — ${escapeHtml(p.name)}`,
      '',
      `💰 قیمت: <b>${formatMoney(p.price)}</b>`,
      stockLine(p),
    ].join('\n')
    const photo = await resolvePhotoSource(rest[i].url)
    if (photo) out.push({ text: caption, keyboard: productCardKeyboard(p, false), photo })
  }
  if (out.length === 0) {
    return [
      { text: 'متأسفانه نمایش تصاویر بیشتر ممکن نشد.', keyboard: productCardKeyboard(p, false) },
    ]
  }
  return out
}

/** Compact card used after AI replies (short caption + order button). */
async function miniProductCardReply(productId: string): Promise<Reply | null> {
  const p = await getProduct(productId)
  if (!p || p.status !== 'active') return null
  const text = [
    `🛍️ <b>${escapeHtml(p.name)}</b>`,
    `💰 قیمت: <b>${formatMoney(p.price)}</b>`,
    stockLine(p),
  ].join('\n')
  const kb: InlineButton[][] = []
  if (p.stock > 0) kb.push([{ text: '🛒 ثبت سفارش', callback_data: `order:${p.id}` }])
  kb.push(HOME_ROW)
  const photo = p.images[0] ? await resolvePhotoSource(p.images[0].url) : null
  return { text, keyboard: kb, photo: photo ?? undefined }
}

async function myOrdersReply(telegramUserId: string): Promise<Reply> {
  const customer = await db.customer.findUnique({ where: { telegramUserId } })
  const orders = customer
    ? await db.order.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      })
    : []
  if (orders.length === 0) {
    return {
      text: 'هنوز سفارشی ثبت نکرده‌اید.',
      keyboard: [[{ text: '🛍 محصولات', callback_data: 'menu:products' }]],
    }
  }
  const lines = orders.map((o) => {
    const s = orderStatusFa(o.status)
    return `#${o.orderNumber} — ${s.emoji} ${s.label} — ${formatMoney(o.total)}`
  })
  return {
    text: `📦 سفارش‌های اخیر شما:\n\n${lines.join('\n')}`,
    keyboard: [[{ text: '🛍 محصولات', callback_data: 'menu:products' }], HOME_ROW],
  }
}

async function supportReply(platform: Platform = 'telegram'): Promise<Reply> {
  const settings = await getStoreSettings()
  const kb: InlineButton[][] = []
  if (settings.supportUsername) {
    // same support handle on both messengers, platform-correct deep link
    const base = platform === 'bale' ? 'https://ble.ir' : 'https://t.me'
    kb.push([{ text: '💬 گفتگو با پشتیبانی', url: `${base}/${settings.supportUsername}` }])
  }
  kb.push(HOME_ROW)
  return {
    text: '📞 ارتباط با فروشگاه\n\nسؤال، درخواست یا مشکلی دارید؟ همکاران ما در سریع‌ترین زمان پاسخگوی شما هستند.',
    keyboard: kb,
  }
}

/** About the store — includes the latest registered daily silver rate (real DB data). */
async function aboutReply(): Promise<Reply> {
  const settings = await getStoreSettings()
  const rate = await db.silverRate.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } })
  const lines = [
    `ℹ️ درباره ${escapeHtml(settings.storeName)}`,
    '',
    settings.storeDescription
      ? escapeHtml(settings.storeDescription)
      : 'فروشگاه تخصصی نقره — نقره اصل با ضمانت اصالت',
  ]
  if (rate) {
    lines.push(
      '',
      '━━━━━━━━━━━━━━',
      '📊 نرخ روز نقره',
      `💎 هر گرم نقره: ${formatMoney(rate.ratePerGram)}`,
    )
  }
  lines.push('', 'برای مشاوره خرید، سؤال خود را مستقیم بنویسید ✨')
  return { text: lines.join('\n'), keyboard: MAIN_MENU }
}

async function searchResultsReply(query: string): Promise<Reply[]> {
  const results = await searchActiveProducts(query, 8)
  if (results.length === 0) {
    return [
      {
        text: 'محصولی یافت نشد. عبارت دیگری را امتحان کنید.',
        keyboard: [[{ text: '🔎 جستجوی مجدد', callback_data: 'menu:search' }], HOME_ROW],
      },
    ]
  }
  const kb: InlineButton[][] = results.map((p) => [
    { text: productButtonLabel(p), callback_data: `prod:${p.id}` },
  ])
  kb.push([{ text: '🔎 جستجوی مجدد', callback_data: 'menu:search' }], HOME_ROW)
  return [
    {
      text: `🔎 نتایج جستجو برای «${escapeHtml(query.trim())}»:`,
      keyboard: kb,
    },
  ]
}

async function orderSummaryReply(state: BotState): Promise<Reply[]> {
  const p = state.productId ? await getProduct(state.productId) : null
  if (!p) return [{ text: 'سفارشی برای نمایش یافت نشد.', keyboard: MAIN_MENU }]
  const qty = state.quantity ?? 1
  const text = [
    '🧾 خلاصه سفارش',
    '',
    `🛍 محصول: ${escapeHtml(p.name)}`,
    `🔢 تعداد: ${formatNumber(qty)}`,
    `💰 قیمت واحد: ${formatMoney(p.price)}`,
    `💳 مبلغ کل: ${formatMoney(p.price * qty)}`,
    '',
    `👤 نام: ${escapeHtml(state.name ?? '')}`,
    `📱 موبایل: ${state.phone ?? ''}`,
    `📍 آدرس: ${escapeHtml(state.address ?? '')}`,
  ].join('\n')
  return [
    {
      text,
      keyboard: [
        [{ text: '✅ تأیید سفارش', callback_data: 'order:confirm' }],
        [{ text: '❌ لغو سفارش', callback_data: 'order:cancel' }],
      ],
    },
  ]
}

// ─── Manual payment (card-to-card) flow ──────────────────────────────────────

const RECEIPT_ACCEPTED_STATUSES = ['awaiting_payment', 'rejected', 'payment_review']

/** Payment info message shown right after the order is created. */
async function paymentInfoReply(order: {
  id: string
  orderNumber: number
  total: number
}): Promise<Reply[]> {
  const dests = await getActivePaymentDestinations()
  const lines: string[] = [
    `✅ سفارش شما با شماره #${formatNumber(order.orderNumber)} ثبت شد!`,
    '',
    `💳 مبلغ قابل پرداخت: <b>${formatMoney(order.total)}</b>`,
  ]
  if (dests.length > 0) {
    lines.push('', '🏦 اطلاعات پرداخت (کارت به کارت):', '')
    dests.forEach((d, i) => {
      if (i > 0) lines.push('〰️〰️〰️〰️〰️')
      lines.push(`🏦 بانک ${escapeHtml(d.bankName)}`)
      lines.push(`💳 شماره کارت: <code>${escapeHtml(d.cardNumber)}</code>`)
      lines.push(`👤 به نام: ${escapeHtml(d.accountHolder)}`)
      if (d.sheba) lines.push(`🏷️ شبا: <code>${escapeHtml(d.sheba)}</code>`)
      if (d.note) lines.push(`📝 ${escapeHtml(d.note)}`)
    })
    lines.push('', 'پس از واریز، تصویر رسید را در همین چت ارسال کنید ⬇️')
  } else {
    lines.push(
      '',
      'در حال حاضر اطلاعات کارت پرداخت ثبت نشده است؛ همکاران ما به‌زودی برای هماهنگی پرداخت با شما تماس می‌گیرند. 🙏',
    )
  }
  return [
    {
      text: lines.join('\n'),
      keyboard: [
        [{ text: '📨 ارسال رسید', callback_data: `receipt:${order.id}` }],
        HOME_ROW,
      ],
    },
  ]
}

/** `receipt:<orderId>` — validate ownership & payment status, then arm the flow. */
async function startReceiptFlow(telegramUserId: string, orderId: string): Promise<Reply[]> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { customer: { select: { telegramUserId: true } } },
  })
  if (!order || order.customer.telegramUserId !== telegramUserId) {
    return [{ text: 'سفارشی برای این رسید یافت نشد.', keyboard: MAIN_MENU }]
  }
  if (order.paymentStatus === 'paid') {
    return [
      { text: '✅ پرداخت این سفارش قبلاً تأیید شده است؛ نیازی به ارسال رسید نیست.', keyboard: MAIN_MENU },
    ]
  }
  if (!RECEIPT_ACCEPTED_STATUSES.includes(order.paymentStatus) || order.status === 'cancelled') {
    return [
      { text: 'در حال حاضر امکان ارسال رسید برای این سفارش وجود ندارد.', keyboard: MAIN_MENU },
    ]
  }
  await saveSession(telegramUserId, { flow: 'await_receipt', orderId: order.id })
  const note =
    order.paymentStatus === 'rejected'
      ? '\n\n(رسید قبلی این سفارش تأیید نشده بود — لطفاً تصویر رسید جدید را ارسال کنید.)'
      : ''
  return [{ text: `لطفاً تصویر رسید واریز را ارسال کنید 📎${note}`, keyboard: [HOME_ROW] }]
}

/** Latest order that can still receive a receipt photo (for photo-outside-flow guidance). */
async function latestReceiptableOrder(customerId: string) {
  const rows = await db.order.findMany({
    where: {
      customerId,
      status: { not: 'cancelled' },
      paymentStatus: { in: RECEIPT_ACCEPTED_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { id: true, orderNumber: true },
  })
  return rows[0] ?? null
}

async function handlePhotoMessage(
  telegramUserId: string,
  input: UpdateInput,
  state: BotState,
): Promise<Reply[]> {
  const photo = input.photo
  if (!photo?.fileId) return []

  if (state.flow === 'await_receipt' && state.orderId) {
    return receiptUploadFlow(telegramUserId, state, photo, input.platform)
  }

  // Photo outside the receipt flow → guide the customer to the right place
  const customer = await db.customer.findUnique({
    where: { telegramUserId },
    select: { id: true },
  })
  const pending = customer ? await latestReceiptableOrder(customer.id) : null
  const kb: InlineButton[][] = []
  if (pending) {
    kb.push([
      {
        text: `📨 ارسال رسید برای سفارش #${formatNumber(pending.orderNumber)}`,
        callback_data: `receipt:${pending.id}`,
      },
    ])
  }
  kb.push(HOME_ROW)
  return [
    {
      text: '📸 تصویر شما دریافت شد!\n\nبرای ثبت پرداخت، ابتدا سفارش خود را ثبت کنید یا دکمه زیر را بزنید و سپس تصویر رسید واریز را بفرستید.',
      keyboard: kb,
    },
  ]
}

async function receiptUploadFlow(
  telegramUserId: string,
  state: BotState,
  photo: { fileId: string; caption?: string },
  platform: Platform = 'telegram',
): Promise<Reply[]> {
  const order = await db.order.findUnique({
    where: { id: state.orderId },
    include: { customer: { select: { telegramUserId: true, firstName: true } } },
  })
  if (!order || order.customer.telegramUserId !== telegramUserId) {
    await clearFlow(telegramUserId)
    return [{ text: 'سفارش موردنظر یافت نشد. از منوی اصلی شروع کنید:', keyboard: MAIN_MENU }]
  }
  if (order.status === 'cancelled') {
    await clearFlow(telegramUserId)
    return [
      { text: 'این سفارش لغو شده است؛ امکان ارسال رسید برای آن وجود ندارد.', keyboard: MAIN_MENU },
    ]
  }
  if (order.paymentStatus === 'paid') {
    await clearFlow(telegramUserId)
    return [
      { text: '✅ پرداخت این سفارش قبلاً تأیید شده است؛ نیازی به ارسال رسید نیست.', keyboard: MAIN_MENU },
    ]
  }
  if (!RECEIPT_ACCEPTED_STATUSES.includes(order.paymentStatus)) {
    await clearFlow(telegramUserId)
    return [
      { text: 'در حال حاضر امکان دریافت رسید برای این سفارش وجود ندارد.', keyboard: MAIN_MENU },
    ]
  }

  // 1. download the photo from the platform it arrived on
  const info = await getFileInfo(platform, photo.fileId)
  const filePath =
    info.ok && info.result && typeof (info.result as { file_path?: unknown }).file_path === 'string'
      ? (info.result as { file_path: string }).file_path
      : null
  if (!filePath) {
    return [
      { text: 'متأسفانه دریافت فایل تصویر ممکن نشد. لطفاً یک بار دیگر تصویر رسید را ارسال کنید. 🙏' },
    ]
  }
  const dl = await downloadFile(platform, filePath)
  if (!dl.ok || !dl.buffer) {
    return [
      { text: 'متأسفانه دریافت تصویر ممکن نشد. لطفاً یک بار دیگر تصویر رسید را ارسال کنید. 🙏' },
    ]
  }

  // 2. store the file + Payment row + order paymentStatus (never downgrade 'paid')
  const receiptUrl = await saveReceiptFile(dl.buffer)
  if (!receiptUrl) {
    return [{ text: 'متأسفانه در ذخیره تصویر خطایی رخ داد. لطفاً کمی بعد دوباره تلاش کنید. 🙏' }]
  }
  try {
    await db.payment.create({
      data: {
        orderId: order.id,
        amount: order.total,
        receiptUrl,
        payerName: order.customer.firstName,
        customerNote: photo.caption?.trim() || null,
        status: 'awaiting_review',
      },
    })
    if (['awaiting_payment', 'rejected'].includes(order.paymentStatus)) {
      await db.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'payment_review' },
      })
    }
    await db.activityLog.create({
      data: {
        level: 'info',
        type: 'payment.received',
        message: `رسید پرداخت سفارش #${order.orderNumber} از طریق ربات دریافت شد`,
        data: JSON.stringify({
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: order.total,
          receiptUrl,
          telegramUserId,
        }),
      },
    })
  } catch (e) {
    console.error('[bot-service] receipt persistence failed:', e)
    return [
      { text: 'متأسفانه در ثبت رسید خطایی رخ داد. لطفاً یک بار دیگر تصویر رسید را ارسال کنید. 🙏' },
    ]
  }

  // 3. notify the admin chat(s) — every connected platform, best-effort
  try {
    await notifyAdmin(
      `📩 رسید سفارش #${formatNumber(order.orderNumber)} دریافت شد؛ در پنل مدیریت بررسی کنید.`,
    )
  } catch {
    // best-effort
  }

  await clearFlow(telegramUserId)
  return [
    {
      text: '✅ رسید شما دریافت شد و در انتظار بررسی مدیر است.\n\nارسال رسید به معنی تأیید پرداخت نیست؛ نتیجه بررسی از همین‌جا به شما اطلاع داده می‌شود. 🙏',
      keyboard: MAIN_MENU,
    },
  ]
}

// ─── AI assistant (internal API) + deterministic fallback ────────────────────

type AiAnswer = { reply: string; productIds: string[]; toolsUsed: string[] }

/**
 * INTERNAL_API_KEY — the bot process is usually started from its own folder
 * (mini-services/bot-service), so Bun's auto-.env loading never sees the root
 * .env. Fall back to parsing the root .env once when the env var is missing.
 */
let cachedInternalKey: string | null | undefined
async function resolveInternalApiKey(): Promise<string | null> {
  if (cachedInternalKey !== undefined) return cachedInternalKey
  const envKey = (process.env.INTERNAL_API_KEY ?? '').trim()
  if (envKey) {
    cachedInternalKey = envKey
    return cachedInternalKey
  }
  try {
    const raw = await readFile(path.join(PROJECT_ROOT, '.env'), 'utf8')
    const m = raw.match(/^INTERNAL_API_KEY=(.*)$/m)
    cachedInternalKey = m ? m[1].trim().replace(/^["']|["']$/g, '') || null : null
    if (cachedInternalKey) return cachedInternalKey
  } catch {
    // no .env — fall through to the DB copy
  }
  // Last resort: the seed provisions a durable copy in the Setting table
  // (start.sh rewrites .env on every sandbox boot, so the DB row is the
  // reboot-proof source of truth).
  try {
    const row = await db.setting.findUnique({ where: { key: 'internalApiKey' } })
    cachedInternalKey = row?.value?.trim() || null
  } catch {
    cachedInternalKey = null
  }
  return cachedInternalKey
}

/** max AI messages per telegram user per minute (sliding window, in-memory) */
const AI_RATE_LIMIT_PER_MIN = 10
const aiCalls = new Map<string, number[]>()

function aiRateLimited(telegramUserId: string): boolean {
  const now = Date.now()
  const window = (aiCalls.get(telegramUserId) ?? []).filter((t) => now - t < 60_000)
  if (window.length >= AI_RATE_LIMIT_PER_MIN) {
    aiCalls.set(telegramUserId, window)
    return true
  }
  window.push(now)
  aiCalls.set(telegramUserId, window)
  return false
}

async function askAiAssistant(
  telegramUserId: string,
  message: string,
  firstName?: string,
): Promise<AiAnswer | null> {
  const key = await resolveInternalApiKey()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch('http://127.0.0.1:3000/api/internal/ai-assistant', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'x-internal-key': key } : {}),
      },
      body: JSON.stringify({ telegramUserId, message, firstName }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as
      | { reply?: unknown; productIds?: unknown; toolsUsed?: unknown }
      | null
    const reply = typeof data?.reply === 'string' && data.reply.trim() ? data.reply.trim() : null
    if (!reply) return null
    const productIds = Array.isArray(data?.productIds)
      ? data.productIds.filter((v): v is string => typeof v === 'string').slice(0, 3)
      : []
    const toolsUsed = Array.isArray(data?.toolsUsed)
      ? data.toolsUsed.filter((v): v is string => typeof v === 'string')
      : []
    return { reply, productIds, toolsUsed }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const OPERATOR_REFERRAL =
  'درخواست شما به همکاران ما ارجاع شد — به‌زودی همکار ما ادامه مکالمه را پیگیری می‌کند 🙏'

/** Free text outside any flow → AI assistant (+photo cards); on failure → search. */
async function freeTextReply(
  telegramUserId: string,
  text: string,
  firstName?: string,
): Promise<Reply[]> {
  if (aiRateLimited(telegramUserId)) {
    return [
      { text: 'کمی آرام‌تر 🙏 لطفاً چند لحظه صبر کنید و دوباره بنویسید.', keyboard: [HOME_ROW] },
    ]
  }

  // Broad discovery («چیا دارید؟») → consult-first: never blast product cards
  // for an open question; the assistant asks which category/occasion/budget.
  // Cards appear once the customer narrows down (category/taste/budget).
  const broadDiscovery = isBroadDiscoveryQuery(text)

  const ai = await askAiAssistant(telegramUserId, text, firstName)
  if (ai) {
    const out: Reply[] = [{ text: aiReplyToTelegramHtml(ai.reply) }]
    if (ai.toolsUsed.includes('request_operator') && !ai.reply.includes('همکار')) {
      out.push({ text: OPERATOR_REFERRAL })
    }
    if (!broadDiscovery) {
      for (const pid of ai.productIds) {
        const card = await miniProductCardReply(pid).catch(() => null)
        if (card) out.push(card)
      }
    }
    return out
  }

  // Deterministic fallback keeps the bot useful before/without the AI service:
  // ALWAYS consultative (needs-assessment questions + category quick-pick) —
  // never an apologetic "the assistant could not answer" message, and never a
  // product blast. The customer narrows down; cards appear from that point on.
  const small = classifySmallTalk(text)
  if (small) {
    return [{ text: smallTalkReplyFa(small, firstName), keyboard: [HOME_ROW] }]
  }
  return [await consultCategoriesReply(text)]
}

// ─── Text handling (flows + commands) ────────────────────────────────────────

async function handleText(
  telegramUserId: string,
  input: UpdateInput,
  state: BotState,
): Promise<Reply[]> {
  const text = (input.text ?? '').trim()
  if (!text) return []

  // commands always take precedence
  if (text.startsWith('/')) {
    const [cmdRaw, param] = text.split(/\s+/, 2)
    const cmd = (cmdRaw || '').split('@', 1)[0]
    if (cmd === '/start') {
      await clearFlow(telegramUserId)
      if (param && param.startsWith('product_')) {
        // deep link from a channel post
        return productCardReply(param.slice('product_'.length), MAIN_MENU)
      }
      if (param === 'ai_consult') {
        // deep link from the «مشاوره هوشمند» channel-post button
        return [
          {
            text: '✨ مشاوره خرید با دستیار هوشمند\n\nهر چه در ذهن دارید بنویسید — مثلاً بودجه‌تان، مدل موردعلاقه یا مناسب بودن برای هدیه. دستیار ما بهترین گزینه‌های موجود را پیشنهاد می‌دهد 💎',
            keyboard: [HOME_ROW],
          },
        ]
      }
      const settings = await getStoreSettings()
      // Dynamic welcome — the seller edits this template from the panel
      // (Setting «welcomeMessage»); {name}/{store} are substituted per customer.
      const welcome = escapeHtml(
        buildWelcomeMessage(settings.welcomeMessage, {
          name: input.firstName,
          store: settings.storeName,
        }),
      )
      return [{ text: welcome }]
    }
    // / commands — same views as the bottom keyboard (photo 2-3 order)
    if (cmd === '/menu') {
      await clearFlow(telegramUserId)
      return [mainMenuReply()]
    }
    if (cmd === '/products') {
      await clearFlow(telegramUserId)
      return [await categoriesReply()]
    }
    if (cmd === '/cart') {
      await clearFlow(telegramUserId)
      return [cartReply()]
    }
    if (cmd === '/orders') {
      await clearFlow(telegramUserId)
      return [await myOrdersReply(telegramUserId)]
    }
    if (cmd === '/faq') {
      await clearFlow(telegramUserId)
      return [faqReply()]
    }
    if (cmd === '/support') {
      await clearFlow(telegramUserId)
      return [await supportReply(input.platform)]
    }
    return [mainMenuReply('دستور شناخته‌شده نیست. از منوی زیر استفاده کنید:')]
  }

  // Bottom-keyboard buttons work from ANY state (they cancel active flows) —
  // they submit their label as a normal message, matched exactly here.
  if (BOTTOM_BUTTONS.has(text)) {
    await clearFlow(telegramUserId)
    switch (text) {
      case '🛍 محصولات':
        return [await categoriesReply()]
      case '🛒 سبد خرید':
        return [cartReply()]
      case '📦 سفارش‌های من':
        return [await myOrdersReply(telegramUserId)]
      case '💬 گفتگو با فروشنده':
        return [aiConsultIntro()]
      case '❓ سوالات متداول':
        return [faqReply()]
    }
  }

  switch (state.flow) {
    case 'await_quantity':
      return handleQuantityStep(telegramUserId, state, text)
    case 'await_name':
      return handleNameStep(telegramUserId, state, text)
    case 'await_phone':
      return handlePhoneStep(telegramUserId, state, text)
    case 'await_address':
      return handleAddressStep(telegramUserId, state, text)
    case 'await_confirm':
      return [
        ...orderSummaryReminder(),
        ...(await orderSummaryReply(state)),
      ]
    case 'await_search':
      await clearFlow(telegramUserId)
      return searchResultsReply(text)
    case 'await_receipt':
      return receiptFlowText(telegramUserId, text)
    default:
      return freeTextReply(telegramUserId, text, input.firstName)
  }
}

/** Text while awaiting a receipt photo — accept cancel, otherwise re-prompt. */
async function receiptFlowText(telegramUserId: string, text: string): Promise<Reply[]> {
  if (text === 'انصراف' || text === 'لغو') {
    await clearFlow(telegramUserId)
    return [mainMenuReply('انصراف داده شد. از منوی زیر انتخاب کنید:')]
  }
  return [
    {
      text: 'لطفاً تصویر رسید واریز را ارسال کنید 📎\n\nاگر هنوز واریز نکرده‌اید، ابتدا مبلغ سفارش را به کارت اعلام‌شده واریز کنید.',
      keyboard: [HOME_ROW],
    },
  ]
}

function orderSummaryReminder(): Reply[] {
  return [
    {
      text: 'لطفاً برای تأیید یا لغو سفارش از دکمه‌های زیر استفاده کنید:',
    },
  ]
}

async function handleQuantityStep(
  telegramUserId: string,
  state: BotState,
  text: string,
): Promise<Reply[]> {
  const cleaned = toLatinDigits(text).replace(/[,\s]/g, '')
  const m = cleaned.match(/\d+/)
  const qty = m ? parseInt(m[0], 10) : NaN
  if (!m || !Number.isFinite(qty) || qty < 1) {
    return [{ text: 'لطفاً یک عدد صحیح بزرگ‌تر از صفر بفرستید.\n\nچند عدد می‌خواهید؟' }]
  }

  // re-fetch — stock may have changed while chatting
  const p = state.productId ? await getProduct(state.productId) : null
  if (!p || p.status !== 'active') {
    await clearFlow(telegramUserId)
    return [{ text: 'این محصول یافت نشد یا فعال نیست.', keyboard: MAIN_MENU }]
  }
  if (qty > p.stock) {
    // stay in step
    return [{ text: `متأسفانه فقط ${formatNumber(p.stock)} عدد موجود است.` }]
  }

  await saveSession(telegramUserId, { ...state, flow: 'await_name', quantity: qty })
  return [{ text: 'نام و نام خانوادگی؟' }]
}

async function handleNameStep(
  telegramUserId: string,
  state: BotState,
  text: string,
): Promise<Reply[]> {
  const name = text.trim()
  if (name.length < 3) {
    return [{ text: 'لطفاً نام و نام خانوادگی کامل وارد کنید (حداقل ۳ حرف):' }]
  }
  await saveSession(telegramUserId, { ...state, flow: 'await_phone', name })
  return [{ text: 'شماره موبایل؟' }]
}

async function handlePhoneStep(
  telegramUserId: string,
  state: BotState,
  text: string,
): Promise<Reply[]> {
  const phone = normalizePhone(text)
  if (!phone) {
    return [
      { text: 'شماره موبایل معتبر نیست. مثال: 09123456789' },
    ]
  }
  await saveSession(telegramUserId, { ...state, flow: 'await_address', phone })
  return [{ text: 'آدرس کامل؟' }]
}

async function handleAddressStep(
  telegramUserId: string,
  state: BotState,
  text: string,
): Promise<Reply[]> {
  const address = text.trim()
  if (address.length < 10) {
    return [{ text: 'آدرس وارد شده کوتاه است. لطفاً آدرس کامل (شهر، خیابان، پلاک و کد پستی) را وارد کنید:' }]
  }
  await saveSession(telegramUserId, { ...state, flow: 'await_confirm', address })
  return orderSummaryReply({ ...state, flow: 'await_confirm', address })
}

// ─── Callback handling ───────────────────────────────────────────────────────

async function handleCallback(
  telegramUserId: string,
  input: UpdateInput,
  state: BotState,
): Promise<Reply[]> {
  const cb = input.callbackData ?? ''

  if (cb === 'menu:main') {
    await clearFlow(telegramUserId)
    return [mainMenuReply()]
  }
  if (cb === 'back:products' || cb === 'menu:products') {
    await clearFlow(telegramUserId)
    return [await categoriesReply()]
  }
  if (cb === 'menu:orders') {
    await clearFlow(telegramUserId)
    return [await myOrdersReply(telegramUserId)]
  }
  if (cb === 'menu:search') {
    await saveSession(telegramUserId, { flow: 'await_search' })
    return [{ text: 'نام محصول را بنویسید:', keyboard: [HOME_ROW] }]
  }
  if (cb === 'menu:support') {
    await clearFlow(telegramUserId)
    return [await supportReply(input.platform)]
  }
  if (cb === 'menu:about') {
    await clearFlow(telegramUserId)
    return [await aboutReply()]
  }
  if (cb === 'menu:ai') {
    await clearFlow(telegramUserId)
    return [aiConsultIntro()]
  }
  if (cb.startsWith('cat:')) {
    await clearFlow(telegramUserId)
    return [await categoryPageReply(cb.slice('cat:'.length), 1)]
  }
  if (cb.startsWith('page:')) {
    await clearFlow(telegramUserId)
    const [, catId, pageRaw] = cb.split(':')
    const page = Math.max(1, parseInt(pageRaw, 10) || 1)
    return [await categoryPageReply(catId, page)]
  }
  if (cb.startsWith('prod:')) {
    await clearFlow(telegramUserId)
    return productCardReply(cb.slice('prod:'.length), [
      [{ text: '⬅️ بازگشت', callback_data: 'back:products' }],
      HOME_ROW,
    ])
  }
  if (cb.startsWith('moreimgs:')) {
    await clearFlow(telegramUserId)
    return moreImagesReply(cb.slice('moreimgs:'.length))
  }
  if (cb === 'order:confirm') {
    return confirmOrderCallback(telegramUserId, input, state)
  }
  if (cb === 'order:cancel') {
    await clearFlow(telegramUserId)
    return [{ text: 'سفارش لغو شد.', keyboard: MAIN_MENU }]
  }
  if (cb.startsWith('order:')) {
    return startOrderFlow(telegramUserId, cb.slice('order:'.length))
  }
  if (cb.startsWith('receipt:')) {
    return startReceiptFlow(telegramUserId, cb.slice('receipt:'.length))
  }
  if (cb.startsWith('seller:confirm:') || cb.startsWith('seller:cancel:')) {
    return sellerStatusCallback(cb, telegramUserId, input.platform)
  }
  // unknown callback → main menu
  await clearFlow(telegramUserId)
  return [mainMenuReply()]
}

async function startOrderFlow(telegramUserId: string, productId: string): Promise<Reply[]> {
  const p = await getProduct(productId)
  if (!p || p.status !== 'active') {
    return [{ text: 'این محصول یافت نشد یا فعال نیست.', keyboard: MAIN_MENU }]
  }
  if (p.stock <= 0) {
    return [
      { text: 'متأسفانه این محصول ناموجود است.', keyboard: MAIN_MENU },
    ]
  }
  await saveSession(telegramUserId, { flow: 'await_quantity', productId: p.id })
  let text = 'چند عدد می‌خواهید؟'
  if (p.stock <= lowStockThreshold(p)) {
    text += `\n(فقط ${formatNumber(p.stock)} عدد باقی مانده)`
  }
  return [{ text, keyboard: [CANCEL_ORDER_ROW] }]
}

async function confirmOrderCallback(
  telegramUserId: string,
  input: UpdateInput,
  state: BotState,
): Promise<Reply[]> {
  if (
    !state.productId ||
    !state.quantity ||
    !state.name ||
    !state.phone ||
    !state.address
  ) {
    await clearFlow(telegramUserId)
    return [{ text: 'سفارشی برای تأیید یافت نشد. از منوی محصولات شروع کنید:', keyboard: MAIN_MENU }]
  }

  try {
    const order = await createOrder({
      customer: {
        telegramUserId,
        // real Telegram profile name stays on Customer; typed name is only a snapshot
        telegramFirstName: input.firstName ?? null,
        username: inputUsernameCache.get(telegramUserId) ?? null,
      },
      productId: state.productId,
      quantity: state.quantity,
      name: state.name,
      phone: state.phone,
      address: state.address,
    })
    // straight into the manual payment flow
    await saveSession(telegramUserId, { flow: 'await_receipt', orderId: order.id })
    return paymentInfoReply({ id: order.id, orderNumber: order.orderNumber, total: order.total })
  } catch (e) {
    await clearFlow(telegramUserId)
    if (e instanceof InsufficientStockError) {
      let available = e.available
      if (available <= 0) {
        const p = await getProduct(state.productId).catch(() => null)
        available = p?.stock ?? 0
      }
      return [
        {
          text: `متأسفانه موجودی کافی نیست. موجودی فعلی: ${formatNumber(available)} عدد.`,
          keyboard: MAIN_MENU,
        },
      ]
    }
    if (e instanceof ProductUnavailableError) {
      return [{ text: 'این محصول یافت نشد یا فعال نیست.', keyboard: MAIN_MENU }]
    }
    throw e // caught by handleUpdate → generic error reply
  }
}

async function sellerStatusCallback(
  cb: string,
  telegramUserId: string,
  platform: Platform = 'telegram',
): Promise<Reply[]> {
  // cb = seller:confirm:<id> | seller:cancel:<id>
  // Admin-only: the callback must come from the configured admin chat id of
  // the platform the press arrived on (ids differ between Telegram and Bale).
  const cfg = await loadConfig(platform)
  const rawCaller = telegramUserId.replace(/^bale:/, '')
  const callerId = Number.parseInt(rawCaller, 10)
  const adminId = Number.parseInt(cfg.adminChatId, 10)
  if (!Number.isFinite(callerId) || !Number.isFinite(adminId) || callerId !== adminId) {
    return [] // silently ignore unauthorized presses
  }
  const parts = cb.split(':')
  const action = parts[1] // 'confirm' | 'cancel'
  const orderId = parts.slice(2).join(':')
  const status = action === 'confirm' ? 'confirmed' : 'cancelled'
  const res = await setOrderStatus(orderId, status)
  if (!res.ok || !res.order) {
    return [
      {
        text: res.error === 'order not found' ? '⚠️ سفارش یافت نشد.' : '⚠️ تغییر وضعیت سفارش ناموفق بود.',
      },
    ]
  }
  const n = res.order.orderNumber
  return [
    {
      text:
        status === 'confirmed'
          ? `✅ سفارش #${n} تأیید شد و به مشتری اطلاع‌رسانی شد.`
          : `🔴 سفارش #${n} لغو شد و موجودی محصولات بازگردانده شد.`,
    },
  ]
}

// small in-memory map so confirmOrderCallback can pass telegramUsername
const inputUsernameCache = new Map<string, string>()

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function handleUpdate(input: UpdateInput): Promise<Reply[]> {
  try {
    if (!input || typeof input.telegramUserId !== 'string' || !input.telegramUserId) {
      return [{ text: 'درخواست نامعتبر است.' }]
    }
    if (input.username) inputUsernameCache.set(input.telegramUserId, input.username)

    // Owner auto-discovery: when the store owner (telegram username matches,
    // case-insensitive) messages the bot, persist their chat id as the
    // platform's admin chat id. Feeds order notifications AND the daily
    // Telegram backup job — no manual chat-id setup, no getUpdates conflicts
    // with long-polling. Write only on change to avoid a DB write per message.
    const ownerUsername = (
      process.env.OWNER_TELEGRAM_USERNAME ?? 'amirhs_8311'
    ).toLowerCase()
    if (input.username && input.username.toLowerCase() === ownerUsername) {
      const platform = input.platform ?? 'telegram'
      const adminKey = platform === 'bale' ? 'baleAdminChatId' : 'telegramAdminChatId'
      try {
        const row = await db.setting.findUnique({ where: { key: adminKey } })
        if (row?.value !== input.telegramUserId) {
          await db.setting.upsert({
            where: { key: adminKey },
            create: { key: adminKey, value: input.telegramUserId },
            update: { value: input.telegramUserId },
          })
          console.log(
            `[bot-service] owner chat captured (@${input.username}, ${platform}) → ${adminKey}=${input.telegramUserId}`,
          )
        }
      } catch {
        // best-effort — never break message handling for this
      }
    }

    if (input.action === 'reset') {
      await clearFlow(input.telegramUserId)
      return [mainMenuReply('🔄 گفتگو بازنشانی شد. از منوی زیر انتخاب کنید:')]
    }

    const state = await loadSession(input.telegramUserId)
    let replies: Reply[]
    if (typeof input.callbackData === 'string' && input.callbackData) {
      replies = await handleCallback(input.telegramUserId, input, state)
    } else if (input.photo?.fileId) {
      replies = await handlePhotoMessage(input.telegramUserId, input, state)
    } else if (typeof input.text === 'string') {
      replies = await handleText(input.telegramUserId, input, state)
    } else {
      replies = [mainMenuReply()]
    }

    if (input.callbackId) {
      try {
        await answerCallback(input.platform ?? 'telegram', input.callbackId)
      } catch {
        // best-effort
      }
    }
    return replies
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[bot-service] handleUpdate error:', msg)
    try {
      await db.activityLog.create({
        data: {
          level: 'error',
          type: 'bot.error',
          message: 'خطا در پردازش آپدیت ربات',
          data: JSON.stringify({ error: msg, telegramUserId: input?.telegramUserId }),
        },
      })
    } catch {
      // ignore logging failure
    }
    return [{ text: 'متأسفانه خطایی رخ داد. لطفاً دوباره تلاش کنید.', keyboard: MAIN_MENU }]
  }
}
