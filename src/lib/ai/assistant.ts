// Silver Love — Tool-based Persian SALES assistant for the Telegram bot.
//
// The model acts as an experienced, warm silver-jewelry salesperson:
// needs discovery → consultative recommendation → objection handling →
// natural closing. It NEVER invents facts: every price/stock/spec/rate/policy
// number must come from a TOOL_RESULT. Product prices are the seller's manual
// final prices — the assistant never computes or discounts anything.
//
// Protocol (SDK has no native tool-calling): the model returns ONLY
//   {"tool":"<name>","args":{…}}  or  {"reply":"<final>", "image_products"?:[ids]}
// The server executes tools against the DB and feeds results back (max 6 rounds).
//
// Order creation is a PROPOSAL only: request_order validates items and returns
// a preview; the final order is created by the bot AFTER the customer taps the
// inline confirmation button — the customer's explicit confirmation is mandatory.
import { z } from 'zod'
import { db } from '@/lib/db'
import { chatJSONMessages, AiError } from '@/lib/ai/client'
import { semanticSearch } from '@/lib/ai/embedding'
import { orderStatusFa } from '@/lib/telegram-render'

const MAX_TOOL_ITERATIONS = 6
const HISTORY_MESSAGES = 12

const SYSTEM_PROMPT = `تو «فروشنده فروشگاه نقره Silver Love» هستی — یک فروشنده حرفه‌ای، گرم و باحوصله در تلگرام.

# شخصیت و لحن
- صمیمی، محترمانه و مشاوره‌ای؛ لحن طبیعی و انسانی، نه رباتیک و خشک.
- پاسخ سؤال ساده = پاسخ کوتاه و مستقیم. مشتریِ مشاوره‌خواه = گفتگوی طبیعی.
- اصرار و فشار نمی‌آوری؛ مشتری را با رضایت خودش به خرید می‌رسانی.
- اگر مستقیم پرسیدند انسان هستی، صادقانه بگو دستیار هوشمند Silver Love هستی و برای پیگیری انسانی می‌توانی به اپراتور وصلت کنی.

# فرایند فروش مشاوره‌ای
1. نیازسنجی طبیعی: هدف خرید (خودش/هدیه)، سبک و طراحی، بودجه، سایز، کاربرد روزمره یا مناسبت. «هر بار فقط یک سؤال» بپرس و بر اساس پاسخ قبلی ادامه بده؛ اگر مشتری محصول مشخصی خواست، مستقیم برو سراغ آن.
2. جستجوی واقعی: قبل از معرفی هر محصول حتماً search_products یا get_product صدا بزن. فقط محصول موجود (stock>0 و status=active) را قابل خرید معرفی کن.
3. معرفی: نام + قیمت دقیق از ابزار + مشخصات مهم (عیار/وزن/سایز اگر هست) + «چرا برای این مشتری مناسبه». حداکثر ۳ محصول در یک پاسخ.
4. مقایسه: اگر چند گزینه بود، تفاوت‌ها را طبیعی توضیح بده (مثلاً «این مدل ظریف‌تره و برای روزمره مناسبه، اون یکی جلوه بیشتری داره»).
5. پاسخ به اعتراض/سؤال: چرایی قیمت، تفاوت عیارها، وزن، سایز، ارسال، تعویض، ضمانت اصالت، نحوه ثبت سفارش — همه از get_store_info یا اطلاعات ابزارها. هیچ قانون/ضمانت/تخفیفی از خودت نساز.
6. پیشنهاد مکمل: در زمان مناسب یک پیشنهاد مرتبط (مثلاً دستبند هماهنگ با انگشتر) — نه بیشتر.
7. نرخ نقره: فقط از get_silver_rate؛ اگر ثبت نشده یا قدیمی است صادقانه بگو «نرخ به‌روز ثبت نشده». نرخ نقره هرگز برای محاسبه قیمت محصول استفاده نمی‌شود.

# سفارش‌گیری (خیلی مهم)
- فقط وقتی مشتری صریحاً اعلام کرد می‌خواهد بخرد: نام و نام خانوادگی، شماره موبایل و آدرس را مرحله‌به‌مرحله بگیر.
- سپس خلاصه سفارش (محصولات، تعداد، مبلغ کل از ابزار، نام، موبایل، آدرس) را بنویس و تأیید صریح بگیر.
- فقط بعد از تأیید صریح مشتری، ابزار request_order را صدا بزن.
- هرگز خودت سفارش نساز، مبلغ نساز یا تخفیف نده.

# ابزارها (پروتکل)
در هر نوبت «فقط» یک شیء JSON، بدون متن اضافه و بدون markdown:
- صدا زدن ابزار: {"tool":"نام ابزار","args":{...}}
- پاسخ نهایی: {"reply":"متن فارسی","image_products":["شناسه محصولات برای ارسال عکس"]}

- search_products → {"query":"متن (اختیاری)","category":"نام دسته (اختیاری)","max_price":"حداکثر تومان (اختیاری)","min_price":"حداقل (اختیاری)"}
- get_product → {"product_id":"شناسه"}
- check_stock → {"product_id":"شناسه"}
- get_categories → {}
- compare_products → {"product_ids":["شناسه ۱","شناسه ۲"]}
- get_customer_orders → {"telegram_user_id":"شناسه تلگرام کاربر","limit":1 تا 5}
- get_silver_rate → {}
- get_store_info → {}
- transfer_to_operator → {"summary":"خلاصه مکالمه و نیاز مشتری برای اپراتور"}

قواعد قطعی:
- قیمت/موجودی/وزن/عیار/سایز/ضمانت/ارسال/تخفیف را هرگز حدس نزن؛ فقط از TOOL_RESULT.
- image_products فقط وقتی محصول واقعی با عکس معرفی می‌کنی (حداکثر ۳ شناسه).
- اگر ابزار خطا داد یا نتیجه‌ای نبود، صادقانه بگو و ابزار دیگری امتحان کن؛ اطلاعات نبود ⇒ صادقانه اعلام کن و در صورت نیاز transfer_to_operator.
- قیمت‌ها در TOOL_RESULT به تومان است.`

