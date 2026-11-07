// Tool-based Persian sales assistant for the Telegram bot (Silver Love).
// The SDK has no native tool-calling, so we use a JSON tool-protocol loop:
// the model returns ONLY `{"tool":"<name>","args":{…}}` or `{"reply":"<final>"}`,
// the server executes tools against the DB and feeds results back (max 6 rounds).
// Safety: the model is never allowed to invent products/prices/stock/weight/
// fineness/shipping — every factual number in a reply must come from a
// TOOL_RESULT payload. The silver market rate may ONLY come from the
// get_silver_rate tool (never from model knowledge or the internet).
import { z } from 'zod'
import { db } from '@/lib/db'
import { chatRawMessages, tryExtractJson, AiError } from '@/lib/ai/client'
import { semanticSearch } from '@/lib/ai/embedding'
import {
  orderStatusFa,
  isBroadDiscoveryQuery,
  classifySmallTalk,
  smallTalkReplyFa,
} from '@/lib/telegram-render'

const MAX_TOOL_ITERATIONS = 6
/** protocol retries per turn — models occasionally emit non-JSON garbage */
const PROTOCOL_ATTEMPTS = 3

const SYSTEM_PROMPT = `تو نماینده فروش و مشاور فروشگاه نقره «Silver Love» در تلگرام هستی؛ حرفه‌ای، گرم و مشاوره‌محور — نه یک منوی رباتیک.

زبان و لحن (الزامی و شکست‌ناپذیر):
- همیشه فارسیِ رسمی، ادبی و محترمانه بنویس و به مشتری خطاب «شما» بده؛ از محاوره‌نویسی مطلقاً پرهیز کن. هرگز واژه‌هایی مثل «مادرمون، میخوای، چقدری، چیا، میاد، بفرما» را در پاسخ نیاور؛ معادل درست: «مادرتان، می‌خواهید، چقدر است، چه محصولاتی، بفرمایید».
- دربارهٔ اعضای خانوادهٔ مشتری با احترام سخن بگو («مادرتان»، «همسرتان»، «خواهرتان»)؛ هرگز مالکیت جمعی محاوره‌ای نساز — «مادرمون» ممنوع است.
- در سلام و احوالپرسی کوتاه و گرم جواب بده و هرگز اطلاعات سفارش‌ها را در سلام نیاور؛ سفارش‌ها فقط وقتی به موضوع پیام مربوط است یا مشتری دربارهٔ آن پرسید.
- هر پاسخ نهایی معمولاً بین ۲ تا ۵ خط باشد (فقط هنگام مقایسهٔ چند محصول طولانی‌تر شود)؛ پیام طولانی و پراکنده ممنوع. حداکثر یک تا دو ایموجی.

سبک فروش و گفتگو:
- نیازسنجی را در دل مکالمه طبیعی انجام بده: نوع محصول (انگشتر، گردنبند، دستبند، …)، برای خود مشتری است یا هدیه، سبک موردعلاقه، بودجه و در صورت لزوم سایز. هر بار فقط یک یا دو سؤال بپرس، نه یک فرم کامل.
- اگر مشتری گفت برای هدیه یا برای یک نفر (مادر، همسر، دوست، …) می‌خواهد: اول یک جملهٔ کوتاه و گرم، بعد یک یا دو سؤال نیازسنجی (سلیقه، بودجه، مناسبتی که هدیه باید حس آن را بدهد) بپرس و هنوز محصول نفرست؛ فقط وقتی مشتری سلیقه/بودجه/دسته‌اش را گفت با search_products پیشنهاد بده.
- **سؤال کلی «چیا دارید؟ / چه محصولاتی دارید؟» را هرگز با لیست یا عکس محصول جواب نده.** برای این سؤال‌های کلی: اول با get_categories دسته‌ها را ببین، بعد یک پاسخ مشاوره‌ای کوتاه بنویس که (۱) دسته‌های فروشگاه را با شمارندهٔ واقعی معرفی می‌کند، (۲) یک تا دو سؤال نیازسنجی می‌پرسد و (۳) دست مشتری را باز می‌گذارد («هر دسته‌ای که مدنظرتان بود بگویید تا بهترین گزینه‌ها را نشان بدهم»). در این حالت search_products را صدا نزن تا عکس محصول ارسال نشود — معرفی محصول بعد از این‌که مشتری دسته/سلیقه/بودجه‌اش را گفت.
- پیشنهادها را «فقط» از موجودی واقعی فروشگاه با ابزارها انتخاب کن و تفاوت‌های گزینه‌ها (قیمت، عیار، وزن، سایز، مدل) را شفاف مقایسه کن.
- به تردیدها و اعتراض‌ها (قیمت، عیار، وزن، ارسال، تعویض، اصالت) فقط با داده واقعی ابزارها یا تنظیمات فروشگاه پاسخ بده؛ اگر داده‌ای نداری، صادقانه بگو و پیشنهاد پیگیری انسانی بده.
- گاهی (نه در هر پیام) یک پیشنهاد مکمل کوتاه و مرتبط بده (مثلاً زنجیر هماهنگ با گردنبند).
- به‌طور طبیعی به خرید دعوت کن: یادآوری کن که با دکمه/منوی محصولات می‌تواند همان‌جا سفارش ثبت کند.
- پاسخ سؤال‌های ساده، کوتاه و مستقیم است؛ به هر پیام منو نچسبان و کلام رباتیک تکرار نکن.

قوانین الزامی (شکست‌ناپذیر):
- هرگز قیمت، موجودی، وزن، عیار، ضمانت، شرایط ارسال یا تخفیف از خودت نساز — همه فقط از نتایج ابزارها.
- هرگز قیمت لحظه‌ای نقره را از اینترنت یا دانش خودت نیاور؛ نرخ نقره فقط از ابزار get_silver_rate. اگر نرخ ثبت نشده بود، صادقانه بگو «نرخ نقره فعلاً در سیستم ثبت نشده است».
- قیمت هر محصول همان قیمتِ برگشتی از ابزار است؛ هرگز آن را با نرخ نقره یا وزن بازمحاسبه نکن.
- اگر پاسخ سؤالی را نداری، صادقانه اعتراف کن و ابزار request_operator را برای ارجاع به همکار انسانی بزن.
- اگر مستقیماً پرسیدند «انسان هستی؟»، صادقانه بگو دستیار هوشمند فروشگاه هستی و در صورت تمایل همکار انسانی ادامه می‌دهد؛ هرگز ادعای انسان بودن نکن.
- اطلاعات پرداخت و سیاست‌های فروشگاه فقط از ابزار get_store_policies.

پروتکل: در هر نوبت «فقط» یک شیء JSON برگردان، بدون متن اضافه، بدون markdown:
- صدا زدن ابزار: {"tool":"نام ابزار","args":{...}}
- پاسخ نهایی به کاربر: {"reply":"متن پاسخ فارسی"}

ابزارهای موجود:
- search_products → args: {"query":"متن جستجو (اختیاری)","category":"نام دسته (اختیاری)","max_price":"حداکثر قیمت تومان (اختیاری)","min_price":"حداقل قیمت (اختیاری)"}
- get_product → args: {"product_id":"شناسه محصول"}
- check_stock → args: {"product_id":"شناسه محصول"}
- compare_products → args: {"product_ids":["شناسه",...]} یا {"names":["نام محصول",...]} — حداکثر ۳ محصول
- get_categories → args: {}
- get_silver_rate → args: {} — نرخ دستی ثبت‌شده نقره در فروشگاه
- get_store_policies → args: {} — معرفی فروشگاه، سیاست‌ها و اطلاعات پرداخت کارت به کارت
- get_customer_orders → args: {"telegram_user_id":"شناسه تلگرام کاربر","limit":1 تا 5}
- request_operator → args: {"reason":"دلیل ارجاع"} — وقتی مشتری صریحاً همکار می‌خواهد یا پاسخ سؤال را نداری

نکته‌ها:
- اعداد قیمت‌ها در نتایج ابزار به تومان هستند.
- قبل از معرفی محصول، ابتدا search_products را صدا بزن؛ قیمت/موجودی را فقط از TOOL_RESULT بردار.
- اگر search_products نتیجهٔ خالی داد، هرگز نگویید «موجود نیست» — یک بار دیگر با query ساده‌تر و بدون فیلتر دسته/قیمت امتحان کن؛ فقط اگر دوباره خالی بود، صادقانه بگو و دسته‌های موجود را (از get_categories) پیشنهاد بده.
- نام دسته‌ها هرگز از خودت نساز؛ فقط همان‌هایی که get_categories برگرداند.
- شناسه تلگرام کاربر جاری در انتهای پیام او آمده؛ برای get_customer_orders همان را بفرست.
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

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

const TOOL_ERROR = { error: 'اجرای ابزار ناموفق بود' }

type ToolContext = {
  telegramUserId: string
  /** record a concrete product id that surfaced in tool results (≤3 shown to the user) */
  trackProduct: (id: string) => void
}

/** Execute one tool call against the DB. Always returns a JSON-serializable value. */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
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
      for (const h of hits) ctx.trackProduct(h.product.id)
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
      ctx.trackProduct(p.id)
      return {
        id: p.id,
        name: p.name,
        price: p.price, // final stored price (Toman) — never recomputed
        compare_at_price: p.compareAtPrice,
        stock: p.stock,
        status: p.status,
        short_description: p.shortDescription,
        description: p.description,
        category: p.category?.name ?? null,
        image_url: p.imageUrl,
        product_code: p.productCode,
        silver_type: p.silverType,
        fineness: p.fineness,
        weight_grams: p.weightGrams,
        size: p.size,
        dimensions: p.dimensions,
        brand: p.brand,
        authenticity_note: p.authenticityNote,
        care_instructions: p.careInstructions,
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

    case 'compare_products': {
      const ids = stringArray(args.product_ids).slice(0, 3)
      const names = stringArray(args.names).slice(0, 3)
      if (ids.length === 0 && names.length === 0) {
        return { error: 'product_ids یا names لازم است' }
      }
      let products
      if (ids.length > 0) {
        const rows = await db.product.findMany({
          where: { id: { in: ids }, status: 'active' },
          include: { category: { select: { name: true } } },
        })
        const order = new Map(ids.map((id, i) => [id, i]))
        products = rows
          .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
          .slice(0, 3)
      } else {
        products = await db.product.findMany({
          where: { status: 'active', OR: names.map((n) => ({ name: { contains: n } })) },
          take: 3,
          include: { category: { select: { name: true } } },
        })
      }
      if (products.length === 0) {
        return { products: [], message: 'محصول فعالی برای مقایسه یافت نشد' }
      }
      for (const p of products) ctx.trackProduct(p.id)
      return {
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          price: p.price,
          stock: p.stock,
          fineness: p.fineness,
          weight_grams: p.weightGrams,
          size: p.size,
          silver_type: p.silverType,
          product_code: p.productCode,
          category: p.category?.name ?? null,
        })),
      }
    }

    case 'get_categories': {
      const cats = await db.category.findMany({
        select: { name: true, _count: { select: { products: { where: { status: 'active' } } } } },
        orderBy: { name: 'asc' },
      })
      return cats.map((c) => ({ name: c.name, product_count: c._count.products }))
    }

    case 'get_silver_rate': {
      // Manual admin-entered reference rate — the ONLY allowed source for the
      // silver market price. Never fetched from the internet.
      const rate = await db.silverRate.findFirst({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
      })
      if (!rate) {
        return {
          rate: null,
          message: 'هیچ نرخ نقره‌ای در سیستم ثبت نشده است؛ صادقانه به مشتری بگو نرخ فعلاً ثبت نشده.',
        }
      }
      return {
        rate_per_gram: rate.ratePerGram,
        unit: rate.unit,
        note: rate.note,
        created_at: rate.createdAt.toISOString(),
      }
    }

    case 'get_store_policies': {
      const rows = await db.setting.findMany()
      const map = new Map(rows.map((r) => [r.key, r.value]))
      const dests = await db.paymentDestination.findMany({
        where: { active: true },
        orderBy: { sortOrder: 'asc' },
      })
      return {
        store_name: map.get('storeName') ?? '',
        store_description: map.get('storeDescription') ?? '',
        support_username: map.get('supportUsername') ?? '',
        shipping_policy: map.get('shippingPolicy') ?? '',
        return_policy: map.get('returnPolicy') ?? '',
        exchange_policy: map.get('exchangePolicy') ?? '',
        warranty_policy: map.get('warrantyPolicy') ?? '',
        payment_destinations: dests.map((d) => ({
          bank_name: d.bankName,
          account_holder: d.accountHolder,
          card_number: d.cardNumber,
          sheba: d.sheba,
          note: d.note,
        })),
      }
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
        select: { orderNumber: true, status: true, paymentStatus: true, total: true, createdAt: true },
      })
      return orders.map((o) => ({
        order_number: o.orderNumber,
        status_fa: orderStatusFa(o.status).label,
        payment_status: o.paymentStatus,
        total: o.total,
        created_at_short: new Intl.DateTimeFormat('fa-IR', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(o.createdAt),
      }))
    }

    case 'request_operator': {
      const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : ''
      const res = await db.customer.updateMany({
        where: { telegramUserId: ctx.telegramUserId },
        data: {
          handoffRequested: true,
          handoffNote: reason || null,
          handoffRequestedAt: new Date(),
        },
      })
      if (res.count === 0) {
        return { ok: false, message: 'مشتری در سیستم یافت نشد' }
      }
      return {
        ok: true,
        message:
          'درخواست ارجاع به همکار انسانی ثبت شد؛ به مشتری بگو به‌زودی همکار فروشگاه ادامه مکالمه را پیگیری می‌کند.',
      }
    }

    default:
      return { error: `ابزار ناشناخته: ${name}` }
  }
}

export type HistoryMessage = { role: 'user' | 'assistant'; content: string }

export type AssistantResult = { reply: string; toolsUsed: string[]; productIds: string[] }

/** Deterministic search fallback so the user always gets something useful. */
async function searchFallback(
  message: string,
  headline: string,
): Promise<{ reply: string; productIds: string[] }> {
  // small talk must NEVER turn into product cards (e.g. a «سلام» that reaches
  // the fallback path when the AI service is down)
  const small = classifySmallTalk(message)
  if (small) {
    return { reply: smallTalkReplyFa(small), productIds: [] }
  }
  const hits = await semanticSearch(message, { limit: 3 }).catch(() => [])
  const productIds = hits.map((h) => h.product.id)
  const lines: string[] = []
  if (hits.length > 0) {
    hits.forEach((h, i) => {
      const stock = h.product.stock > 0 ? `موجودی: ${faMoney(h.product.stock)} عدد` : 'ناموجود'
      lines.push(`${i + 1}. ${h.product.name} — ${faMoney(h.product.price)} تومان (${stock})`)
    })
  } else {
    lines.push('فعلاً محصولی متناسب با درخواست شما پیدا نکردم.')
  }
  const reply = [
    headline,
    '',
    ...lines,
    '',
    'برای مشاهده و سفارش از منوی محصولات استفاده کنید.',
  ].join('\n')
  return { reply, productIds }
}

/**
 * Consultative fallback (AI unreachable or unusable): a needs-assessment
 * message + the REAL store categories with counts. Deliberately NEVER says
 * "the assistant failed / is unavailable" — it just guides, and it never
 * blasts products. Used for both broad discovery and any other message that
 * reached the fallback path.
 */
async function consultativeFallback(): Promise<{ reply: string; productIds: string[] }> {
  const cats = await db.category
    .findMany({
      select: { name: true, _count: { select: { products: { where: { status: 'active' } } } } },
      orderBy: { name: 'asc' },
    })
    .catch(() => [])
  const catLines = cats.length > 0
    ? cats.map((c) => `🔹 ${c.name} (${faMoney(c._count.products)} مدل)`)
    : []
  const lines = [
    'برای اینکه دقیق‌ترین پیشنهاد را به شما بدهم، لطفاً کوتاه راهنمایی‌ام کنید:',
    '',
    '۱️⃣ برای خودتان می‌خواهید یا برای هدیه؟ (برای چه کسی؟)',
    '۲️⃣ حدود بودجه‌تان چقدر است؟',
  ]
  if (catLines.length > 0) {
    lines.push('', 'دسته‌های فروشگاه Silver Love:', ...catLines)
  }
  lines.push('', 'هر دسته یا مدلی که مدنظرتان بود را بنویسید تا بهترین گزینه‌هایش را معرفی کنم 💎')
  return { reply: lines.join('\n'), productIds: [] }
}

/** Fallback used when the panel has disabled the AI (Setting aiEnabled=false). */
export async function fallbackWithoutAi(
  message: string,
): Promise<{ reply: string; productIds: string[] }> {
  const small = classifySmallTalk(message)
  if (small) {
    return { reply: smallTalkReplyFa(small), productIds: [] }
  }
  if (isBroadDiscoveryQuery(message)) {
    return consultativeFallback()
  }
  return searchFallback(
    message,
    'پاسخ‌گویی هوشمند فعلاً غیرفعال است، اما این گزینه‌های مرتبط را برایتان پیدا کردم:',
  )
}

/** Compact customer context injected into the system prompt (from the DB only). */
async function buildCustomerContext(
  telegramUserId: string,
  firstName?: string,
): Promise<string> {
  try {
    const customer = await db.customer.findUnique({
      where: { telegramUserId },
      select: {
        firstName: true,
        handoffRequested: true,
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { orderNumber: true, status: true },
        },
        _count: { select: { orders: true } },
      },
    })
    const idLine = `- شناسه تلگرام: ${telegramUserId}`
    if (!customer) {
      const nameLine = firstName ? `\n- نام: ${firstName}` : ''
      return `📌 زمینه مشتری:\n- مشتری جدید است و هنوز سفارشی ثبت نکرده.${nameLine}\n${idLine}`
    }
    const last = customer.orders[0]
    return [
      '📌 زمینه مشتری (برای شخصی‌سازی پاسخ؛ عیناً تکرار نکن):',
      `- نام: ${customer.firstName}`,
      `- تعداد سفارش‌های گذشته: ${customer._count.orders}`,
      last
        ? `- آخرین سفارش: #${last.orderNumber} — ${orderStatusFa(last.status).label}`
        : '- هنوز سفارشی ثبت نکرده',
      customer.handoffRequested ? '- درخواست گفتگو با همکار انسانی ثبت شده است' : '',
      idLine,
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

