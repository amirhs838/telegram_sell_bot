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
  productCount: number
  createdAt: string
}

export type TelegramPost = {
  messageId: number
  channelId: number | string
  publishedAt: string
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
}

export type Settings = {
  storeName: string
  storeDescription: string
  supportUsername: string
  currency: string
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
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })

  if (res.status === 401) {
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
