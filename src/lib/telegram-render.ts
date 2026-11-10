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

export type PostPlatform = 'telegram' | 'bale'

/** Messenger-specific deep-link base (bale links live at ble.ir). */
function deepLinkBase(platform: PostPlatform): string {
  return platform === 'bale' ? 'https://ble.ir' : 'https://t.me'
}

/** Deep link that connects the channel post to the bot order flow. */
export function productDeepLink(
  botUsername: string,
  productId: string,
  platform: PostPlatform = 'telegram',
): string {
  return `${deepLinkBase(platform)}/${botUsername}?start=product_${productId}`
}

/** Deep link that opens the AI shopping-consultant entry point in the bot. */
export function aiConsultDeepLink(botUsername: string, platform: PostPlatform = 'telegram'): string {
  return `${deepLinkBase(platform)}/${botUsername}?start=ai_consult`
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
  platform: PostPlatform = 'telegram',
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
        url: productDeepLink(botUsername, product.id, platform),
      },
    ])
  }
  if (botUsername) {
    keyboard.push([
      {
        text: '💬 مشاوره هوشمند',
        url: aiConsultDeepLink(botUsername, platform),
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
  platform: PostPlatform = 'telegram',
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
    keyboard.push([{ text: '🤖 ورود به ربات فروشگاه', url: `${deepLinkBase(platform)}/${botUsername}` }])
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

// ─── Bare product-type ask detection (pure — shared by assistant + bot) ──────

/**
 * Product-type keywords → the follow-up label used when the customer names a
 * type WITHOUT any gender/gift target or budget. For those the assistant must
 * ask «مردانه یا زنانه؟ بودجه؟» FIRST instead of blasting mixed-gender cards
 * (owner-reported bug: «انگشتر میخوام» dumped a generic form / mixed cards).
 */
export const PRODUCT_TYPE_CONSULT: { re: RegExp; base: string }[] = [
  { re: /انگشتر|حلقه/, base: 'انگشتر' },
  { re: /گردنبند|آویز/, base: 'گردنبند' },
  { re: /دستبند|النگو|پابند/, base: 'دستبند' },
  { re: /زنجیر/, base: 'زنجیر' },
  { re: /گوشواره/, base: 'گوشواره' },
  { re: /(^|\s)(نیم‌)?ست($|\s|[،!.؟])/u, base: 'ست' },
  { re: /شمش/, base: 'شمش' },
]

/**
 * A "bare" product-type ask: names a type but NO gender/gift target and NO
 * price/budget signal. Returns the type label («انگشتر») or null.
 * «زن»/«مرد» single words are deliberately NOT matched («زن» lives inside
 * «زنجیر» — would break bare chain asks); full words like زنانه/مردانه only.
 */
export function detectBareTypeAsk(text: string): string | null {
  const t = (text ?? '').trim()
  if (!t || t.length > 60) return null
  const type = PRODUCT_TYPE_CONSULT.find((x) => x.re.test(t))
  if (!type) return null
  const hasGenderOrGift =
    /(مردانه|زنانه|آقا|آقای|آقایان|خانم|بانو|بانوان|مادر|پدر|همسر|خواهر|برادر|دوست|استاد|معلم|همکار|پسر|دختر|شوهر|خودم|هدیه|کادو|بچه)/i.test(
      t,
    )
  if (hasGenderOrGift) return null
  const hasPriceOrBudget =
    /(قیمت|بودجه|تومان|تومن|میلیون|هزار|چنده|چقدر|قیمتی|ارزان|گران|زیر|بالای)/i.test(t)
  if (hasPriceOrBudget) return null
  return type.base
}

/** The deterministic consult-first follow-up for a bare type ask. */
export function bareTypeFollowUpFa(base: string): string {
  return [
    `${base}های متنوعی داریم 😊`,
    '',
    '۱️⃣ مردانه می‌خواهید یا زنانه؟',
    '۲️⃣ حدود بودجه‌تان چقدر است؟',
    '',
    'بگویید تا بهترین گزینه‌ها را با قیمت واقعی معرفی کنم 💎',
  ].join('\n')
}

/**
 * AI replies arrive in light markdown (`**bold**`, `*italic*`, `` `code` ``)
 * but the bot sends with Telegram's HTML parse mode — raw asterisks would show
 * literally in the customer's chat. Escape HTML first, then convert the few
 * markdown constructs Telegram supports.
 */
export function aiReplyToTelegramHtml(reply: string): string {
  let s = escapeHtml(reply)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/(^|\s)\*([^*\n]+)\*(?=\s|[،!.؟:]|$)/gu, '$1<i>$2</i>')
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  return s
}

// ─── Small talk classification (pure — shared by panel + bot) ────────────────

export type SmallTalkKind = 'greeting' | 'thanks' | 'bye'

/** Minimal Persian normalizer (local copy — this module stays dependency-free). */
function normalizeFaText(text: string): string {
  return (text ?? '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/\u200c/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Words that are ONLY greetings — every token must belong to this set. */
const GREETING_TOKENS = new Set([
  'سلام', 'سلامعلیکم', 'السلام', 'علیکم', 'درود', 'هی', 'های',
  'خوبید', 'چطورید', 'خستگی', 'نباشید', 'خسته', 'بخیر',
  'صبح', 'عصر', 'شب', 'وقت', 'امروز', 'خوب', 'علیکمسلام',
  // colloquial how-are-you forms — «سلام چطوری» / «سلام خوبی؟» / «چه خبر»
  'چطوری', 'چطوره', 'چطورین', 'خوبی', 'خوبین', 'چه', 'خبر',
  'احوال', 'اوضاع', 'شما', 'بر', 'تو', 'شون', 'ایشون',
  'hi', 'hello', 'hey', 'salam',
])

const THANKS_RE =
  /^(ممنون( از شما| از لطفتون| از لطف شما| از راهنمایی)?|مرسی|مچکرم|تشکر(ها|هاى)?|تشکرات|دمت گرم|دستت درد نکنه|دستت درد نکند|لطف کردید|لطف بزرگی کردید|خواهش میکنم خدمتتون)[\s!؟.,]*$/i

const BYE_RE =
  /^(خداحافظ|خدافظ|بدرود|فعلا|فعلا خداحافظ|بای|بای بای|خدانگهدار|خسته نباشید خداحافظ)[\s!؟.,]*$/i

/**
 * Classify a message as pure small talk (greeting/thanks/bye) — a message that
 * carries no product intent at all. Returns null when ANY product/conversation
 * content is present (even «سلام، گردنبند میخوام» → null → full assistant).
 */
export function classifySmallTalk(text: string): SmallTalkKind | null {
  const norm = normalizeFaText(text ?? '')
  if (!norm || norm.length > 60) return null
  const tokens = norm.split(' ').filter(Boolean)
  if (
    tokens.length > 0 &&
    tokens.length <= 6 &&
    tokens.every((w) => GREETING_TOKENS.has(w))
  ) {
    return 'greeting'
  }
  if (THANKS_RE.test(norm)) return 'thanks'
  if (BYE_RE.test(norm)) return 'bye'
  return null
}

/** Deterministic warm reply for small talk — zero AI cost, zero failure modes. */
export function smallTalkReplyFa(kind: SmallTalkKind, firstName?: string): string {
  const name = firstName ? ` ${firstName.trim().slice(0, 30)}` : ''
  switch (kind) {
    case 'greeting':
      return [
        `سلام${name} عزیز! 👋`,
        'به فروشگاه نقره «Silver Love» خوش آمدید.',
        '',
        'چطور می‌توانم کمکتان کنم؟',
        '• دنبال محصول خاصی هستید؟ فقط بنویسید — مثلاً «گردنبند برای هدیه تا ۱ میلیون»',
        '• نمی‌دانید چه انتخاب کنید؟ بگویید برای چه مناسبتی می‌خواهید تا راهنمایی‌تان کنم',
        '• یا از منوی زیر استفاده کنید 👇',
      ].join('\n')
    case 'thanks':
      return 'خواهش می‌کنم 🙏 من در خدمت شما هستم. هر سؤالی دربارهٔ محصولات نقره داشتید بفرمایید 💎'
    case 'bye':
      return 'به امید دیدار 🌹 هر وقت نیاز به مشاوره یا خرید داشتید، همین‌جا در خدمت شما هستیم.'
  }
}
