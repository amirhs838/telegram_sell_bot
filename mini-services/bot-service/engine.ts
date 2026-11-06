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
import path from 'node:path'
import fsSync from 'node:fs'
import { db } from './db'
import {
  InsufficientStockError,
  ProductUnavailableError,
  createOrderMulti,
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
import { answerCallback, loadConfig, send } from './telegram'
import {
  attachReceiptToOrder,
  createOrderMulti,
  findPayableOrderForCustomer,
  getActiveBankAccount,
  paymentStatusFa,
} from './orders'
import { saveIncomingReceipt } from './receipts'

export type Reply = {
  text: string
  keyboard?: InlineButton[][]
  /** local absolute path — polling loop uploads it via sendPhoto */
  imagePath?: string
  /** original panel URL — used by the panel simulator to render the image */
  imageUrl?: string
}

export type BotFlow =
  | 'await_quantity'
  | 'await_name'
  | 'await_phone'
  | 'await_address'
  | 'await_confirm'
  | 'await_search'
  | 'await_receipt'

export type CartLine = { productId: string; qty: number }

export type BotState = {
  flow?: BotFlow
  productId?: string
  quantity?: number
  name?: string
  phone?: string
  address?: string
  cart?: CartLine[]
  checkout?: 'single' | 'cart' | 'ai'
  aiItems?: CartLine[]
  awaitingReceiptOrderId?: string
}

export type UpdateInput = {
  telegramUserId: string
  firstName?: string
  username?: string
  text?: string
  callbackData?: string
  callbackId?: string
  action?: string // 'reset' (simulator convenience)
  photo?: { fileId?: string; name?: string } // receipt photo (real: fileId, simulator: name)
}

const SESSION_TTL_MS = 30 * 60 * 1000
const PRODUCTS_PER_PAGE = 5
const DEFAULT_LOW_STOCK = 5

// ─── Menus ───────────────────────────────────────────────────────────────────

const MAIN_MENU: InlineButton[][] = [
  [{ text: '🛍 محصولات', callback_data: 'menu:products' }],
  [{ text: '🛒 سبد خرید', callback_data: 'menu:cart' }],
  [{ text: '📦 سفارش‌های من', callback_data: 'menu:orders' }],
  [
    { text: '🔎 جستجوی محصول', callback_data: 'menu:search' },
    { text: '☎️ پشتیبانی', callback_data: 'menu:support' },
  ],
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

/**
 * Resolve a panel-uploaded image URL (/api/uploads/<name>) to a local file the
 * bot can upload to Telegram. Checks a few candidate project roots because the
 * service may run with different working directories.
 */
function localImageFromUrl(url?: string | null): string | null {
  if (!url || !url.startsWith('/api/uploads/')) return null
  const name = path.basename(url)
  const candidates = [
    path.resolve(process.cwd(), '..', '..', 'upload', name),
    path.resolve(process.cwd(), '..', 'upload', name),
    path.resolve(process.cwd(), 'upload', name),
  ]
  for (const p of candidates) {
    try {
      if (fsSync.existsSync(p)) return p
    } catch {
      // ignore
    }
  }
  return null
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
  if (p.sku) lines.push(`🔖 کد: <code>${escapeHtml(p.sku)}</code>`)
  if (p.shortDescription) lines.push('', escapeHtml(p.shortDescription))
  lines.push('', `💰 قیمت: <b>${formatMoney(p.price)}</b>`)
  if (p.compareAtPrice && p.compareAtPrice > p.price) {
    lines.push(`🏷️ قبلاً: <s>${formatMoney(p.compareAtPrice)}</s>`)
  }

  // Silver specs — only when the seller filled them
  const specs: string[] = []
  if (p.silverType) specs.push(`نوع: ${escapeHtml(p.silverType)}`)
  if (p.purity) specs.push(`عیار: ${escapeHtml(p.purity)}`)
  if (p.weightGrams != null && p.weightGrams > 0) specs.push(`وزن: ${formatNumber(p.weightGrams)} گرم`)
  if (p.size) specs.push(`سایز: ${escapeHtml(p.size)}`)
  if (specs.length > 0) lines.push('', '✨ ' + specs.join(' | '))

  lines.push('', stockLine(p))
  if (p.description) lines.push('', escapeHtml(p.description))
  if (p.authenticity) lines.push('', `🛡️ ${escapeHtml(p.authenticity)}`)

  const kb: InlineButton[][] = []
  if (p.stock > 0) {
    kb.push([{ text: '🛒 سفارش', callback_data: `order:${p.id}` }])
    kb.push([{ text: '➕ افزودن به سبد', callback_data: `cart:add:${p.id}` }])
  }
  kb.push([{ text: '⬅️ بازگشت', callback_data: 'back:products' }])

  const imagePath = localImageFromUrl(p.imageUrl)
  return [{ text: lines.join('\n'), keyboard: kb, ...(imagePath ? { imagePath, imageUrl: p.imageUrl ?? undefined } : {}) }]
}

async function myOrdersReply(telegramUserId: string): Promise<Reply> {
  const customer = await db.customer.findUnique({ where: { telegramUserId } })
  const orders = customer
    ? await db.order.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { payment: true },
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
    const pay = o.payment ? ` | 💳 ${paymentStatusFa(o.payment.status)}` : ''
    return `#${o.orderNumber} — ${s.emoji} ${s.label}${pay} — ${formatMoney(o.total)}`
  })
  const kb: InlineButton[][] = []
  const payable = orders.find((o) => o.payment && ['awaiting_payment', 'rejected'].includes(o.payment.status))
  if (payable) {
    kb.push([{ text: `🧾 ارسال رسید برای #${payable.orderNumber}`, callback_data: `receipt:start:${payable.id}` }])
  }
  kb.push([{ text: '🛍 محصولات', callback_data: 'menu:products' }], HOME_ROW)
  return {
    text: `📦 سفارش‌های اخیر شما:\n\n${lines.join('\n')}`,
    keyboard: kb,
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

// ─── Cart ────────────────────────────────────────────────────────────────────

async function cartReply(state: BotState): Promise<Reply[]> {
  const cart = state.cart ?? []
  if (cart.length === 0) {
    return [
      {
        text: '🛒 سبد خرید شما خالی است.',
        keyboard: [[{ text: '🛍 محصولات', callback_data: 'menu:products' }], HOME_ROW],
      },
    ]
  }
  const lines: string[] = ['🛒 سبد خرید شما:', '']
  const kb: InlineButton[][] = []
  let total = 0
  for (let i = 0; i < cart.length; i++) {
    const p = await getProduct(cart[i].productId).catch(() => null)
    if (!p) continue
    const lineTotal = p.price * cart[i].qty
    total += lineTotal
    lines.push(`• ${escapeHtml(p.name)} × ${formatNumber(cart[i].qty)} — ${formatMoney(lineTotal)}`)
    kb.push([{ text: `❌ حذف: ${p.name}`, callback_data: `cart:rm:${i}` }])
  }
  lines.push('', `💳 مبلغ کل: ${formatMoney(total)}`)
  kb.push([{ text: '✅ ثبت سفارش سبد', callback_data: 'cart:checkout' }])
  kb.push(HOME_ROW)
  return [{ text: lines.join('\n'), keyboard: kb }]
}

// ─── Payment info + receipt flow (Silver Love) ─────────────────────────────

async function paymentInfoReply(order: { id: string; orderNumber: number; total: number }): Promise<Reply[]> {
  const bank = await getActiveBankAccount()
  const lines: string[] = [
    '💳 اطلاعات پرداخت',
    '',
    `🧾 شماره سفارش: #${order.orderNumber}`,
    `💰 مبلغ قابل پرداخت: <b>${formatMoney(order.total)}</b>`,
  ]
  if (bank) {
    lines.push(
      '',
      `🏦 بانک: ${escapeHtml(bank.bankName)}`,
      `👤 به نام: ${escapeHtml(bank.holderName)}`,
      `💳 شماره کارت: <code>${escapeHtml(bank.cardNumber)}</code>`,
    )
    if (bank.sheba) lines.push(`🏦 شبا: <code>${escapeHtml(bank.sheba)}</code>`)
    if (bank.note) lines.push('', `📝 ${escapeHtml(bank.note)}`)
  } else {
    lines.push('', '⚠️ اطلاعات کارت فروشگاه هنوز ثبت نشده است — به‌زودی اطلاع‌رسانی می‌شود.')
  }
  lines.push(
    '',
    'پس از واریز، تصویر رسید را در همین چت بفرستید یا از دکمه زیر استفاده کنید.',
    '⚠️ ارسال رسید به معنی تأیید پرداخت نیست؛ تأیید نهایی توسط ادمین انجام می‌شود.',
  )
  return [
    {
      text: lines.join('\n'),
      keyboard: [[{ text: '🧾 ارسال رسید پرداخت', callback_data: `receipt:start:${order.id}` }], HOME_ROW],
    },
  ]
}

async function receiptStartReply(telegramUserId: string, orderId: string): Promise<Reply[]> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { payment: true, customer: true } })
  if (!order || !order.payment || order.customer.telegramUserId !== telegramUserId) {
    return [{ text: 'سفارشی برای ارسال رسید یافت نشد.', keyboard: MAIN_MENU }]
  }
  if (order.payment.status === 'paid') {
    return [{ text: `پرداخت سفارش #${order.orderNumber} قبلاً تأیید شده است ✅`, keyboard: MAIN_MENU }]
  }
  if (order.payment.status === 'payment_review') {
    return [
      {
        text: `رسید سفارش #${order.orderNumber} قبلاً ثبت شده و در انتظار بررسی ادمین است. 🕐`,
        keyboard: MAIN_MENU,
      },
    ]
  }
  await saveSession(telegramUserId, {
    flow: 'await_receipt',
    awaitingReceiptOrderId: orderId,
  })
  const rejectedNote =
    order.payment.status === 'rejected' && order.payment.rejectReason
      ? `دلیل رد رسید قبلی: ${escapeHtml(order.payment.rejectReason)}\n\nلطفاً رسید اصلاح‌شده را بفرستید.\n\n`
      : ''
  return [
    {
      text: `${rejectedNote}لطفاً تصویر رسید پرداخت سفارش #${order.orderNumber} (مبلغ ${formatMoney(order.payment.amountSnapshot)}) را به‌صورت عکس بفرستید 📎`,
      keyboard: [HOME_ROW],
    },
  ]
}