const finalActionSchema = z.object({
  reply: z.string().min(1),
  image_products: z.array(z.string()).max(3).optional(),
})

const actionSchema = z.union([
  finalActionSchema,
  z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }),
])

type AssistantAction = z.infer<typeof actionSchema>

export type AssistantActionPayload = {
  type: 'create_order'
  items: Array<{ productId: string; quantity: number }>
  name: string
  phone: string
  address: string
}

export type AssistantResult = {
  reply: string
  /** product image URLs (relative) the bot should send after the text */
  images: string[]
  toolsUsed: string[]
  /** validated order proposal — the bot asks for the customer's explicit tap before executing */
  action?: AssistantActionPayload
  /** operator handoff request with conversation summary */
  handoff?: { summary: string }
}

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

function specLines(p: {
  purity: string | null
  weightGrams: number | null
  size: string | null
  silverType: string | null
  sku: string | null
}) {
  const specs: Record<string, string | number | null> = {}
  if (p.sku) specs.sku = p.sku
  if (p.silverType) specs.silver_type = p.silverType
  if (p.purity) specs.purity = p.purity
  if (p.weightGrams != null && p.weightGrams > 0) specs.weight_grams = p.weightGrams
  if (p.size) specs.size = p.size
  return specs
}

type ToolCtx = {
  pendingAction?: AssistantActionPayload
  pendingHandoff?: { summary: string }
  /** product image URLs collected for the final reply */
  pendingImages: string[]
}

