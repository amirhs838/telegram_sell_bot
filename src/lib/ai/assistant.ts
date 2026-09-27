// Tool-based Persian sales assistant for the Telegram bot.
// The SDK has no native tool-calling, so we use a JSON tool-protocol loop:
// the model returns ONLY `{"tool":"<name>","args":{…}}` or `{"reply":"<final>"}`,
// the server executes tools against the DB and feeds results back (max 4 rounds).
// Safety: the model is never allowed to invent products/prices/stock — every
// factual number in a reply must come from a TOOL_RESULT payload.
import { z } from 'zod'
import { db } from '@/lib/db'
import { chatJSONMessages, AiError } from '@/lib/ai/client'
import { semanticSearch } from '@/lib/ai/embedding'
import { orderStatusFa } from '@/lib/telegram-render'

const MAX_TOOL_ITERATIONS = 4

const SYSTEM_PROMPT = `تو دستیار فروش تلگرامی هستی؛ فقط با ابزارها (tools) اطلاعات واقعی بگیر؛ هرگز محصول، قیمت، موجودی یا سفارشی از خودت نساز؛ اگر اطلاعات نیست صادقانه بگو؛ قیمت و موجودی فقط از نتایج ابزار؛ پاسخ نهایی کوتاه و فارسی و دوستانه؛ برای پیشنهاد، حداکثر ۳ محصول با قیمت و موجودی واقعی از ابزار معرفی کن و «برای مشاهده و سفارش از منوی محصولات استفاده کنید» اضافه کن.

پروتکل: در هر نوبت «فقط» یک شیء JSON برگردان، بدون متن اضافه، بدون markdown:
- صدا زدن ابزار: {"tool":"نام ابزار","args":{...}}
- پاسخ نهایی به کاربر: {"reply":"متن پاسخ فارسی"}

ابزارهای موجود:
- search_products → args: {"query":"متن جستجو (اختیاری)","category":"نام دسته (اختیاری)","max_price":"حداکثر قیمت تومان (اختیاری)","min_price":"حداقل قیمت (اختیاری)"}
- get_product → args: {"product_id":"شناسه محصول"}
- check_stock → args: {"product_id":"شناسه محصول"}
- get_categories → args: {}
- get_customer_orders → args: {"telegram_user_id":"شناسه تلگرام کاربر","limit":1 تا 5}

نکته‌ها:
- اعداد قیمت‌ها در نتایج ابزار به تومان هستند.
- قبل از معرفی محصول، ابتدا search_products را صدا بزن؛ قیمت/موجودی را فقط از TOOL_RESULT بردار.
- اگر کاربر درباره سفارش‌هایش پرسید و telegram_user_id در پیام هست، از get_customer_orders استفاده کن.
- اگر ابزار خطا داد یا نتیجه‌ای نبود، صادقانه بگو و در صورت نیاز ابزار دیگری را امتحان کن.`

const actionSchema = z.union([
  z.object({ reply: z.string().min(1) }),
  z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }),
])

type AssistantAction = z.infer<typeof actionSchema>

const faMoney = (v: number): string => new Intl.NumberFormat('fa-IR').format(v)

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[,\s]/g, ''))
    if (Number.isFinite(n)) return n
  }
  return undefined
}

const TOOL_ERROR = { error: 'اجرای ابزار ناموفق بود' }