async function handlePhoto(
  telegramUserId: string,
  input: UpdateInput,
  state: BotState,
): Promise<Reply[]> {
  // In an active receipt flow → attach to that order
  let orderId = state.awaitingReceiptOrderId
  if (!orderId || state.flow !== 'await_receipt') {
    // No active flow: attach to the latest payable order, if any
    const payable = await findPayableOrderForCustomer(telegramUserId)
    if (!payable) {
      return [
        {
          text: 'عکس دریافت شد. اگر قصد ارسال رسید پرداخت دارید، ابتدا سفارش ثبت کنید یا از بخش «سفارش‌های من» سفارش در انتظار پرداخت را انتخاب کنید.',
          keyboard: MAIN_MENU,
        },
      ]
    }
    orderId = payable.id
  }

  const order = await db.order.findUnique({ where: { id: orderId }, include: { payment: true, customer: true } })
  if (!order || !order.payment || order.customer.telegramUserId !== telegramUserId) {
    await clearFlow(telegramUserId)
    return [{ text: 'سفارش یافت نشد.', keyboard: MAIN_MENU }]
  }
  if (order.payment.status === 'paid') {
    await clearFlow(telegramUserId)
    return [{ text: `پرداخت سفارش #${order.orderNumber} قبلاً تأیید شده است ✅`, keyboard: MAIN_MENU }]
  }

  // Resolve + persist the receipt image (real: download from Telegram; simulator: placeholder)
  const savedName = await saveIncomingReceipt(input.photo)
  if (!savedName) {
    return [
      {
        text: 'دریافت تصویر رسید ناموفق بود — لطفاً دوباره به‌صورت عکس بفرستید 📎',
      },
    ]
  }

  const res = await attachReceiptToOrder(orderId, {
    receiptImage: savedName,
    payerName: order.customerName,
  })
  await clearFlow(telegramUserId)
  if (!res.ok) {
    return [{ text: 'ثبت رسید ناموفق بود. لطفاً دوباره تلاش کنید.', keyboard: MAIN_MENU }]
  }

  // Notify the seller (best-effort) — human review happens in the panel
  const { adminChatId: adminChat } = await loadConfig()
  if (adminChat) {
    await send(
      adminChat,
      [
        '🧾 رسید پرداخت جدید',
        '',
        `#${res.orderNumber}`,
        `👤 ${escapeHtml(order.customerName)}`,
        `💰 مبلغ: ${formatMoney(order.payment.amountSnapshot)}`,
        '',
        '⏳ در انتظار بررسی و تأیید دستی در پنل',
      ].join('\n'),
    ).catch(() => undefined)
  }

  return [
    {
      text: `✅ رسید سفارش #${res.orderNumber} دریافت شد و در انتظار بررسی ادمین است.\n\nنتیجه بررسی به شما اطلاع داده می‌شود. 🙏`,
      keyboard: MAIN_MENU,
    },
  ]
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
  const qty = state.quantity ?? 1
  let lines: string[]
  let itemsTotal = 0

  if (state.checkout === 'cart' && (state.cart ?? []).length > 0) {
    lines = ['🧾 خلاصه سفارش', '']
    for (const line of state.cart ?? []) {
      const p = await getProduct(line.productId).catch(() => null)
      if (!p) continue
      const total = p.price * line.qty
      itemsTotal += total
      lines.push(`• ${escapeHtml(p.name)} × ${formatNumber(line.qty)} — ${formatMoney(total)}`)
    }
    lines.push('', `💳 مبلغ کل: ${formatMoney(itemsTotal)}`)
  } else if (state.checkout === 'ai' && (state.aiItems ?? []).length > 0) {
    lines = ['🧾 خلاصه سفارش', '']
    for (const line of state.aiItems ?? []) {
      const p = await getProduct(line.productId).catch(() => null)
      if (!p) continue
      const total = p.price * line.qty
      itemsTotal += total
      lines.push(`• ${escapeHtml(p.name)} × ${formatNumber(line.qty)} — ${formatMoney(total)}`)
    }
    lines.push('', `💳 مبلغ کل: ${formatMoney(itemsTotal)}`)
  } else {
    const p = state.productId ? await getProduct(state.productId) : null
    if (!p) return [{ text: 'سفارشی برای نمایش یافت نشد.', keyboard: MAIN_MENU }]
    itemsTotal = p.price * qty
    lines = [
      '🧾 خلاصه سفارش',
      '',
      `🛍 محصول: ${escapeHtml(p.name)}`,
      `🔢 تعداد: ${formatNumber(qty)}`,
      `💰 قیمت واحد: ${formatMoney(p.price)}`,
      `💳 مبلغ کل: ${formatMoney(itemsTotal)}`,
    ]
  }

  lines.push(
    '',
    `👤 نام: ${escapeHtml(state.name ?? '')}`,
    `📱 موبایل: ${state.phone ?? ''}`,
    `📍 آدرس: ${escapeHtml(state.address ?? '')}`,
  )
  return [
    {
      text: lines.join('\n'),
      keyboard: [
        [{ text: '✅ تأیید سفارش', callback_data: 'order:confirm' }],
        [{ text: '❌ لغو سفارش', callback_data: 'order:cancel' }],
      ],
    },
  ]
}

