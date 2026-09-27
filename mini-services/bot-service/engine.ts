/**
 * bot-service — conversation engine (state machine persisted in BotSession).
 *
 * Pure-ish core: handleUpdate(input) → Reply[]. It returns replies instead of
 * sending them itself; the caller (/simulate response or the polling loop) is
 * responsible for delivery. Side effects inside (orders, notifications) are
 * wrapped and never throw.
 *
 * All customer-facing strings are Persian.
 */
import {
  type InlineButton,
  escapeHtml,
  formatMoney,
  formatNumber,
  orderStatusFa,
} from '../../src/lib/telegram-render'
import { db } from './db'
import {
  InsufficientStockError,
  ProductUnavailableError,
  createOrder,
  setOrderStatus,
} from './orders'
import {
  getCategory,
  getProduct,
  getStoreSettings,
  listActiveProductsByCategory,
  listCategories,
  searchActiveProducts,
} from './store'
import { answerCallback } from './telegram'

export type Reply = { text: string; keyboard?: InlineButton[][] }

export type BotFlow =
  | 'await_quantity'
  | 'await_name'
  | 'await_phone'
  | 'await_address'
  | 'await_confirm'
  | 'await_search'

export type BotState = {
  flow?: BotFlow
  productId?: string
  quantity?: number
  name?: string
  phone?: string
  address?: string
}

export type UpdateInput = {
  telegramUserId: string
  firstName?: string
  username?: string
  text?: string
  callbackData?: string
  callbackId?: string
  action?: string // 'reset' (simulator convenience)
}

const SESSION_TTL_MS = 30 * 60 * 1000
const PRODUCTS_PER_PAGE = 5
const DEFAULT_LOW_STOCK = 5

// ─── Menus ───────────────────────────────────────────────────────────────────

