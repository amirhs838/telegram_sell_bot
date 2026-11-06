/**
 * PURE module — no external imports (imported cross-project by mini-services/bot-service).
 * Renders Telegram channel posts for products + shared formatting helpers.
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
}

export type InlineButton = { text: string; callback_data?: string; url?: string }
export type PostContent = { text: string; keyboard: InlineButton[][] }

export function formatMoney(value: number, currency = 'تومان'): string {
  return `${Math.round(value).toLocaleString('fa-IR')} ${currency}`
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('fa-IR')
}

/** Deep link that connects the channel post to the bot order flow. */
export function productDeepLink(botUsername: string, productId: string): string {
  return `https://t.me/${botUsername}?start=product_${productId}`
}

const PRODUCT_EMOJI = '🛍️'

/**
 * Builds the channel post (HTML parse mode) + inline keyboard.
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
  lines.push(`${PRODUCT_EMOJI} <b>${escapeHtml(product.name)}</b>`)
  if (product.shortDescription) lines.push('', escapeHtml(product.shortDescription))
  lines.push('', `💰 قیمت: <b>${formatMoney(product.price, currency)}</b>`)
  if (product.compareAtPrice && product.compareAtPrice > product.price) {
    lines.push(`🏷️ قبلاً: <s>${formatMoney(product.compareAtPrice, currency)}</s>`)
  }

  const isPurchasable = product.status === 'active' && product.stock > 0
  const threshold = product.lowStockThreshold ?? 5

  lines.push('')
  if (product.status !== 'active') {
    lines.push('⛔️ این محصول فعلاً غیرفعال است')
  } else if (product.stock <= 0) {
    lines.push('🔴 ناموجود')
  } else if (product.stock <= threshold) {
    lines.push(`⚠️ فقط ${formatNumber(product.stock)} عدد باقی مانده`)
  } else {
    lines.push(`📦 موجودی: ${formatNumber(product.stock)} عدد`)
  }

  if (product.description) {
    lines.push('', escapeHtml(product.description))
  }

  const keyboard: InlineButton[][] = []
  if (isPurchasable && botUsername) {
    keyboard.push([
      {
        text: '🛒 سفارش در ربات',
        url: productDeepLink(botUsername, product.id),
      },
    ])
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