// ─── AI assistant (internal API) + deterministic fallback ────────────────────

type AiAssistantOutput = {
  reply: string
  images: string[]
  action?: {
    type: 'create_order'
    items: Array<{ productId: string; quantity: number }>
    name: string
    phone: string
    address: string
  }
  handoff?: { summary: string }
  disabled?: boolean
}

async function askAiAssistant(
  telegramUserId: string,
  message: string,
  firstName?: string,
): Promise<AiAssistantOutput | null> {
  const key = process.env.INTERNAL_API_KEY
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 75_000)
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
    const data = (await res.json().catch(() => null)) as AiAssistantOutput | null
    if (!data) return null
    if (data.disabled) return { reply: '', images: [], disabled: true }
    if (typeof data.reply !== 'string' || !data.reply.trim()) return null
    return {
      reply: data.reply.trim(),
      images: Array.isArray(data.images) ? data.images.filter((v) => typeof v === 'string').slice(0, 3) : [],
      action:
        data.action &&
        data.action.type === 'create_order' &&
        Array.isArray(data.action.items) &&
        data.action.items.length > 0 &&
        typeof data.action.name === 'string' &&
        typeof data.action.phone === 'string' &&
        typeof data.action.address === 'string'
          ? data.action
          : undefined,
      handoff: data.handoff && typeof data.handoff.summary === 'string' ? data.handoff : undefined,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Log an operator handoff request (visible in panel activity logs). */
async function logHandoff(telegramUserId: string, firstName: string | undefined, summary: string) {
  try {
    await db.activityLog.create({
      data: {
        level: 'warn',
        type: 'ai.handoff',
        message: `درخواست گفتگو با اپراتور از مشتری ${firstName ?? telegramUserId}`,
        data: JSON.stringify({ telegramUserId, summary }),
      },
    })
  } catch {
    // best-effort
  }
}

/** Free text outside any flow → AI assistant; on failure → product search. */
async function freeTextReply(
  telegramUserId: string,
  text: string,
  firstName?: string,
): Promise<Reply[]> {
  const ai = await askAiAssistant(telegramUserId, text, firstName)
  if (ai && !ai.disabled) {
    const replies: Reply[] = [{ text: escapeHtml(ai.reply) }]

    // product photos requested by the assistant
    for (const url of ai.images) {
      const imagePath = localImageFromUrl(url)
      if (imagePath) {
        replies.push({ text: '🖼️', imagePath, imageUrl: url })
      }
    }

    // operator handoff — notify the seller with the conversation summary
    if (ai.handoff) {
      await logHandoff(telegramUserId, firstName, ai.handoff.summary)
      const { adminChatId } = await loadConfig()
      if (adminChatId) {
        await send(
          adminChatId,
          [
            '🆘 درخواست گفتگو با اپراتور',
            '',
            `👤 مشتری: ${escapeHtml(firstName ?? '')} (شناسه: ${telegramUserId})`,
            '',
            escapeHtml(ai.handoff.summary),
          ].join('\n'),
        ).catch(() => undefined)
      }
    }

    // AI order proposal → explicit customer confirmation (mandatory tap)
    if (ai.action) {
      const state = await loadSession(telegramUserId)
      const next: BotState = {
        flow: 'await_confirm',
        checkout: 'ai',
        aiItems: ai.action.items.map((i) => ({ productId: i.productId, qty: i.quantity })),
        name: ai.action.name,
        phone: ai.action.phone,
        address: ai.action.address,
      }
      await saveSession(telegramUserId, next)
      replies.push(...(await orderSummaryReply(next)))
    }

    return replies
  }

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
    case 'await_receipt':
      return [
        {
          text: 'لطفاً تصویر رسید پرداخت را به‌صورت عکس بفرستید 📎',
          keyboard: [HOME_ROW],
        },
      ]
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
  if (cb === 'menu:cart') {
    // keep the cart, clear only any active flow
    const state = await loadSession(telegramUserId)
    const next: BotState = { cart: state.cart }
    await saveSession(telegramUserId, next)
    return cartReply(next)
  }
  if (cb.startsWith('cart:add:')) {
    const productId = cb.slice('cart:add:'.length)
    const p = await getProduct(productId).catch(() => null)
    if (!p || p.status !== 'active' || p.stock <= 0) {
      return [{ text: 'این محصول برای افزودن به سبد موجود نیست.', keyboard: MAIN_MENU }]
    }
    const state = await loadSession(telegramUserId)
    const cart = [...(state.cart ?? [])]
    const existing = cart.find((l) => l.productId === productId)
    if (existing) {
      if (existing.qty + 1 > p.stock) {
        return [{ text: `بیشتر از موجودی (${formatNumber(p.stock)}) نمی‌توانید اضافه کنید.` }]
      }
      existing.qty += 1
    } else {
      cart.push({ productId, qty: 1 })
    }
    await saveSession(telegramUserId, { ...state, cart })
    return [
      {
        text: `➕ «${escapeHtml(p.name)}» به سبد اضافه شد.`,
        keyboard: [
          [{ text: '🛒 مشاهده سبد', callback_data: 'menu:cart' }],
          [{ text: '🛍 ادامه خرید', callback_data: 'back:products' }],
        ],
      },
    ]
  }
  if (cb.startsWith('cart:rm:')) {
    const idx = parseInt(cb.slice('cart:rm:'.length), 10)
    const state = await loadSession(telegramUserId)
    const cart = [...(state.cart ?? [])]
    if (idx >= 0 && idx < cart.length) cart.splice(idx, 1)
    const next: BotState = { ...state, cart }
    await saveSession(telegramUserId, next)
    return cartReply(next)
  }
  if (cb === 'cart:checkout') {
    const state = await loadSession(telegramUserId)
    if (!(state.cart ?? []).length) {
      return [{ text: 'سبد خرید شما خالی است.', keyboard: MAIN_MENU }]
    }
    await saveSession(telegramUserId, { ...state, flow: 'await_name', checkout: 'cart' })
    return [{ text: 'نام و نام خانوادگی؟', keyboard: [CANCEL_ORDER_ROW] }]
  }
  if (cb.startsWith('receipt:start:')) {
    return receiptStartReply(telegramUserId, cb.slice('receipt:start:'.length))
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
    return confirmOrderCallback(telegramUserId, input, state)
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
  input: UpdateInput,
  state: BotState,
): Promise<Reply[]> {
  const isCart = state.checkout === 'cart'
  const isAi = state.checkout === 'ai'
  let items: Array<{ productId: string; quantity: number }> = []
  if (isCart) items = (state.cart ?? []).map((l) => ({ productId: l.productId, quantity: l.qty }))
  else if (isAi) items = (state.aiItems ?? []).map((l) => ({ productId: l.productId, quantity: l.qty }))
  else if (state.productId && state.quantity) items = [{ productId: state.productId, quantity: state.quantity }]

  if (!state.name || !state.phone || !state.address || items.length === 0) {
    await clearFlow(telegramUserId)
    return [{ text: 'سفارشی برای تأیید یافت نشد. از منوی محصولات شروع کنید:', keyboard: MAIN_MENU }]
  }

  try {
    const order = await createOrderMulti({
      customer: {
        telegramUserId,
        firstName: state.name, // snapshot name the customer typed; telegram first name may differ
        username: inputUsernameCache.get(telegramUserId) ?? null,
      },
      items,
      name: state.name,
      phone: state.phone,
      address: state.address,
    })
    await clearFlow(telegramUserId)
    const success: Reply[] = [
      {
        text: `✅ سفارش شما با شماره #${order.orderNumber} ثبت شد!\n\nمبلغ: ${formatMoney(order.total)}\n\nاطلاعات پرداخت:`,
        keyboard: MAIN_MENU,
      },
    ]
    // Payment instructions immediately follow the order (manual card payment)
    const payInfo = await paymentInfoReply(order)
    return [...success, ...payInfo]
  } catch (e) {
    await clearFlow(telegramUserId)
    if (e instanceof InsufficientStockError) {
      return [
        {
          text: 'متأسفانه موجودی یکی از محصولات کافی نیست — سبد را بررسی و دوباره تلاش کنید.',
          keyboard: MAIN_MENU,
        },
      ]
    }
    if (e instanceof ProductUnavailableError) {
      return [{ text: 'یکی از محصولات یافت نشد یا فعال نیست.', keyboard: MAIN_MENU }]
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
    if (input.photo) {
      replies = await handlePhoto(input.telegramUserId, input, state)
    } else if (typeof input.callbackData === 'string' && input.callbackData) {
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