/** Execute one tool call against the DB. Always returns a JSON-serializable value. */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
  telegramUserId: string,
): Promise<unknown> {
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
        status: h.product.status,
        short_description: h.product.shortDescription,
        has_image: Boolean(h.product.imageUrl),
        ...specLines(h.product),
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
        care_instructions: p.careInstructions,
        authenticity: p.authenticity,
        ...specLines(p),
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

    case 'compare_products': {
      const ids = Array.isArray(args.product_ids)
        ? args.product_ids.filter((v): v is string => typeof v === 'string').slice(0, 4)
        : []
      if (ids.length < 2) return { error: 'حداقل دو product_ids لازم است' }
      const rows = await db.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, name: true, price: true, stock: true, status: true,
          shortDescription: true, purity: true, weightGrams: true, size: true, silverType: true,
        },
      })
      return rows
    }

    case 'get_customer_orders': {
      const limitRaw = toFiniteNumber(args.limit)
      const limit = Math.min(5, Math.max(1, Math.trunc(limitRaw ?? 5)))
      const customer = await db.customer.findUnique({ where: { telegramUserId } })
      if (!customer) return []
      const orders = await db.order.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { orderNumber: true, status: true, total: true, createdAt: true, payment: { select: { status: true } } },
      })
      return orders.map((o) => ({
        order_number: o.orderNumber,
        status_fa: orderStatusFa(o.status).label,
        payment_status: o.payment?.status ?? null,
        total: o.total,
        created_at_short: new Intl.DateTimeFormat('fa-IR', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(o.createdAt),
      }))
    }

    case 'get_silver_rate': {
      const rate = await db.silverRate.findFirst({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
      })
      if (!rate) {
        return { registered: false, note: 'هیچ نرخ نقره‌ای توسط فروشگاه ثبت نشده است' }
      }
      return {
        registered: true,
        price_per_gram_toman: rate.pricePerGram,
        unit: rate.unit,
        set_at: rate.createdAt,
        note: rate.note,
        warning: 'این نرخ صرفاً مرجع است و در قیمت محصولات محاسبه نمی‌شود',
      }
    }

    case 'get_store_info': {
      const [rows, bank] = await Promise.all([
        db.setting.findMany({
          where: {
            key: {
              in: ['storeName', 'storeDescription', 'shippingPolicy', 'returnPolicy', 'warrantyPolicy', 'paymentNote', 'supportUsername'],
            },
          },
        }),
        db.bankAccount.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } }),
      ])
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
      return {
        store_name: map['storeName'] ?? 'Silver Love',
        description: map['storeDescription'] ?? null,
        shipping_policy: map['shippingPolicy'] || 'ثبت نشده',
        return_policy: map['returnPolicy'] || 'ثبت نشده',
        warranty_policy: map['warrantyPolicy'] || 'ثبت نشده',
        payment_note: map['paymentNote'] || 'ثبت نشده',
        support_username: map['supportUsername'] || null,
        bank_destination: bank
          ? { bank: bank.bankName, holder: bank.holderName, card: bank.cardNumber }
          : null,
      }
    }

    case 'transfer_to_operator': {
      const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, 800) : ''
      ctx.pendingHandoff = { summary }
      return {
        ok: true,
        note: 'درخواست انتقال ثبت شد — در پاسخ نهایی به مشتری بگو به همکار ما وصلش می‌کنی',
      }
    }

    case 'request_order': {
      // PROPOSAL ONLY — the bot creates the order after the customer's explicit tap
      if (ctx.pendingAction) return { error: 'در این پیام قبلاً یک سفارش پیشنهاد شده است' }
      const rawItems = Array.isArray(args.items) ? args.items : []
      const items: Array<{ productId: string; quantity: number }> = []
      for (const it of rawItems.slice(0, 10)) {
        if (!it || typeof it !== 'object') continue
        const rec = it as Record<string, unknown>
        const productId = typeof rec.product_id === 'string' ? rec.product_id : ''
        const qty = toFiniteNumber(rec.quantity) ?? 1
        if (!productId || qty < 1) continue
        items.push({ productId, quantity: Math.min(99, Math.trunc(qty)) })
      }
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const phone = typeof args.phone === 'string' ? args.phone.trim() : ''
      const address = typeof args.address === 'string' ? args.address.trim() : ''
      if (items.length === 0 || !name || !phone || !address) {
        return { error: 'items، name، phone و address الزامی هستند' }
      }
      // validate from DB — real totals only
      const products = await db.product.findMany({
        where: { id: { in: items.map((i) => i.productId) } },
        select: { id: true, name: true, price: true, stock: true, status: true },
      })
      if (products.length !== items.length) {
        return { error: 'برخی محصولات یافت نشدند' }
      }
      const lines = []
      let total = 0
      for (const it of items) {
        const p = products.find((x) => x.id === it.productId)!
        if (p.status !== 'active' || p.stock < it.quantity) {
          return { error: `محصول «${p.name}» فعال نیست یا موجودی کافی ندارد (${p.stock})` }
        }
        const lineTotal = p.price * it.quantity
        total += lineTotal
        lines.push({ product: p.name, quantity: it.quantity, unit_price: p.price, total: lineTotal })
      }
      ctx.pendingAction = { type: 'create_order', items, name, phone, address }
      return {
        proposal_created: true,
        total_toman: total,
        lines,
        customer: { name, phone, address },
        note: 'پیشنهاد ثبت شد؛ سفارش نهایی فقط پس از تأیید دکمه‌ای مشتری توسط ربات ساخته می‌شود. به مشتری بگو برای ثبت، روی دکمه تأیید بزند.',
      }
    }

    default:
      return { error: `ابزار ناشناخته: ${name}` }
  }
}