/** Execute one tool call against the DB. Always returns a JSON-serializable value. */
async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_products': {
      const query = typeof args.query === 'string' ? args.query : ''
      const categoryArg = typeof args.category === 'string' ? args.category.trim() : ''
      let categoryId: string | undefined
      if (categoryArg) {
        const cats = await db.category.findMany({ select: { id: true, name: true } })
        const match = cats.find((c) => c.name.includes(categoryArg))
        if (match) categoryId = match.id
      }
      const hits = await semanticSearch(query, {
        limit: 6,
        categoryId,
        minPrice: toFiniteNumber(args.min_price),
        maxPrice: toFiniteNumber(args.max_price),
      })
      return hits.map((h) => ({
        id: h.product.id,
        name: h.product.name,
        price: h.product.price,
        stock: h.product.stock,
        short_description: h.product.shortDescription,
      }))
    }

    case 'get_product': {
      const productId = typeof args.product_id === 'string' ? args.product_id : ''
      if (!productId) return { error: 'product_id ارسال نشده است' }
      const p = await db.product.findUnique({
        where: { id: productId },
        include: { category: { select: { name: true } } },
      })
      if (!p) return { error: 'محصولی با این شناسه یافت نشد' }
      return {
        id: p.id,
        name: p.name,
        price: p.price,
        stock: p.stock,
        status: p.status,
        short_description: p.shortDescription,
        description: p.description,
        category: p.category?.name ?? null,
        image_url: p.imageUrl,
      }
    }

    case 'check_stock': {
      const productId = typeof args.product_id === 'string' ? args.product_id : ''
      if (!productId) return { error: 'product_id ارسال نشده است' }
      const p = await db.product.findUnique({
        where: { id: productId },
        select: { name: true, stock: true, status: true },
      })
      if (!p) return { error: 'محصولی با این شناسه یافت نشد' }
      return { name: p.name, stock: p.stock, status: p.status }
    }

    case 'get_categories': {
      const cats = await db.category.findMany({
        select: { name: true, _count: { select: { products: { where: { status: 'active' } } } } },
        orderBy: { name: 'asc' },
      })
      return cats.map((c) => ({ name: c.name, product_count: c._count.products }))
    }

    case 'get_customer_orders': {
      const telegramUserId = typeof args.telegram_user_id === 'string' ? args.telegram_user_id : ''
      if (!telegramUserId) return { error: 'telegram_user_id ارسال نشده است' }
      const limitRaw = toFiniteNumber(args.limit)
      const limit = Math.min(5, Math.max(1, Math.trunc(limitRaw ?? 5)))
      const customer = await db.customer.findUnique({ where: { telegramUserId } })
      if (!customer) return []
      const orders = await db.order.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { orderNumber: true, status: true, total: true, createdAt: true },
      })
      return orders.map((o) => ({
        order_number: o.orderNumber,
        status_fa: orderStatusFa(o.status).label,
        total: o.total,
        created_at_short: new Intl.DateTimeFormat('fa-IR', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(o.createdAt),
      }))
    }

    default:
      return { error: `ابزار ناشناخته: ${name}` }
  }
}

export type AssistantResult = { reply: string; toolsUsed: string[] }

/** Deterministic fallback so the user always gets something useful. */
async function fallbackReply(message: string): Promise<string> {
  const hits = await semanticSearch(message, { limit: 3 }).catch(() => [])
  const lines: string[] = []
  if (hits.length > 0) {
    hits.forEach((h, i) => {
      const stock = h.product.stock > 0 ? `موجودی: ${faMoney(h.product.stock)} عدد` : 'ناموجود'
      lines.push(`${i + 1}. ${h.product.name} — ${faMoney(h.product.price)} تومان (${stock})`)
    })
  } else {
    lines.push('فعلاً محصولی متناسب با درخواست شما پیدا نکردم.')
  }
  return [
    'دستیار هوشمند موقتاً نتوانست پاسخ کامل بدهد، اما این نتایج را برایتان پیدا کردم:',
    '',
    ...lines,
    '',
    'برای مشاهده و سفارش از منوی محصولات استفاده کنید.',
  ].join('\n')
}

/**
 * Run the tool-loop assistant for one user message.
 * Never throws for model-behavior issues — degrades to the deterministic
 * fallback reply. Only unexpected infra failures propagate as AiError.
 */
export async function runAssistant(input: {
  telegramUserId: string
  message: string
  firstName?: string
}): Promise<AssistantResult> {
  const { telegramUserId, message, firstName } = input
  const toolsUsed: string[] = []

  const intro = firstName
    ? `${message}\n\n(نام کاربر: ${firstName} — شناسه تلگرام: ${telegramUserId})`
    : `${message}\n\n(شناسه تلگرام کاربر: ${telegramUserId})`

  const messages: { role: 'assistant' | 'user'; content: string }[] = [
    { role: 'assistant', content: SYSTEM_PROMPT },
    { role: 'user', content: intro },
  ]

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      let action: AssistantAction
      try {
        action = await chatJSONMessages(messages, actionSchema, 2)
      } catch {
        break // model never produced valid protocol JSON → deterministic fallback
      }

      if ('reply' in action) {
        return { reply: action.reply, toolsUsed }
      }

      const toolName = action.tool
      toolsUsed.push(toolName)

      let result: unknown
      try {
        result = await executeTool(toolName, action.args ?? {})
      } catch (e) {
        console.error(`[ai:assistant] tool ${toolName} failed`, e)
        result = TOOL_ERROR
      }

      messages.push({
        role: 'assistant',
        content: JSON.stringify({ tool: toolName, args: action.args ?? {} }),
      })
      messages.push({
        role: 'user',
        content: `TOOL_RESULT(${toolName}): ${JSON.stringify(result)}`,
      })
    }
  } catch (e) {
    if (e instanceof AiError) throw e
    console.error('[ai:assistant] unexpected error', e)
  }

  return { reply: await fallbackReply(message), toolsUsed }
}
