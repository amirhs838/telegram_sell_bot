/**
 * PURE module — no external imports (imported cross-project by mini-services/bot-service
 * and by client components for previews). Renders Telegram channel posts.
 */

export type RenderProduct = {
  id: string
  name: string
  description?: string | null
  shortDescription?: string | null
  price: number
  compareAtPrice?: number | null
  stock: number
  lowStockThreshold?: number
  status: string // draft | active | inactive | out_of_stock
  imageUrl?: string | null
  // Silver Love optional specs (only rendered when filled — never invented)
  productCode?: string | null
  fineness?: number | null
  weightGrams?: number | null
  silverType?: string | null
  size?: string | null
  brand?: string | null
}

export type InlineButton = { text: string; callback_data?: string; url?: string }
export type PostContent = { text: string; keyboard: InlineButton[][] }

export function formatMoney(value: number, currency = 'تومان'): string {
  return `${Math.round(value).toLocaleString('fa-IR')} ${currency}`
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('fa-IR')
}

export function formatWeightFa(grams: number): string {
  return `${grams.toLocaleString('fa-IR', { maximumFractionDigits: 2 })} گرم`
}

/** Deep link that connects the channel post to the bot order flow. */
export function productDeepLink(botUsername: string, productId: string): string {
  return `https://t.me/${botUsername}?start=product_${productId}`
}

/** Deep link that opens the AI shopping-consultant entry point in the bot. */
export function aiConsultDeepLink(botUsername: string): string {
  return `https://t.me/${botUsername}?start=ai_consult`
}

const DIVIDER = '━━━━━━━━━━━━━━'

/**
 * Builds the Silver Love channel post (HTML parse mode) + inline keyboard.
 * Visual identity: ✨ brand header, thin dividers, ◽ spec lines, price focus.
 * Rules:
 *  - out of stock  → "🔴 ناموجود", order button removed
 *  - low stock     → "⚠️ فقط X عدد باقی مانده"
 *  - not active    → shown as unavailable, no order button
 */
export function renderProductPost(
  product: RenderProduct,
  botUsername: string,
  currency = 'تومان',
): PostContent {
  const lines: string[] = []
  lines.push(`✨ <b>SILVER LOVE</b> | انتخابی خاص`)
  lines.push('')
  lines.push(`💍 <b>${escapeHtml(product.name)}</b>`)
  if (product.shortDescription) {
    lines.push(escapeHtml(product.shortDescription))
  }

  // spec block — only real, admin-entered data (never invented)
  const specs: string[] = []
  if (product.fineness) specs.push(`◽ عیار: ${formatNumber(product.fineness)}`)
  if (product.weightGrams) specs.push(`◽ وزن: ${formatWeightFa(product.weightGrams)}`)
  if (product.silverType) specs.push(`◽ جنس: ${escapeHtml(product.silverType)}`)
  if (product.size) specs.push(`◽ سایز: ${escapeHtml(product.size)}`)
  if (product.productCode) specs.push(`◽ کد محصول: ${escapeHtml(product.productCode)}`)
  if (specs.length > 0) {
    lines.push(DIVIDER)
    lines.push(...specs)
  }

  lines.push(DIVIDER)
  lines.push(`💰 قیمت: <b>${formatMoney(product.price, currency)}</b>`)
  if (product.compareAtPrice && product.compareAtPrice > product.price) {
    lines.push(`🏷️ قبلاً: <s>${formatMoney(product.compareAtPrice, currency)}</s>`)
  }

  const isPurchasable = product.status === 'active' && product.stock > 0
  const threshold = product.lowStockThreshold ?? 5

  if (product.status !== 'active') {
    lines.push('⛔️ این محصول فعلاً غیرفعال است')
  } else if (product.stock <= 0) {
    lines.push('🔴 ناموجود')
  } else if (product.stock <= threshold) {
    lines.push(`⚠️ فقط ${formatNumber(product.stock)} عدد باقی مانده`)
  } else {
    lines.push(`📦 موجود: ${formatNumber(product.stock)} عدد`)
  }

  if (product.description) {
    lines.push(DIVIDER, '', escapeHtml(product.description))
  }

  lines.push('', 'برای مشاهده جزئیات و ثبت سفارش از دکمه‌های زیر استفاده کنید 👇')

  const keyboard: InlineButton[][] = []
  if (isPurchasable && botUsername) {
    keyboard.push([
      {
        text: '🛒 مشاهده و خرید',
        url: productDeepLink(botUsername, product.id),
      },
    ])
  }
  if (botUsername) {
    keyboard.push([
      {
        text: '💬 مشاوره هوشمند',
        url: aiConsultDeepLink(botUsername),
      },
    ])
  }
  return { text: lines.join('\n'), keyboard }
}

// ─── Silver rate daily post ──────────────────────────────────────────────────

export type RenderSilverRate = {
  ratePerGram: number
  unit?: string | null
  note?: string | null
  createdAt: string | Date
}