const MAIN_MENU: InlineButton[][] = [
  [{ text: '🛍 محصولات', callback_data: 'menu:products' }],
  [{ text: '📦 سفارش‌های من', callback_data: 'menu:orders' }],
  [{ text: '🔎 جستجوی محصول', callback_data: 'menu:search' }],
  [{ text: '☎️ پشتیبانی', callback_data: 'menu:support' }],
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

// ─── Views ───────────────────────────────────────────────────────────────────

function mainMenuReply(text = '🏠 منوی اصلی. از بخش موردنظر انتخاب کنید:'): Reply {
  return { text, keyboard: MAIN_MENU }
}

async function categoriesReply(): Promise<Reply> {
  const cats = await listCategories()
  if (cats.length === 0) {
    return { text: 'هنوز دسته‌ای ثبت نشده است.', keyboard: MAIN_MENU }
  }
  const kb: InlineButton[][] = cats.map((c) => [
    { text: c.name, callback_data: `cat:${c.id}` },
  ])
  kb.push(HOME_ROW)
  return { text: '🛍 دسته‌بندی محصولات', keyboard: kb }
}

async function categoryPageReply(catId: string, page: number): Promise<Reply> {
  const cat = await getCategory(catId)
  if (!cat) {
    return { text: 'این دسته یافت نشد.', keyboard: MAIN_MENU }
  }
  const { items, total } = await listActiveProductsByCategory(catId, page, PRODUCTS_PER_PAGE)
  const backRow: InlineButton[] = [{ text: '⬅️ بازگشت', callback_data: 'back:products' }]
  if (items.length === 0) {
    return {
      text: `دسته: ${escapeHtml(cat.name)}\n\nمحصولی در این دسته موجود نیست.`,
      keyboard: [backRow, HOME_ROW],
    }
  }
  const totalPages = Math.max(1, Math.ceil(total / PRODUCTS_PER_PAGE))
  const kb: InlineButton[][] = items.map((p) => [
    { text: productButtonLabel(p), callback_data: `prod:${p.id}` },
  ])
  const navRow: InlineButton[] = []
  if (page > 1) navRow.push({ text: '◀️', callback_data: `page:${catId}:${page - 1}` })
  if (page < totalPages) navRow.push({ text: '▶️', callback_data: `page:${catId}:${page + 1}` })
  if (navRow.length > 0) kb.push(navRow)
  kb.push(backRow, HOME_ROW)
  return {
    text: `دسته: ${escapeHtml(cat.name)}\n\nصفحه ${formatNumber(page)} از ${formatNumber(totalPages)}`,
    keyboard: kb,
  }
}

async function productCardReply(
  productId: string,
  notFoundKeyboard: InlineButton[][] = MAIN_MENU,
): Promise<Reply[]> {
  const p = await getProduct(productId)
  if (!p || p.status !== 'active') {
    return [{ text: 'این محصول یافت نشد یا فعال نیست.', keyboard: notFoundKeyboard }]
  }
  const lines: string[] = [`🛍️ <b>${escapeHtml(p.name)}</b>`]
  if (p.shortDescription) lines.push('', escapeHtml(p.shortDescription))
  lines.push('', `💰 قیمت: <b>${formatMoney(p.price)}</b>`)
  if (p.compareAtPrice && p.compareAtPrice > p.price) {
    lines.push(`🏷️ قبلاً: <s>${formatMoney(p.compareAtPrice)}</s>`)
  }
  lines.push('', stockLine(p))
  if (p.description) lines.push('', escapeHtml(p.description))

  const kb: InlineButton[][] = []
  if (p.stock > 0) kb.push([{ text: '🛒 سفارش', callback_data: `order:${p.id}` }])
  kb.push([{ text: '⬅️ بازگشت', callback_data: 'back:products' }])

  return [{ text: lines.join('\n'), keyboard: kb }]
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

async function supportReply(): Promise<Reply> {
  const settings = await getStoreSettings()
  const kb: InlineButton[][] = []
  if (settings.supportUsername) {
    kb.push([{ text: '💬 گفتگو با پشتیبانی', url: `https://t.me/${settings.supportUsername}` }])
  }
  kb.push(HOME_ROW)
  return { text: 'برای پشتیبانی با ما در تماس باشید:', keyboard: kb }
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

// ─── AI assistant (internal API) + deterministic fallback ────────────────────

async function askAiAssistant(
  telegramUserId: string,
  message: string,
  firstName?: string,
): Promise<string | null> {
  const key = process.env.INTERNAL_API_KEY
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
    const data = (await res.json().catch(() => null)) as { reply?: unknown } | null
    const reply = data?.reply
    return typeof reply === 'string' && reply.trim() ? reply.trim() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Free text outside any flow → AI assistant; on failure → product search. */
async function freeTextReply(
  telegramUserId: string,
  text: string,
  firstName?: string,
): Promise<Reply[]> {
  const ai = await askAiAssistant(telegramUserId, text, firstName)
  if (ai) return [{ text: escapeHtml(ai) }]

  // deterministic fallback keeps the bot useful before/without the AI service
  const results = await searchActiveProducts(text, 8)
  const note = 'دستیار هوشمند موقتاً در دسترس نیست — نتایج جستجو:'
  if (results.length === 0) {
    return [
      {
        text: `${note}\n\nمحصولی یافت نشد. عبارت دیگری را امتحان کنید.`,
        keyboard: [[{ text: '🔎 جستجوی مجدد', callback_data: 'menu:search' }], HOME_ROW],
      },
    ]
  }
  const kb: InlineButton[][] = results.map((p) => [
    { text: productButtonLabel(p), callback_data: `prod:${p.id}` },
  ])
  kb.push([{ text: '🔎 جستجوی مجدد', callback_data: 'menu:search' }], HOME_ROW)
  return [{ text: `${note}\n\n🔎 «${escapeHtml(text.trim())}»:`, keyboard: kb }]
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
      const settings = await getStoreSettings()
      const name = input.firstName ? input.firstName : ''
      const hello = name
        ? `سلام ${escapeHtml(name)}! 👋 به فروشگاه ${escapeHtml(settings.storeName)} خوش آمدید.`
        : `سلام! 👋 به فروشگاه ${escapeHtml(settings.storeName)} خوش آمدید.`
      return [{ text: `${hello}\n\nاز منوی زیر انتخاب کنید یا سؤال خود را مستقیم بنویسید:`, keyboard: MAIN_MENU }]
    }
    return [mainMenuReply('دستور شناخته‌شده نیست. از منوی زیر استفاده کنید:')]
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
    default:
      return freeTextReply(telegramUserId, text, input.firstName)
  }
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
    return [await supportReply()]
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
  if (cb === 'order:confirm') {
    return confirmOrderCallback(telegramUserId, state)
  }
  if (cb === 'order:cancel') {
    await clearFlow(telegramUserId)
    return [{ text: 'سفارش لغو شد.', keyboard: MAIN_MENU }]
  }
  if (cb.startsWith('order:')) {
    return startOrderFlow(telegramUserId, cb.slice('order:'.length))
  }
  if (cb.startsWith('seller:confirm:') || cb.startsWith('seller:cancel:')) {
    return sellerStatusCallback(cb)
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
        firstName: state.name, // snapshot name the customer typed; telegram first name may differ
        username: inputUsernameCache.get(telegramUserId) ?? null,
      },
      productId: state.productId,
      quantity: state.quantity,
      name: state.name,
      phone: state.phone,
      address: state.address,
    })
    await clearFlow(telegramUserId)
    return [
      {
        text: `✅ سفارش شما با شماره #${order.orderNumber} ثبت شد!\n\nمبلغ: ${formatMoney(order.total)}\nوضعیت: در انتظار بررسی\n\nبه‌زودی با شما تماس می‌گیریم. 🙏`,
        keyboard: MAIN_MENU,
      },
    ]
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

async function sellerStatusCallback(cb: string): Promise<Reply[]> {
  // cb = seller:confirm:<id> | seller:cancel:<id>
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

    if (input.action === 'reset') {
      await clearFlow(input.telegramUserId)
      return [mainMenuReply('🔄 گفتگو بازنشانی شد. از منوی زیر انتخاب کنید:')]
    }

    const state = await loadSession(input.telegramUserId)
    let replies: Reply[]
    if (typeof input.callbackData === 'string' && input.callbackData) {
      replies = await handleCallback(input.telegramUserId, input, state)
    } else if (typeof input.text === 'string') {
      replies = await handleText(input.telegramUserId, input, state)
    } else {
      replies = [mainMenuReply()]
    }

    if (input.callbackId) {
      try {
        await answerCallback(input.callbackId)
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
