/**
 * Silver Love seed — Persian silver-store demo data.
 * Run: bun scripts/seed.ts          (idempotent — skips if already seeded)
 *      bun scripts/seed.ts --reset  (wipes tables first, PRESERVING the
 *                                    Telegram panel connection + admin user)
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { upsertProductEmbedding } from '../src/lib/ai/embedding'

const db = new PrismaClient()

const daysAgo = (n: number, h = 12) => new Date(Date.now() - n * 24 * 3600 * 1000 + h * 3600 * 1000)

/** Keys that must survive a reset (panel Telegram connection, AI switch, …). */
const PROTECTED_SETTING_PREFIXES = ['telegram', 'aiAssistant']

async function reset() {
  // stash protected settings (Telegram panel connection, AI switch, …)
  const all = await db.setting.findMany()
  const keep = all.filter((r) => PROTECTED_SETTING_PREFIXES.some((p) => r.key.startsWith(p)))

  await db.paymentEvent.deleteMany()
  await db.payment.deleteMany()
  await db.conversationMessage.deleteMany()
  await db.activityLog.deleteMany()
  await db.orderItem.deleteMany()
  await db.order.deleteMany()
  await db.productEmbedding.deleteMany()
  await db.telegramProduct.deleteMany()
  await db.botSession.deleteMany()
  await db.productImage.deleteMany()
  await db.product.deleteMany()
  await db.category.deleteMany()
  await db.customer.deleteMany()
  await db.session.deleteMany()
  await db.user.deleteMany()
  await db.setting.deleteMany()
  await db.counter.deleteMany()
  await db.bankAccount.deleteMany()
  await db.silverRate.deleteMany()

  // restore protected settings
  for (const row of keep) {
    await db.setting.create({ data: { key: row.key, value: row.value } })
  }
}