/**
 * One assistant protocol turn with self-healing:
 *  1. ask the model, parse the protocol JSON;
 *  2. if the model answered in PLAIN TEXT (no JSON at all — models do this
 *     occasionally), salvage the text as the final reply instead of throwing
 *     it away and degrading to a search fallback;
 *  3. if it produced an invalid JSON object, retry with a corrective note.
 * Returns null when no usable turn could be produced (caller → fallback).
 * Throws AiError only for infra/rate failures (caller may rethrow).
 */
async function assistantTurn(
  messages: { role: 'assistant' | 'user'; content: string }[],
): Promise<AssistantAction | { reply: string } | null> {
  for (let attempt = 1; attempt <= PROTOCOL_ATTEMPTS; attempt++) {
    const corrective =
      attempt > 1
        ? '\n\n(پاسخ قبلی نامعتبر بود — فقط یکی از این دو را برگردان، بدون هیچ متن اضافه: {"reply":"متن پاسخ فارسی"} یا {"tool":"نام ابزار","args":{...}})'
        : ''
    const call = corrective
      ? messages.map((m, i) =>
          i === messages.length - 1 && m.role === 'user'
            ? { ...m, content: `${m.content}${corrective}` }
            : m,
        )
      : messages

    let raw = ''
    try {
      raw = (await chatRawMessages(call)).trim()
    } catch (e) {
      if (e instanceof AiError) throw e // infra/rate failure → caller decides
      throw e
    }

    const parsedRaw = tryExtractJson(raw)
    if (parsedRaw !== undefined) {
      const parsed = actionSchema.safeParse(parsedRaw)
      if (parsed.success) return parsed.data
    }

    // SALVAGE: the model skipped the JSON protocol entirely and answered in
    // plain Persian text — that IS the answer the customer should receive.
    if (
      parsedRaw === undefined &&
      raw.length > 0 &&
      raw.length <= 2500 &&
      !raw.startsWith('{') &&
      !raw.startsWith('```') &&
      /[\u0600-\u06FF]/.test(raw)
    ) {
      console.warn('[ai:assistant] model skipped JSON protocol → salvaged plain-text reply')
      return { reply: raw }
    }
  }
  return null
}

