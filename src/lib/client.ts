/**
 * Frontend API client — shared types, fetch helper, Persian formatters.
 * Client-safe only (no server-only imports). All URLs are relative.
 */

// ---------------------------------------------------------------------------
// Types (per API CONTRACTS v1 in worklog.md)
// ---------------------------------------------------------------------------

export type User = { id: string; name: string; email: string; role: string }

export type ProductStatus = 'draft' | 'active' | 'inactive' | 'out_of_stock'
export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'completed'
  | 'cancelled'

export type Category = {
  id: string
  name: string
  slug: string
  description: string | null
  parentId: string | null
  sortOrder: number
  productCount: number
  childCount: number
  createdAt: string
}

export type TelegramPost = {
  messageId: number
  channelId: number | string
  publishedAt: string
}

export type ProductImage = {
  id: string
  url: string
  isPrimary: boolean
  sortOrder: number
}

/** Payload shape accepted by POST/PATCH /api/products (`images` full-replacement). */
export type ProductImageInput = {
  url: string
  isPrimary?: boolean
  sortOrder?: number
}

export type Product = {
  id: string
  name: string
  slug: string
  description: string | null
  shortDescription: string | null
  price: number
  compareAtPrice: number | null
  stock: number
  lowStockThreshold: number
  categoryId: string | null
  category: { id: string; name: string } | null
  imageUrl: string | null
  status: ProductStatus
  aiGenerated: boolean
  tags: string[] | null
  createdAt: string
  updatedAt: string
  telegramPost: TelegramPost | null
  // Silver-specific spec fields (all optional, null when unset)
  productCode?: string | null
  silverType?: string | null
  fineness?: number | null
  weightGrams?: number | null
  size?: string | null
  dimensions?: string | null
  brand?: string | null
  appearance?: string | null
  careInstructions?: string | null
  authenticityNote?: string | null
  images?: ProductImage[]
}

export type OrderItem = {
  id: string
  productId: string | null
  productNameSnapshot: string
  unitPriceSnapshot: number
  quantity: number
  total: number
}

export type OrderCustomer = {
  id: string
  firstName: string
  telegramUsername: string | null
}

export type PaymentStatus =
  | 'awaiting_payment'
  | 'payment_review'
  | 'paid'
  | 'rejected'
  | 'refund_pending'
  | 'refunded'