async function main() {
  const existing = await db.product.count()
  if (existing > 0 && !process.argv.includes('--reset')) {
    console.log('⏭️  already seeded — use --reset to reseed')
    return
  }
  if (process.argv.includes('--reset')) await reset()

  // ── Admin user ──────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('admin1234', 10)
  await db.user.upsert({
    where: { email: 'admin@shop.local' },
    create: { email: 'admin@shop.local', name: 'مدیر Silver Love', passwordHash, role: 'admin' },
    update: { name: 'مدیر Silver Love' },
  })
  console.log('✓ admin user (admin@shop.local / admin1234)')

  // ── Settings ────────────────────────────────────────────────────────────
  const settings: Array<[string, string]> = [
    ['storeName', 'Silver Love'],
    ['storeDescription', 'فروشگاه تخصصی نقره — اصالت، ظرافت و قیمت منصفانه. خرید آسان از طریق تلگرام.'],
    ['supportUsername', 'silverlove_support'],
    ['currency', 'IRT'],
    ['shippingPolicy', 'ارسال به سراسر کشور با پست پیشتاز و بیمه کامل مرسوله. تهران: ۱ تا ۲ روز کاری. شهرستان‌ها: ۲ تا ۴ روز کاری.'],
    ['returnPolicy', 'تا ۷ روز پس از دریافت، در صورت عدم استفاده و سالم بودن بسته‌بندی، امکان بازگشت کالا وجود دارد. هزینه ارسال مرجوعی بر عهده خریدار است.'],
    ['warrantyPolicy', 'همه محصولات نقره ۹۲۵ با ضمانت اصالت و عیار عرضه می‌شوند. در صورت مغایرت عیار، مبلغ کامل بازگردانده می‌شود.'],
    ['paymentNote', 'پس از ثبت سفارش، مبلغ را به کارت فروشگاه واریز کنید و تصویر رسید را در همین ربات ارسال نمایید. تأیید نهایی پرداخت توسط ادمین انجام می‌شود.'],
    ['aiAssistantEnabled', 'true'],
  ]
  for (const [key, value] of settings) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  console.log('✓ settings')

  // ── Categories ──────────────────────────────────────────────────────────
  const catData = [
    { name: 'انگشتر', slug: 'ring', description: 'انگشترهای نقره مردانه و زنانه با طرح‌های دست‌ساز و مدرن' },
    { name: 'دستبند', slug: 'bracelet', description: 'دستبندهای نقره ظریف و چرم‌دوزی‌شده' },
    { name: 'گردنبند و آویز', slug: 'necklace', description: 'گردنبندها و آویزهای نقره با طراحی خاص' },
    { name: 'گوشواره', slug: 'earring', description: 'گوشواره‌های نقره روزمره و مجلسی' },
    { name: 'سرویس نقره', slug: 'set', description: 'سرویس‌های هماهنگ نقره برای هدیه' },
    { name: 'شمش و سرمایه‌ای', slug: 'bullion', description: 'شمش‌های نقره با عیار بالا، مناسب پس‌انداز' },
  ]
  const cats: Record<string, string> = {}
  for (const c of catData) {
    const row = await db.category.upsert({
      where: { slug: c.slug },
      create: c,
      update: { name: c.name, description: c.description },
    })
    cats[c.slug] = row.id
  }
  console.log(`✓ ${catData.length} categories`)

  // ── Products ────────────────────────────────────────────────────────────
  type P = {
    name: string; slug: string; cat: string; price: number; compareAtPrice?: number
    stock: number; status: string; shortDescription: string; description: string
    tags: string[]; lowStockThreshold?: number
    sku?: string; silverType?: string; purity?: string; weightGrams?: number
    size?: string; dimensions?: string; brand?: string; appearance?: string
    careInstructions?: string; authenticity?: string
  }
  const products: P[] = [
    {
      name: 'انگشتر نقره مردانه مدل اژدها', slug: 'silver-ring-dragon', cat: 'ring',
      price: 2450000, stock: 8, status: 'active',
      sku: 'SL-RG-101', silverType: 'نقره دست‌ساز', purity: '925', weightGrams: 12.5,
      size: '۶۲ (اندازه ۲۲)', dimensions: 'قطر صفحه ۱۸ میلی‌متر', brand: 'Silver Love',
      appearance: 'نقش اژدها به‌صورت برجسته، پرداخت مات و براق ترکیبی',
      careInstructions: 'دور از عطر و مواد شیمیایی نگهداری شود؛ با دستمال نقره‌شوی تمیز کنید.',
      authenticity: 'دارای مهر عیار ۹۲۵ و ضمانت اصالت Silver Love',
      shortDescription: 'انگشتر مردانه نقره ۹۲۵ دست‌ساز با نقش برجسته اژدها — سنگین، خوش‌دست و خاص.',
      description: 'انگشتر اژدها از نقره عیار ۹۲۵ با وزن ۱۲٫۵ گرم، کاملاً دست‌ساز و با پرداخت ترکیبی مات و براق. طراحی برجسته اژدها برای علاقه‌مندان به استایل خاص و مردانه. حلقه‌ی محکم و خوش‌دست که روزمره هم دوام دارد.',
      tags: ['انگشتر مردانه', 'دست‌ساز', 'نقره ۹۲۵', 'اژدها'],
    },
    {
      name: 'انگشتر نقره زنانه ظریف با نگین آیکون', slug: 'silver-ring-zircon', cat: 'ring',
      price: 1380000, compareAtPrice: 1650000, stock: 14, status: 'active',
      sku: 'SL-RG-205', silverType: 'نقره ماشین‌ساز', purity: '925', weightGrams: 3.2,
      size: '۵۴ تا ۵۸ (قابل انتخاب)', brand: 'Silver Love',
      appearance: 'حلقه ظریف با نگین آیکون سفید و پرداخت براق',
      careInstructions: 'با دستمال نرم تمیز شود؛ هنگام شست‌وشو دست کند.',
      authenticity: 'دارای مهر عیار ۹۲۵',
      shortDescription: 'انگشتر ظریف نقره ۹۲۵ با نگین آیکون — انتخابی شیک برای استفاده روزمره.',
      description: 'انگشتر ظریف با نگین آیکون سفید، سبک و راحت برای استفاده هر روزه. پرداخت آینه‌ای نقره ۹۲۵ و قفل‌بندی دقیق سایزها (۵۴ تا ۵۸). مناسب هدیه هم هست.',
      tags: ['انگشتر زنانه', 'ظریف', 'نگین', 'هدیه'],
    },
    {
      name: 'دستبند نقره چرم‌دوزی مردانه', slug: 'silver-bracelet-leather', cat: 'bracelet',
      price: 1650000, stock: 3, status: 'active', lowStockThreshold: 5,
      sku: 'SL-BR-310', silverType: 'نقره دست‌ساز', purity: '925', weightGrams: 8.4,
      size: 'قابل تنظیم ۱۸ تا ۲۲ سانتی‌متر', brand: 'Silver Love',
      appearance: 'حلقه‌های نقره روی بند چرم طبیعی قهوه‌ای',
      careInstructions: 'چرم را خیس نکنید؛ نقره را با دستمال نقره‌شوی تمیز کنید.',
      authenticity: 'دارای مهر عیار ۹۲۵ و ضمانت دوخت چرم',
      shortDescription: 'دستبند ترکیبی نقره و چرم طبیعی — اسپرت، خوش‌دست و قابل تنظیم.',
      description: 'دستبند چرم‌دوزی با ۵ حلقه نقره ۹۲۵ دست‌ساز روی چرم طبیعی گاوی. قفل گیره‌ای استیل قابل تنظیم برای دور مچ ۱۸ تا ۲۲ سانتی‌متر. ترکیبی از استایل کژوال و اصالت نقره.',
      tags: ['دستبند مردانه', 'چرم', 'قابل تنظیم'],
    },
    {
      name: 'دستبند زنجیری نقره زنانه مدل نور', slug: 'silver-bracelet-noor', cat: 'bracelet',
      price: 1950000, stock: 10, status: 'active',
      sku: 'SL-BR-402', silverType: 'نقره ماشین‌ساز', purity: '925', weightGrams: 6.8,
      size: '۱۷ سانتی‌متر + طوله ۲ سانتی‌متری', brand: 'Silver Love',
      appearance: 'زنجیر حلقه‌ای ظریف با آویز قلب مینی',
      careInstructions: 'دور از آب و مواد شوینده نگهداری شود.',
      authenticity: 'دارای مهر عیار ۹۲۵',
      shortDescription: 'دستبند زنجیری ظریف نقره ۹۲۵ با آویز قلب — مناسب استفاده روزمره و مجلسی.',
      description: 'دستبند زنجیری مدل نور با پرداخت براق و آویز قلب مینی. وزن متعادل ۶٫۸ گرم و قفل جفتی مطمئن. هم تنهایی زیباست و هم با گردنبند هم‌راستا ست می‌شود.',
      tags: ['دستبند زنانه', 'زنجیری', 'آویز قلب'],
    },
    {
      name: 'گردنبند نقره با آویز ماه و ستاره', slug: 'silver-necklace-moon', cat: 'necklace',
      price: 2280000, compareAtPrice: 2600000, stock: 12, status: 'active',
      sku: 'SL-NK-501', silverType: 'نقره دست‌ساز', purity: '925', weightGrams: 7.5,
      dimensions: 'آویز ۲×۱٫۵ سانتی‌متر، زنجیر ۴۵ سانتی‌متر', brand: 'Silver Love',
      appearance: 'آویز ماه و ستاره با پرداخت دورنگ (طلایی‌پوش روی نقره)',
      careInstructions: 'پرداخت دورنگ را با دستمال خشک تمیز کنید.',
      authenticity: 'دارای مهر عیار ۹۲۵ و ضمانت پرداخت',
      shortDescription: 'گردنبند نقره ۹۲۵ با آویز ماه و ستاره و پرداخت دورنگ خاص.',
      description: 'گردنبند ماه و ستاره با آویز دست‌ساز نقره ۹۲۵ و پرداخت دورنگ نقره/طلایی. زنجیر حلقه‌ای ۴۵ سانتی‌متری با قفل مطمئن. انتخابی محبوب برای هدیه.',
      tags: ['گردنبند', 'ماه و ستاره', 'هدیه', 'دست‌ساز'],
    },
    {
      name: 'گوشواره حلقه‌ای نقره کلاسیک', slug: 'silver-earring-hoop', cat: 'earring',
      price: 990000, stock: 18, status: 'active',
      sku: 'SL-ER-611', silverType: 'نقره ماشین‌ساز', purity: '925', weightGrams: 2.6,
      dimensions: 'قطر ۱۵ میلی‌متر', brand: 'Silver Love',
      appearance: 'حلقه‌ای ساده با سطح آینه‌ای',
      careInstructions: 'پس از استفاده در جعبه نگهداری شود.',
      authenticity: 'دارای مهر عیار ۹۲۵',
      shortDescription: 'گوشواره حلقه‌ای کلاسیک نقره ۹۲۵ — سبک، براق و همیشه شیک.',
      description: 'گوشواره حلقه‌ای با قطر ۱۵ میلی‌متر و وزن سبک ۲٫۶ گرم برای هر گوش. قفل فنری دقیق و پرداخت آینه‌ای. مناسب هر استایل از روزمره تا مجلسی.',
      tags: ['گوشواره', 'حلقه‌ای', 'کلاسیک'],
    },
    {
      name: 'سرویس نقره چهارتیکه مدل ارکیده', slug: 'silver-set-orchid', cat: 'set',
      price: 7800000, compareAtPrice: 8900000, stock: 2, status: 'active', lowStockThreshold: 3,
      sku: 'SL-ST-710', silverType: 'نقره دست‌ساز', purity: '925', weightGrams: 28.0,
      dimensions: 'جعبه هدیه ۲۰×۱۵ سانتی‌متر', brand: 'Silver Love',
      appearance: 'گردنبند + دستبند + انگشتر + گوشواره با طرح گل ارکیده',
      careInstructions: 'هر قطعه جداگانه در کیسه پارچه‌ای نگهداری شود.',
      authenticity: 'دارای مهر عیار ۹۲۵ روی همه قطعات + گارانتی اصالت Silver Love',
      shortDescription: 'سرویس کامل چهارتیکه نقره ۹۲۵ دست‌ساز با جعبه هدیه لوکس.',
      description: 'سرویس ارکیده شامل گردنبند، دستبند، انگشتر و گوشواره با یک طرح هماهنگ گل ارکیده. مجموعاً ۲۸ گرم نقره ۹۲۵ دست‌ساز با پرداخت براق. همراه جعبه چوبی هدیه — انتخاب اول برای مناسبت‌های مهم.',
      tags: ['سرویس نقره', 'هدیه', 'دست‌ساز', 'جعبه هدیه'],
    },
    {
      name: 'شمش نقره ۵۰ گرمی عیار ۹۹۹', slug: 'silver-bullion-50g', cat: 'bullion',
      price: 5600000, stock: 6, status: 'active',
      sku: 'SL-BL-999-50', silverType: 'شمش سرمایه‌ای', purity: '999', weightGrams: 50.0,
      dimensions: '۵۰×۲۹×۵ میلی‌متر', brand: 'Silver Love',
      appearance: 'شمش کپسول‌دار با حک شماره سریال منحصربه‌فرد',
      careInstructions: 'کپسول را باز نکنید؛ در جای خشک نگهداری کنید.',
      authenticity: 'شماره سریال ثبت‌شده + گواهی اصالت چاپی',
      shortDescription: 'شمش نقره خالص ۹۹۹ با وزن ۵۰ گرم، کپسول‌دار و همراه گواهی اصالت.',
      description: 'شمش نقره ۵۰ گرمی با عیار ۹۹۹ (خالص)، داخل کپسول محافظ و همراه گواهی اصالت با شماره سریال ثبت‌شده. مناسب پس‌انداز و هدیه سرمایه‌ای.',
      tags: ['شمش نقره', 'سرمایه‌ای', 'عیار ۹۹۹', 'گواهی اصالت'],
    },
    {
      name: 'شمش نقره ۱۰ گرمی هدیه', slug: 'silver-bullion-10g', cat: 'bullion',
      price: 1180000, stock: 0, status: 'out_of_stock',
      sku: 'SL-BL-999-10', silverType: 'شمش سرمایه‌ای', purity: '999', weightGrams: 10.0,
      dimensions: '۳۰×۱۸×۳ میلی‌متر', brand: 'Silver Love',
      appearance: 'شمش کپسول‌دار با طراحی هدیه',
      careInstructions: 'کپسول را باز نکنید.',
      authenticity: 'شماره سریال ثبت‌شده + گواهی اصالت',
      shortDescription: 'شمش نقره ۱۰ گرمی عیار ۹۹۹ با طراحی هدیه — مناسب شروع پس‌انداز نقره.',
      description: 'شمش ۱۰ گرمی نقره خالص ۹۹۹ داخل کپسول محافظ با بسته‌بندی هدیه و گواهی اصالت. کم‌حجم، باارزش و مناسب مناسبت‌ها.',
      tags: ['شمش نقره', 'هدیه', 'عیار ۹۹۹'],
    },
    {
      name: 'نیم‌ست نقره مدل بهار (پیش‌نمایش)', slug: 'silver-half-set-bahar', cat: 'set',
      price: 3450000, stock: 4, status: 'draft',
      sku: 'SL-ST-802', silverType: 'نقره دست‌ساز', purity: '925', weightGrams: 15.2,
      brand: 'Silver Love',
      appearance: 'گردنبند و گوشواره هماهنگ با طرح شاخه‌های بهاری',
      careInstructions: 'با دستمال نقره‌شوی تمیز کنید.',
      authenticity: 'دارای مهر عیار ۹۲۵',
      shortDescription: 'نیم‌ست گردنبند و گوشواره نقره ۹۲۵ دست‌ساز — به‌زودی.',
      description: 'نیم‌ست بهار با طرح شاخه‌های گل بهاری، دست‌ساز نقره ۹۲۵ و مجموع وزن ۱۵٫۲ گرم. این محصول در حال آماده‌سازی است و به‌زودی فعال می‌شود.',
      tags: ['نیم‌ست', 'دست‌ساز', 'به‌زودی'],
    },
  ]

  const productIds: Record<string, string> = {}
  for (const p of products) {
    const row = await db.product.upsert({
      where: { slug: p.slug },
      create: {
        name: p.name, slug: p.slug, description: p.description, shortDescription: p.shortDescription,
        price: p.price, compareAtPrice: p.compareAtPrice ?? null, stock: p.stock,
        categoryId: cats[p.cat], imageUrl: null, status: p.status, tags: JSON.stringify(p.tags),
        lowStockThreshold: p.lowStockThreshold ?? 5,
        sku: p.sku ?? null, silverType: p.silverType ?? null, purity: p.purity ?? null,
        weightGrams: p.weightGrams ?? null, size: p.size ?? null, dimensions: p.dimensions ?? null,
        brand: p.brand ?? null, appearance: p.appearance ?? null,
        careInstructions: p.careInstructions ?? null, authenticity: p.authenticity ?? null,
      },
      update: {
        price: p.price, stock: p.stock, status: p.status,
        categoryId: cats[p.cat], description: p.description, shortDescription: p.shortDescription,
        tags: JSON.stringify(p.tags), compareAtPrice: p.compareAtPrice ?? null,
        sku: p.sku ?? null, silverType: p.silverType ?? null, purity: p.purity ?? null,
        weightGrams: p.weightGrams ?? null, size: p.size ?? null, dimensions: p.dimensions ?? null,
        brand: p.brand ?? null, appearance: p.appearance ?? null,
        careInstructions: p.careInstructions ?? null, authenticity: p.authenticity ?? null,
      },
    })
    productIds[p.slug] = row.id
    await upsertProductEmbedding(row.id).catch((e) => console.error('embed fail', p.name, e.message))
  }
  console.log(`✓ ${products.length} silver products (+embeddings)`)

  // ── Silver rate (manual, reference only) ────────────────────────────────
  await db.silverRate.create({
    data: {
      pricePerGram: 98000,
      unit: 'تومان/گرم',
      note: 'نرخ نمونه اولیه — هر روز توسط ادمین به‌روزرسانی می‌شود',
      active: true,
      createdByEmail: 'admin@shop.local',
    },
  })
  console.log('✓ initial silver rate (98,000 تومان/گرم — sample)')

  // ── Bank account (sample data — replace from the panel) ─────────────────
  await db.bankAccount.create({
    data: {
      bankName: 'بانک نمونه',
      holderName: 'Silver Love',
      cardNumber: '6104-XXXX-XXXX-XXXX',
      note: 'اطلاعات نمونه — از بخش «پرداخت» پنل، کارت واقعی خود را ثبت کنید',
      active: true,
    },
  })
  console.log('✓ sample bank account')

  // ── Customers ───────────────────────────────────────────────────────────
  const custData = [
    { telegramUserId: '701100001', telegramUsername: 'amir_h', firstName: 'امیر', lastName: 'حساری', phone: '09121110001', address: 'تهران، خیابان ولیعصر، کوچه بهار، پلاک ۱۲، واحد ۳' },
    { telegramUserId: '701100002', telegramUsername: 'sara_m', firstName: 'سارا', lastName: 'محمدی', phone: '09352220002', address: 'اصفهان، خیابان چهارباغ بالا، کوچه گلستان، پلاک ۸' },
    { telegramUserId: '701100003', telegramUsername: 'reza_k', firstName: 'رضا', lastName: 'کریمی', phone: '09193330003', address: 'شیراز، بلوار زند، ساختمان نور، طبقه ۲' },
    { telegramUserId: '701100004', telegramUsername: 'maryam_a', firstName: 'مریم', lastName: 'احمدی', phone: '09364440004', address: 'مشهد، بلوار وکیل‌آباد، خیابان لادن، پلاک ۲۱' },
  ]
  const custIds: Record<string, string> = {}
  for (const c of custData) {
    const row = await db.customer.upsert({
      where: { telegramUserId: c.telegramUserId },
      create: c,
      update: { firstName: c.firstName, lastName: c.lastName, phone: c.phone, address: c.address },
    })
    custIds[c.telegramUserId] = row.id
  }
  console.log(`✓ ${custData.length} customers`)

  // ── Orders (with payment lifecycle) ─────────────────────────────────────
  type OI = { slug: string; qty: number }
  type O = {
    n: number; cust: string; status: string; created: Date; phone: string; address: string; name: string; items: OI[]
    payment?: { status: string; reviewedByEmail?: string; rejectReason?: string }
  }
  const orders: O[] = [
    { n: 1001, cust: '701100001', status: 'completed', created: daysAgo(9), name: 'امیر حساری', phone: '09121110001', address: 'تهران، خیابان ولیعصر، کوچه بهار، پلاک ۱۲، واحد ۳', items: [{ slug: 'silver-ring-dragon', qty: 1 }], payment: { status: 'paid', reviewedByEmail: 'admin@shop.local' } },
    { n: 1002, cust: '701100002', status: 'completed', created: daysAgo(6), name: 'سارا محمدی', phone: '09352220002', address: 'اصفهان، خیابان چهارباغ بالا، کوچه گلستان، پلاک ۸', items: [{ slug: 'silver-necklace-moon', qty: 1 }, { slug: 'silver-earring-hoop', qty: 2 }], payment: { status: 'paid', reviewedByEmail: 'admin@shop.local' } },
    { n: 1003, cust: '701100003', status: 'cancelled', created: daysAgo(4), name: 'رضا کریمی', phone: '09193330003', address: 'شیراز، بلوار زند، ساختمان نور، طبقه ۲', items: [{ slug: 'silver-set-orchid', qty: 1 }] },
    { n: 1004, cust: '701100001', status: 'shipped', created: daysAgo(2), name: 'امیر حساری', phone: '09121110001', address: 'تهران، خیابان ولیعصر، کوچه بهار، پلاک ۱۲، واحد ۳', items: [{ slug: 'silver-bullion-50g', qty: 1 }], payment: { status: 'paid', reviewedByEmail: 'admin@shop.local' } },
    { n: 1005, cust: '701100002', status: 'confirmed', created: daysAgo(1), name: 'سارا محمدی', phone: '09352220002', address: 'اصفهان، خیابان چهارباغ بالا، کوچه گلستان، پلاک ۸', items: [{ slug: 'silver-bracelet-leather', qty: 1 }], payment: { status: 'paid', reviewedByEmail: 'admin@shop.local' } },
    { n: 1006, cust: '701100004', status: 'pending', created: daysAgo(0, 2), name: 'مریم احمدی', phone: '09364440004', address: 'مشهد، بلوار وکیل‌آباد، خیابان لادن، پلاک ۲۱', items: [{ slug: 'silver-ring-zircon', qty: 1 }, { slug: 'silver-bracelet-noor', qty: 1 }], payment: { status: 'payment_review' } },
  ]

  for (const o of orders) {
    const itemsData = [] as Array<{ productId: string; productNameSnapshot: string; unitPriceSnapshot: number; quantity: number; total: number }>
    let subtotal = 0
    for (const it of o.items) {
      const p = await db.product.findUniqueOrThrow({ where: { slug: it.slug } })
      const total = p.price * it.qty
      subtotal += total
      itemsData.push({ productId: p.id, productNameSnapshot: p.name, unitPriceSnapshot: p.price, quantity: it.qty, total })
    }
    await db.order.upsert({
      where: { orderNumber: o.n },
      create: {
        orderNumber: o.n, customerId: custIds[o.cust], status: o.status, subtotal,
        discount: 0, total: subtotal, customerName: o.name, address: o.address, phone: o.phone,
        createdAt: o.created, updatedAt: o.created,
        items: { create: itemsData },
      },
      update: { status: o.status, subtotal, total: subtotal, createdAt: o.created },
    })
    if (o.payment) {
      const orderRow = await db.order.findUniqueOrThrow({ where: { orderNumber: o.n } })
      await db.payment.upsert({
        where: { orderId: orderRow.id },
        create: {
          orderId: orderRow.id,
          status: o.payment.status,
          amountSnapshot: subtotal,
          receiptImage: o.payment.status === 'payment_review' ? `sample-receipt-${o.n}.jpg` : null,
          payerName: o.payment.status === 'payment_review' ? o.name : null,
          reviewedByEmail: o.payment.reviewedByEmail ?? null,
          reviewedAt: o.payment.reviewedByEmail ? o.created : null,
          events: {
            create: o.payment.status === 'payment_review'
              ? { type: 'receipt_submitted', note: 'رسید نمونه ثبت شد (seed)' }
              : { type: 'approved', actorEmail: o.payment.reviewedByEmail, note: 'تأیید نمونه (seed)' },
          },
        },
        update: {
          status: o.payment.status,
          amountSnapshot: subtotal,
          reviewedByEmail: o.payment.reviewedByEmail ?? null,
          reviewedAt: o.payment.reviewedByEmail ? o.created : null,
        },
      })
    }
  }
  await db.counter.upsert({
    where: { name: 'order' },
    create: { name: 'order', value: 1006 },
    update: { value: Math.max(1006, (await db.counter.findUnique({ where: { name: 'order' } }))?.value ?? 0) },
  })
  console.log(`✓ ${orders.length} orders (next orderNumber = 1007, one in payment_review)`)

  // ── Summary ─────────────────────────────────────────────────────────────
  const counts = {
    users: await db.user.count(), categories: await db.category.count(),
    products: await db.product.count(), customers: await db.customer.count(),
    orders: await db.order.count(), orderItems: await db.orderItem.count(),
    embeddings: await db.productEmbedding.count(), settings: await db.setting.count(),
    silverRates: await db.silverRate.count(), bankAccounts: await db.bankAccount.count(),
    payments: await db.payment.count(),
  }
  console.log('🌱 Silver Love seed complete:', counts)
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