/** Persian date/time for the store timezone (configurable via STORE_TIMEZONE). */
function rateDateTimeFa(d: string | Date, timeZone: string): { date: string; time: string } {
  const date = new Date(d)
  const dateFmt = new Intl.DateTimeFormat('fa-IR', {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const timeFmt = new Intl.DateTimeFormat('fa-IR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  })
  return { date: dateFmt.format(date), time: timeFmt.format(date) }
}

/**
 * Builds the daily silver-rate channel post. All numbers/dates come straight
 * from the DB record — AI never produces or rewrites the figures.
 */
export function renderSilverRatePost(
  rate: RenderSilverRate,
  botUsername: string,
  storeName = 'SILVER LOVE',
  timeZone = 'Asia/Tehran',
): PostContent {
  const { date, time } = rateDateTimeFa(rate.createdAt, timeZone)
  const unit = rate.unit || 'تومان / گرم'
  const lines: string[] = [
    `✨ <b>${escapeHtml(storeName)}</b>`,
    `📊 نرخ روز نقره`,
    '',
    DIVIDER,
    '',
    `💎 قیمت هر گرم نقره`,
    `<b>${formatMoney(rate.ratePerGram)}</b>`,
    `واحد: ${escapeHtml(unit)}`,
    '',
    `📅 تاریخ: ${date}`,
    `🕒 ساعت: ${time}`,
    '',
    DIVIDER,
    '',
    `این نرخ براساس اطلاعات ثبت‌شده`,
    `توسط فروشگاه <b>${escapeHtml(storeName)}</b> منتشر شده است.`,
    `برای مشاهده محصولات و دریافت مشاوره`,
    `از ربات فروشگاه استفاده کنید.`,
  ]
  if (rate.note) {
    lines.push('', `📝 <i>${escapeHtml(rate.note)}</i>`)
  }

  const keyboard: InlineButton[][] = []
  if (botUsername) {
    keyboard.push([{ text: '🤖 ورود به ربات فروشگاه', url: `https://t.me/${botUsername}` }])
  }
  return { text: lines.join('\n'), keyboard }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function hashContent(text: string, keyboard: InlineButton[][]): string {
  // tiny sync-safe hash (FNV-1a) over text + keyboard structure
  const payload = text + '\u0000' + JSON.stringify(keyboard)
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Status emoji used in order listings / notifications. */
export function orderStatusFa(status: string): { label: string; emoji: string } {
  switch (status) {
    case 'pending':
      return { label: 'در انتظار بررسی', emoji: '🟡' }
    case 'confirmed':
      return { label: 'تأیید شده', emoji: '🟢' }
    case 'processing':
      return { label: 'در حال پردازش', emoji: '🔵' }
    case 'shipped':
      return { label: 'ارسال شده', emoji: '🚚' }
    case 'completed':
      return { label: 'تکمیل شده', emoji: '✅' }
    case 'cancelled':
      return { label: 'لغو شده', emoji: '🔴' }
    default:
      return { label: status, emoji: '❔' }
  }
}

export function productStatusFa(status: string): string {
  switch (status) {
    case 'draft':
      return 'پیش‌نویس'
    case 'active':
      return 'فعال'
    case 'inactive':
      return 'غیرفعال'
    case 'out_of_stock':
      return 'ناموجود'
    default:
      return status
  }
}

/**
 * Detect a BROAD DISCOVERY question — an open "what do you have?" message with
 * no concrete product/category/budget intent. For these the assistant must NOT
 * blast product cards; it should consult first (categories + 1-2 needs
 * questions) and keep the customer's options open. A message that mentions any
 * concrete category/product type or budget is NOT broad — the assistant may
 * search and show cards for it.
 * Pure function (no DB) so both the panel and the bot-service can use it.
 */
const BROAD_DISCOVERY_RE =
  /چیا\s?(داری|دارید|دارین)|چی\s?(دارید|داری|دارین|موجوده|موجود|فروخت|پیشنهاد|مدل)|چه\s?(محصولات|چیز|گزینه|مدل|چیزایی|چیزهایی)|محصولات(ت|تان|تون|اتون)?\s?(چی|چه|چیه)?|فروشگاه(ت|تان|تون)?\s?(چی|چه|چیه)?|لیست\s?محصولات|همه\s?محصولات|نمایش\s?محصولات|چه\s?سبد\s?محصولی|چی\s?برای\s?(فروش|خرید)\s?دارید/i

const NARROW_INTENT_RE =
  /انگشتر|گردنبند|آویز|دستبند|زنجیر|گوشواره|ست|شمش|حلقه|پابند|نیم‌ست|دستبند\s?پا|هدیه|کادو|سلیقه|بودجه|تومان|قیمت|ارزان|گران|زنانه|مردانه|بچه|جدا?یه|مقایسه|نرخ|عیار|وزن|سایز|مدل\s?\S+|کد\s?\S+/i

export function isBroadDiscoveryQuery(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length === 0 || t.length > 120) return false
  if (NARROW_INTENT_RE.test(t)) return false
  return BROAD_DISCOVERY_RE.test(t)
}