// ─── Conversation memory (survives restarts — DB-backed) ────────────────────

async function loadHistory(telegramUserId: string) {
  try {
    const rows = await db.conversationMessage.findMany({
      where: { telegramUserId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_MESSAGES,
    })
    return rows
      .reverse()
      .map((r) => ({ role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: r.content }))
  } catch {
    return []
  }
}

async function saveTurn(telegramUserId: string, userMessage: string, assistantReply: string) {
  try {
    await db.conversationMessage.createMany({
      data: [
        { telegramUserId, role: 'user', content: userMessage.slice(0, 2000) },
        { telegramUserId, role: 'assistant', content: assistantReply.slice(0, 4000) },
      ],
    })
    // keep the tail bounded
    const count = await db.conversationMessage.count({ where: { telegramUserId } })
    if (count > 60) {
      const old = await db.conversationMessage.findMany({
        where: { telegramUserId },
        orderBy: { createdAt: 'asc' },
        take: count - 60,
        select: { id: true },
      })
      await db.conversationMessage.deleteMany({ where: { id: { in: old.map((r) => r.id) } } })
    }
  } catch {
    // memory is best-effort
  }
}

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
  const ctx: ToolCtx = { pendingImages: [] }

  const intro = firstName
    ? `${message}\n\n(نام کاربر: ${firstName} — شناسه تلگرام: ${telegramUserId})`
    : `${message}\n\n(شناسه تلگرام کاربر: ${telegramUserId})`

  const history = await loadHistory(telegramUserId)
  const messages: { role: 'assistant' | 'user'; content: string }[] = [
    { role: 'assistant', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: intro },
  ]

  let finalReply: string | null = null
  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      let action: AssistantAction
      try {
        action = await chatJSONMessages(messages, actionSchema, 2)
      } catch {
        break // model never produced valid protocol JSON → deterministic fallback
      }

      if ('reply' in action) {
        finalReply = action.reply
        // resolve requested product images
        const ids = action.image_products ?? []
        if (ids.length > 0) {
          const rows = await db.product.findMany({
            where: { id: { in: ids }, imageUrl: { not: null } },
            select: { imageUrl: true },
          })
          ctx.pendingImages = rows
            .map((r) => r.imageUrl)
            .filter((v): v is string => Boolean(v))
            .slice(0, 3)
        }
        break
      }

      const toolName = action.tool
      toolsUsed.push(toolName)

      let result: unknown
      try {
        result = await executeTool(toolName, action.args ?? {}, ctx, telegramUserId)
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

  if (finalReply === null) {
    finalReply = await fallbackReply(message)
  }

  await saveTurn(telegramUserId, message, finalReply)

  return {
    reply: finalReply,
    images: ctx.pendingImages,
    toolsUsed,
    action: ctx.pendingAction,
    handoff: ctx.pendingHandoff,
  }
}