/** Persian labels + outline badge classes for payment statuses. */
export const PAYMENT_STATUS_FA: Record<string, { label: string; badgeClass: string }> = {
  awaiting_payment: {
    label: 'در انتظار پرداخت',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  payment_review: {
    label: 'رسید در انتظار بررسی',
    badgeClass: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  paid: {
    label: 'پرداخت شده',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  rejected: {
    label: 'رد شده',
    badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
  },
  refund_pending: {
    label: 'بازپرداخت در انتظار',
    badgeClass: 'bg-violet-50 text-violet-700 border-violet-200',
  },
  refunded: {
    label: 'بازپرداخت شده',
    badgeClass: 'bg-slate-100 text-slate-600 border-slate-200',
  },
}

/** Latest payment attached to an order (order serializer). */
export type PaymentSummary = {
  id: string
  status: string
  receiptUrl: string
  payerName: string | null
  trackingNumber: string | null
  customerNote: string | null
  reviewNote: string | null
  reviewedAt: string | null
  createdAt: string
}

export type Order = {
  id: string
  orderNumber: number
  status: OrderStatus
  subtotal: number
  discount: number
  total: number
  address: string | null
  phone: string | null
  customerName: string
  createdAt: string
  updatedAt: string
  customer: OrderCustomer | null
  items: OrderItem[]
  paymentStatus: string
  trackingCode: string | null
  payment: PaymentSummary | null
}

/** A payment record as returned by GET /api/payments. */
export type PaymentRecord = {
  id: string
  status: string
  amount: number
  receiptUrl: string
  payerName: string | null
  trackingNumber: string | null
  customerNote: string | null
  reviewNote: string | null
  reviewedByName: string | null
  reviewedAt: string | null
  createdAt: string
  order: {
    id: string
    orderNumber: number
    total: number
    status: string
    paymentStatus: string
    customerName: string
    phone: string | null
    items: {
      productNameSnapshot: string
      quantity: number
      unitPriceSnapshot: number
    }[]
  }
}

/** Card-to-card payment destination (admin-managed). */
export type PaymentDestination = {
  id: string
  bankName: string
  accountHolder: string
  cardNumber: string
  sheba: string | null
  accountNumber: string | null
  note: string | null
  active: boolean
  sortOrder: number
}

/** One registered silver rate row (current or history). */
export type SilverRateRecord = {
  id: string
  ratePerGram: number
  unit: string
  note: string | null
  active: boolean
  createdByName: string | null
  createdAt: string
  // channel publishing state (new silver-rate-post feature)
  publishStatus: 'pending' | 'published' | 'failed' | string
  telegramMessageId: number | null
  telegramChannelId: string | null
  publishError: string | null
  publishedAt: string | null
}

export type SilverRateInfo = {
  current: SilverRateRecord | null
  history: SilverRateRecord[]
}

// ─── AI Image Studio ─────────────────────────────────────────────────────────

/** One preset background template of the studio library. */
export type StudioBackground = {
  key: string
  name: string // Persian display name
  description: string // Persian one-liner shown on the card
  /** tailwind classes rendering the card preview (visual identity) */
  previewClass: string
}

/** One image-studio processing job (raw → subject → composite → approved). */
export type StudioJob = {
  id: string
  productId: string
  rawUrl: string
  subjectUrl: string | null
  finalUrl: string | null
  backgroundKey: string | null
  status: 'raw' | 'subject_ready' | 'generated' | 'approved' | 'rejected' | 'failed' | string
  error: string | null
  approvedAt: string | null
  createdAt: string
}

export type StudioState = {
  backgrounds: StudioBackground[]
  jobs: StudioJob[]
}

export type Customer = {
  id: string
  telegramUserId: string
  telegramUsername: string | null
  firstName: string
  lastName: string | null
  phone: string | null
  address: string | null
  totalOrders: number
  totalSpent: number
  lastOrderAt: string | null
  createdAt: string
}

export type DashboardTotals = {
  products: number
  activeProducts: number
  lowStock: number
  outOfStock: number
  pendingOrders: number
  todayOrders: number
  totalSales: number
  customers: number
  paymentsAwaitingReview: number
}

export type WeeklyPoint = { date: string; orders: number; sales: number }

export type RecentOrder = {
  id: string
  orderNumber: number
  customerName: string
  total: number
  status: OrderStatus
  createdAt: string
}

export type DashboardStats = {
  totals: DashboardTotals
  weekly: WeeklyPoint[]
  recentOrders: RecentOrder[]
  statusCounts: Record<OrderStatus, number>
  paymentStatusCounts: Record<string, number>
}

export type Settings = {
  storeName: string
  storeDescription: string
  supportUsername: string
  currency: string
  /** /start greeting template — {name} = customer, {store} = shop */
  welcomeMessage: string
  aiEnabled: boolean
  aiTone: string
}

export type TelegramInfo = {
  botConfigured: boolean
  channelConfigured: boolean
  adminChatConfigured: boolean
  mockMode: boolean
  botUsername: string | null
  /** where the running config comes from: admin panel (DB) or environment */
  source: 'panel' | 'env'
}

export type ActivityLogItem = {
  id: string
  level: string
  type: string
  message: string
  data?: unknown
  createdAt: string
}

export type TelegramStatus = TelegramInfo & {
  recentMessages: ActivityLogItem[]
}

// Bale mirrors the Telegram connection shapes (same Bot API family).
export type BaleStatus = Omit<TelegramInfo, never> & {
  recentMessages: ActivityLogItem[]
}

export type BaleConfigInfo = {
  source: 'panel' | 'env'
  mockMode: boolean
  botUsername: string
  channelId: string
  adminChatId: string
  botTokenMasked: string | null
}

export type BaleSaveResult = {
  ok: boolean
  checks: TelegramCheck[]
  warnings: string[]
}

export type BaleTestResult = {
  ok: boolean
  mode: 'mock' | 'real'
  checks: TelegramCheck[]
}

export type TelegramConfigInfo = {
  source: 'panel' | 'env'
  mockMode: boolean
  botUsername: string
  channelId: string
  adminChatId: string
  botTokenMasked: string | null
}

export type TelegramCheck = {
  key: string
  label: string
  ok: boolean
  message: string
}

export type TelegramSaveResult = {
  ok: boolean
  checks: TelegramCheck[]
  warnings: string[]
}

export type TelegramTestResult = {
  ok: boolean
  mode: 'mock' | 'real'
  checks: TelegramCheck[]
}

export type AiSuggestion = {
  title: string
  description: string
  shortDescription: string
  categorySuggestion: string
  tags: string[]
  telegramCaption: string
}

export type BotKeyboardButton = {
  text: string
  callback_data?: string
  url?: string
}
export type BotReply = {
  text: string
  keyboard?: BotKeyboardButton[][]
}

// ---------------------------------------------------------------------------
// Auth token (localStorage fallback for cross-origin iframe previews)
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'tcb_token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage unavailable */
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Fetch JSON from a relative API path.
 * - Sets Content-Type for JSON bodies (not FormData).
 * - Throws ApiError with the server `error` message on failure.
 * - On 401 dispatches window event `tcb:unauthorized` (unless silent401).
 */
export async function api<T>(
  path: string,
  init?: RequestInit,
  opts?: { silent401?: boolean },
): Promise<T> {
  const headers: Record<string, string> = {}
  if (init?.body && !(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  // Bearer token beats cookie-restricted contexts (preview iframes block
  // third-party cookies, so the httpOnly session cookie may never be sent).
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })

  if (res.status === 401) {
    clearToken()
    // Prefer the server's own Persian message (e.g. «ایمیل یا رمز عبور اشتباه است»
    // on a failed login) over the generic session-expired text.
    let serverMsg = ''
    try {
      const d: unknown = await res.json()
      if (
        d &&
        typeof d === 'object' &&
        'error' in d &&
        typeof (d as { error: unknown }).error === 'string'
      ) {
        serverMsg = (d as { error: string }).error
      }
    } catch {
      /* empty body */
    }
    if (typeof window !== 'undefined' && !opts?.silent401) {
      window.dispatchEvent(new Event('tcb:unauthorized'))
    }
    throw new ApiError(serverMsg || 'نشست شما منقضی شده است — دوباره وارد شوید', 401)
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* empty body */
  }

  if (!res.ok) {
    const msg =
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `خطای غیرمنتظره (${res.status})`
    throw new ApiError(msg, res.status)
  }
  return data as T
}

export type LoginResponse = { token: string; user: User }

/** Builds a query string, skipping empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

// ---------------------------------------------------------------------------
// Persian formatters
// ---------------------------------------------------------------------------

export const fmtNumber = (n: number | null | undefined): string =>
  new Intl.NumberFormat('fa-IR').format(Number(n ?? 0))

export const fmtMoney = (n: number | null | undefined): string =>
  `${fmtNumber(Math.round(Number(n ?? 0)))} تومان`

export const fmtDate = (d: string | Date | null | undefined): string =>
  d
    ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(d),
      )
    : '—'

export const fmtDay = (d: string | Date | null | undefined): string =>
  d ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(d)) : '—'

export function fmtRel(d: string | Date): string {
  const diffSec = (new Date(d).getTime() - Date.now()) / 1000
  const rtf = new Intl.RelativeTimeFormat('fa-IR', { numeric: 'auto' })
  const abs = Math.abs(diffSec)
  if (abs < 60) return rtf.format(Math.round(diffSec), 'second')
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 2592000) return rtf.format(Math.round(diffSec / 86400), 'day')
  return fmtDay(d)
}

/**
 * Fetches a PRIVATE receipt image with the bearer token attached, converts the
 * response to a blob URL for <img> display. Caller MUST revoke the returned
 * object URL (see ReceiptImage component which does this on unmount).
 * Never put receipt URLs directly into <img src> — they require auth.
 */
export async function fetchReceiptBlobUrl(url: string): Promise<string> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) {
    let msg = `دریافت تصویر رسید ناموفق بود (${res.status})`
    try {
      const d: unknown = await res.json()
      if (
        d &&
        typeof d === 'object' &&
        'error' in d &&
        typeof (d as { error: unknown }).error === 'string'
      ) {
        msg = (d as { error: string }).error
      }
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, res.status)
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

/** Converts Telegram HTML parse-mode text into plain text (chat simulator). */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .trim()
}