/**
 * Run the tool-loop assistant for one user message.
 * `history` carries the persistent ChatMessage memory (user+assistant turns);
 * only the system prompt + last 12 turns are sent to the model.
 * Never throws for model-behavior issues — degrades to the deterministic
 * fallback reply. Only unexpected infra failures propagate as AiError.
 */
export async function runAssistant(input: {
  telegramUserId: string
  message: string
  firstName?: string
  history?: HistoryMessage[]
  aiTone?: string
}): Promise<AssistantResult> {
  const { telegramUserId, message, firstName } = input
  // Pure small talk (سلام / ممنون / خداحافظ) → warm deterministic reply.
  // No AI call at all: zero cost, zero failure modes, always consistent.
  const smallTalk = classifySmallTalk(message)
  if (smallTalk) {
    return {
      reply: smallTalkReplyFa(smallTalk, firstName),
      toolsUsed: [],
      productIds: [],
    }
  }
  // Broad «چیا دارید؟» style questions → consult-first: the reply stays AI-
  // generated and personal, but product cards are withheld until the customer
  // names a category/taste/budget (enforced again on the bot side too).
  const broadDiscovery = isBroadDiscoveryQuery(message)
  const toolsUsed: string[] = []
  const surfacedProductIds: string[] = []
  const trackProduct = (id: string): void => {
    if (id && !surfacedProductIds.includes(id) && surfacedProductIds.length < 6) {
      surfacedProductIds.push(id)
    }
  }

  let system = SYSTEM_PROMPT
  if (input.aiTone && input.aiTone.trim()) {
    system += `\n\nلحن مکالمه فروشگاه: ${input.aiTone.trim()}`
  }
  const ctxBlock = await buildCustomerContext(telegramUserId, firstName)
  if (ctxBlock) system += `\n\n${ctxBlock}`

  const history = (input.history ?? []).slice(-12)
  const intro = firstName
    ? `${message}\n\n(نام کاربر: ${firstName} — شناسه تلگرام: ${telegramUserId})`
    : `${message}\n\n(شناسه تلگرام کاربر: ${telegramUserId})`

  const messages: { role: 'assistant' | 'user'; content: string }[] = [
    { role: 'assistant', content: system },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: intro },
  ]

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      let turn: AssistantAction | { reply: string } | null
      try {
        turn = await assistantTurn(messages)
      } catch (e) {
        if (e instanceof AiError) throw e // propagate → outer catch → AiError rethrown
        break // model never produced anything usable → deterministic fallback
      }
      if (!turn) break // no valid protocol turn → deterministic fallback

      if ('reply' in turn) {
        return {
          reply: turn.reply,
          toolsUsed,
          productIds: broadDiscovery ? [] : surfacedProductIds.slice(0, 3),
        }
      }

      const toolName = turn.tool
      toolsUsed.push(toolName)

      let result: unknown
      try {
        result = await executeTool(toolName, turn.args ?? {}, { telegramUserId, trackProduct })
      } catch (e) {
        console.error(`[ai:assistant] tool ${toolName} failed`, e)
        result = TOOL_ERROR
      }
      // ops visibility: which tool ran, with which args and what it returned
      console.log(
        `[ai:assistant] tool=${toolName} args=${JSON.stringify(turn.args ?? {}).slice(0, 200)} result=${JSON.stringify(result).slice(0, 400)}`,
      )

      messages.push({
        role: 'assistant',
        content: JSON.stringify({ tool: toolName, args: turn.args ?? {} }),
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

  // AI degraded → consultative guidance (questions + real category names).
  // Deliberately NO apologetic "the assistant could not answer" message and
  // NO product list — those confused customers (user report). Applies to
  // every message that reaches the fallback path, broad discovery included.
  const fb = await consultativeFallback()
  return { reply: fb.reply, toolsUsed, productIds: [] }
}
