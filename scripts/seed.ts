/**
 * Seed script — Silver Love (فروشگاه نقره) demo data.
 * Run: bun scripts/seed.ts          (idempotent — skips if already seeded)
 *      bun scripts/seed.ts --reset  (wipes all tables first)
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import path from 'node:path'
import { upsertProductEmbedding } from '../src/lib/ai/embedding'

const db = new PrismaClient()

const daysAgo = (n: number, h = 12) => new Date(Date.now() - n * 24 * 3600 * 1000 + h * 3600 * 1000)

async function reset() {
  await db.activityLog.deleteMany()
  await db.payment.deleteMany()
  await db.paymentDestination.deleteMany()
  await db.silverRate.deleteMany()
  await db.chatMessage.deleteMany()
  await db.productImage.deleteMany()
  await db.orderItem.deleteMany()
  await db.order.deleteMany()
  await db.productEmbedding.deleteMany()
  await db.telegramProduct.deleteMany()
  await db.botSession.deleteMany()
  await db.product.deleteMany()
  await db.category.deleteMany()
  await db.customer.deleteMany()
  await db.session.deleteMany()
  await db.user.deleteMany()
  await db.setting.deleteMany()
  await db.counter.deleteMany()
}

/** Copies a demo receipt image into the PRIVATE receipts dir (never /api/uploads). */
function ensureDemoReceipt(): string {
  const dir = path.join(process.cwd(), 'upload', 'receipts')
  fs.mkdirSync(dir, { recursive: true })
  const name = 'receipt-demo-1005.png'
  const dest = path.join(dir, name)
  if (!fs.existsSync(dest)) {
    const src = path.join(process.cwd(), 'upload', 'sl-set.png')
    if (fs.existsSync(src)) fs.copyFileSync(src, dest)
  }
  return `/api/receipts/${name}`
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
  const admin = await db.user.upsert({
    where: { email: 'admin@shop.local' },
    create: { email: 'admin@shop.local', name: 'مدیر Silver Love', passwordHash, role: 'admin' },
    update: { name: 'مدیر Silver Love', role: 'admin' },
  })
  console.log('✓ admin user (admin@shop.local / admin1234)')

  // ── Settings (Silver Love branding + AI toggles) ────────────────────────
  const settings: Array<[string, string]> = [
    ['storeName', 'Silver Love'],
    ['storeDescription', 'فروشگاه تخصصی نقره — نقره اصل با ضمانت اصالت، خرید آسان از طریق تلگرام'],
    ['supportUsername', 'silverlove_support'],
    ['currency', 'IRT'],
    ['aiEnabled', 'true'],
    ['aiTone', ''],
  ]
  for (const [key, value] of settings) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  console.log('✓ settings (Silver Love)')

  // ── Silver categories ───────────────────────────────────────────────────
  const catData = [
    { name: 'انگشتر', slug: 'ring', description: 'انگشترهای نقره زنانه و مردانه با عیار ۹۲۵' },
    { name: 'دستبند', slug: 'bracelet', description: 'دستبندهای نقره ظریف و اسپرت' },
    { name: 'گردنبند و آویز', slug: 'necklace', description: 'گردنبند، زنجیر و آویز نقره' },
    { name: 'گوشواره', slug: 'earring', description: 'گوشواره‌های نقره ظریف و مدرن' },
    { name: 'ست و هدیه', slug: 'gift-set', description: 'ست‌های نقره و جعبه‌های هدیه' },
    { name: 'شمش و سرمایه‌ای', slug: 'silver-bar', description: 'شمش نقره خالص برای سرمایه‌گذاری' },
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
  console.log(`✓ ${catData.length} silver categories`)

  // ── Silver products (price = FINAL seller price; never computed) ────────
  type Img = { url: string; isPrimary: boolean; sortOrder: number }
  type P = {
    name: string; slug: string; code: string; cat: string; price: number; compareAtPrice?: number
    stock: number; status: string; shortDescription: string; description: string; tags: string[]
    lowStockThreshold?: number
    silverType: string; fineness: number; weightGrams: number; size?: string
    dimensions?: string; brand?: string; appearance?: string; careInstructions?: string
    authenticityNote?: string
    images: string[]
  }
  const products: P[] = [
    {
      name: 'انگشتر نقره زنانه مدل نگارین', slug: 'nagarin-silver-ring', code: 'SL-R-101', cat: 'ring',
      price: 780000, compareAtPrice: 890000, stock: 8, status: 'active',
      shortDescription: 'انگشتر نقره ۹۲۵ با حکاکی دستی اسلیمی، ظریف و مناسب استفاده روزمره.',
      description:
        'انگشتر نقره نگارین با عیار ۹۲۵ و حکاکی دستی نقوش اسلیمی، یکی از پرفروش‌ترین مدل‌های فروشگاه است. وزن سبک و طراحی ظریف آن باعث می‌شود هم برای استایل روزمره و هم برای هدیه انتخاب مناسبی باشد. سطح آبکاری رودیوم، جلای ماندگار و مقاومت در برابر تیرگی را به همراه دارد. همراه با جعبه مخملی ارسال می‌شود.',
      tags: ['انگشتر', 'نقره ۹۲۵', 'حکاکی دستی', 'زنانه', 'هدیه'],
      silverType: 'نقره استرلینگ', fineness: 925, weightGrams: 3.8, size: '۵۶',
      dimensions: 'قطر نگین‌گاه ندارد — طرح سرتاسری', brand: 'Silver Love',
      appearance: 'حکاکی اسلیمی، آبکاری رودیوم', careInstructions: 'از تماس با عطر و مواد شوینده دور نگه دارید.',
      authenticityNote: 'دارای مهر عیار ۹۲۵ و ضمانت اصالت Silver Love',
      images: ['/api/uploads/sl-ring.png', '/api/uploads/sl-set.png'],
    },
    {
      name: 'دستبند نقره مردانه مدل آریو', slug: 'aryo-silver-bracelet', code: 'SL-B-204', cat: 'bracelet',
      price: 1650000, stock: 5, status: 'active',
      shortDescription: 'دستبند نقره ۹۲۵ مردانه با طرح زنجیر بزل، سنگین و باکلاس.',
      description:
        'دستبند آریو با طراحی زنجیر بزل کلاسیک، برای آقایانی که استایل مینیمال و در عین حال چشمگیر می‌پسندند ساخته شده است. قفل محکم تیغه‌ای با قابلیت تنظیم سایز، ایمنی و راحتی را تضمین می‌کند. وزن مناسب و ساخت دست، حس یک قطعه ماندگار را منتقل می‌کند.',
      tags: ['دستبند مردانه', 'نقره ۹۲۵', 'زنجیر بزل', 'کلاسیک'],
      silverType: 'نقره استرلینگ', fineness: 925, weightGrams: 14.2, size: '۲۰ سانتی‌متر',
      dimensions: 'ضخامت حلقه ۵ میلی‌متر', brand: 'Silver Love',
      appearance: 'زنجیر بزل براق', careInstructions: 'پس از استفاده با دستمال نرم تمیز کنید.',
      authenticityNote: 'دارای مهر عیار ۹۲۵',
      images: ['/api/uploads/sl-bracelet.png', '/api/uploads/sl-chain.png'],
    },
    {
      name: 'گوشواره نقره زنانه مدل باران', slug: 'baran-silver-earrings', code: 'SL-E-330', cat: 'earring',
      price: 520000, stock: 12, status: 'active',
      shortDescription: 'گوشواره آویز نقره ۹۲۵ با طرح قطره، ظریف و سبک برای هر روز.',
      description:
        'گوشواره باران با طرح قطره‌ای ظریف، سبک است و برای استفاده طولانی روز آزاردهنده نیست. مناسب خانم‌هایی که دنبال یک اکسسوری ساده اما خاص هستند. با پست ضدحساسیت، مناسب گوش‌های حساس.',
      tags: ['گوشواره', 'نقره ۹۲۵', 'آویز', 'ظریف', 'روزمره'],
      silverType: 'نقره استرلینگ', fineness: 925, weightGrams: 2.6,
      dimensions: 'طول آویز ۳٫۵ سانتی‌متر', brand: 'Silver Love',
      appearance: 'پولیش مات و براق ترکیبی', careInstructions: 'خوابیدن و حمام را با گوشواره انجام ندهید.',
      authenticityNote: 'دارای مهر عیار ۹۲۵ و ضمانت اصالت',
      images: ['/api/uploads/sl-earrings.png', '/api/uploads/sl-set.png'],
    },
    {
      name: 'گردنبند نقره دل‌نقره با زنجیر ظریف', slug: 'delnagare-heart-necklace', code: 'SL-N-412', cat: 'necklace',
      price: 940000, compareAtPrice: 1100000, stock: 7, status: 'active',
      shortDescription: 'گردنبند نقره ۹۲۵ با آویز قلب و زنجیر ظریف، محبوب‌ترین انتخاب هدیه.',
      description:
        'گردنبند دل‌نقره با آویز قلب مینیمال و زنجیر ظریف ۴۵ سانتی‌متری، یک انتخاب همیشگی برای هدیه است. بسته‌بندی مخصوص هدیه دارد و می‌توانید پیام تبریک شخصی‌سازی‌شده هم همراه آن سفارش دهید. مناسب تولد، سالگرد و ولنتاین.',
      tags: ['گردنبند', 'آویز قلب', 'هدیه', 'نقره ۹۲۵', 'ولنتاین'],
      silverType: 'نقره استرلینگ', fineness: 925, weightGrams: 4.4, size: 'زنجیر ۴۵ سانتی‌متر',
      dimensions: 'آویز ۱٫۲ × ۱ سانتی‌متر', brand: 'Silver Love',
      appearance: 'آویز قلب براق', careInstructions: 'برای حفظ جلا، در بسته‌بندی نگهداری شود.',
      authenticityNote: 'دارای مهر عیار ۹۲۵',
      images: ['/api/uploads/sl-necklace.png', '/api/uploads/sl-ring.png'],
    },
    {
      name: 'زنجیر نقره مردانه مدل کوبا', slug: 'cuba-silver-chain', code: 'SL-N-455', cat: 'necklace',
      price: 2450000, stock: 3, status: 'active',
      shortDescription: 'زنجیر نقره ۹۲۵ مردانه طرح کوبا، ضخیم و سنگین با قفل محکم.',
      description:
        'زنجیر کوبا با حلقه‌های ضخیم و سنگین‌وزن، یکی از جذاب‌ترین مدل‌های مردانه نقره است. قفل فنری تقویت‌شده و حلقه‌های جوش‌خورده، استحکام بالا را تضمین می‌کند. برای استایل اسپرت و کژوال فوق‌العاده است.',
      tags: ['زنجیر مردانه', 'نقره ۹۲۵', 'کوبا', 'اسپرت'],
      silverType: 'نقره استرلینگ', fineness: 925, weightGrams: 22.5, size: '۵۵ سانتی‌متر',
      dimensions: 'ضخامت ۶ میلی‌متر', brand: 'Silver Love',
      appearance: 'طرح کوبا براق', careInstructions: 'از ضربه و کشیدگی شدید پرهیز کنید.',
      authenticityNote: 'دارای مهر عیار ۹۲۵',
      images: ['/api/uploads/sl-chain.png', '/api/uploads/sl-bracelet.png'],
      lowStockThreshold: 3,
    },
    {
      name: 'ست نقره هدیه رزگلد دو پارچه', slug: 'rosegold-gift-set', code: 'SL-S-501', cat: 'gift-set',
      price: 2180000, compareAtPrice: 2500000, stock: 4, status: 'active',
      shortDescription: 'ست کامل گردنبند و گوشواره نقره ۹۲۵ در جعبه هدیه مخملی.',
      description:
        'ست رزگلد شامل گردنبند و گوشواره هماهنگ است که در جعبه مخملی شیک ارائه می‌شود. بهترین گزینه برای هدیه گرفتن بدون دغدغه هماهنگی. هر دو قطعه با عیار ۹۲۵ و آبکاری محافظ ساخته شده‌اند.',
      tags: ['ست نقره', 'هدیه', 'جعبه مخملی', 'گردنبند', 'گوشواره'],
      silverType: 'نقره استرلینگ', fineness: 925, weightGrams: 9.1,
      dimensions: 'زنجیر ۴۲ سانتی‌متر + گوشواره ۲ سانتی‌متر', brand: 'Silver Love',
      appearance: 'پوشش رزگلد روی نقره', careInstructions: 'با دستمال جواهر تمیز کنید؛ از آب دریا دور بماند.',
      authenticityNote: 'دارای مهر عیار ۹۲۵ و شناسنامه محصول',
      images: ['/api/uploads/sl-set.png', '/api/uploads/sl-necklace.png'],
    },
    {
      name: 'شمش نقره ۵۰ گرمی عیار ۹۹۹', slug: 'silver-bar-50g', code: 'SL-BR-999-50', cat: 'silver-bar',
      price: 5900000, stock: 6, status: 'active',
      shortDescription: 'شمش نقره خالص ۹۹۹ با بسته‌بندی سیل و شماره سریال منحصربه‌فرد.',
      description:
        'شمش نقره ۵۰ گرمی با خلوص ۹۹۹٫۹، مناسب سرمایه‌گذاری و نگهداری ارزش. هر شمش دارای شماره سریال اختصاصی و بسته‌بندی سیل‌شده آزمایشگاه است. همراه با فاکتور رسمی خرید ارسال می‌شود.',
      tags: ['شمش نقره', 'سرمایه‌گذاری', 'عیار ۹۹۹', '۵۰ گرم'],
      silverType: 'نقره خالص', fineness: 999, weightGrams: 50,
      dimensions: '۴۷ × ۲۹ × ۸ میلی‌متر', brand: 'Silver Love Mint',
      appearance: 'سطح آینه‌ای با حکاکی لیزری', careInstructions: 'بسته‌بندی سیل را باز نکنید.',
      authenticityNote: 'شماره سریال سیل‌شده + فاکتور رسمی',
      images: ['/api/uploads/sl-bar.png'],
      lowStockThreshold: 3,
    },
    {
      name: 'انگشتر نقره مردانه نگین فیروزه', slug: 'firuzeh-men-ring', code: 'SL-R-140', cat: 'ring',
      price: 1320000, stock: 2, status: 'active',
      shortDescription: 'انگشتر نقره ۹۲۵ مردانه با نگین فیروزه نیشابوری، دست‌ساز.',
      description:
        'انگشتر فیروزه با نگین اصل فیروزه نیشابوری و رکاب نقره ۹۲۵ دست‌ساز، قطعه‌ای ارزشمند برای مجموعه‌داران. حکاکی دستی روی رکاب، هر حلقه را یکتا می‌کند. سایزهای محدود موجود است.',
      tags: ['انگشتر مردانه', 'فیروزه نیشابور', 'دست‌ساز', 'نقره ۹۲۵'],
      silverType: 'نقره استرلینگ', fineness: 925, weightGrams: 8.7, size: '۶۲',
      dimensions: 'قطر نگین ۱۰ میلی‌متر', brand: 'Silver Love Workshop',
      appearance: 'رکاب حکاکی‌شده + نگین فیروزه', careInstructions: 'فیروزه نسبت به مواد شیمیایی حساس است.',
      authenticityNote: 'مهر عیار + گارانتی اصالت نگین',
      images: ['/api/uploads/sl-ring.png', '/api/uploads/sl-bar.png'],
      lowStockThreshold: 2,
    },
    {
      name: 'دستبند نقره زنانه مدل ناز', slug: 'naz-silver-bracelet', code: 'SL-B-215', cat: 'bracelet',
      price: 690000, stock: 0, status: 'out_of_stock',
      shortDescription: 'دستبند نقره ۹۲۵ زنانه با پلاک قلب کوچک، ظریف و دخترانه.',
      description:
        'دستبند ناز با زنجیر ظریف و پلاک قلب کوچک، انتخابی محبوب برای هدیه به دختران و خانم‌های جوان است. زنجیر زنجیری ۱۶+۳ سانتی‌متری با زنجیر تکمیلی قابل تنظیم.',
      tags: ['دستبند زنانه', 'نقره ۹۲۵', 'پلاک قلب', 'ظریف'],
      silverType: 'نقره استرلینگ', fineness: 925, weightGrams: 3.2, size: '۱۶+۳ سانتی‌متر',
      brand: 'Silver Love', appearance: 'زنجیر ظریف + پلاک قلب',
      careInstructions: 'با عطر و الکل تماس مستقیم نداشته باشد.',
      authenticityNote: 'دارای مهر عیار ۹۲۵',
      images: ['/api/uploads/sl-bracelet.png', '/api/uploads/sl-ring.png'],
    },
    {
      name: 'آویز نقره ستاره و ماه (پیش‌نمایش)', slug: 'star-moon-pendant', code: 'SL-N-470', cat: 'necklace',
      price: 610000, stock: 10, status: 'draft',
      shortDescription: 'آویز نقره ۹۲۵ طرح ستاره و ماه، به‌زودی برای پیش‌سفارش.',
      description:
        'آویز ستاره و ماه با طراحی مینیمال و پرداخت مات-براق، به‌زودی به فروشگاه اضافه می‌شود. این محصول در حالت پیش‌نویس برای هماهنگی موجودی قرار دارد.',
      tags: ['آویز', 'ستاره و ماه', 'مینیمال', 'نقره ۹۲۵'],
      silverType: 'نقره استرلینگ', fineness: 925, weightGrams: 2.9,
      dimensions: '۱٫۵ × ۱ سانتی‌متر', brand: 'Silver Love',
      appearance: 'پرداخت مات و براق', authenticityNote: 'دارای مهر عیار ۹۲۵',
      images: ['/api/uploads/sl-necklace.png'],
    },
  ]

  const productIds: Record<string, string> = {}
  for (const p of products) {
    const row = await db.product.upsert({
      where: { slug: p.slug },
      create: {
        name: p.name, slug: p.slug, description: p.description, shortDescription: p.shortDescription,
        price: p.price, compareAtPrice: p.compareAtPrice ?? null, stock: p.stock,
        categoryId: cats[p.cat], imageUrl: p.images[0], status: p.status,
        tags: JSON.stringify(p.tags), lowStockThreshold: p.lowStockThreshold ?? 5,
        productCode: p.code, silverType: p.silverType, fineness: p.fineness,
        weightGrams: p.weightGrams, size: p.size ?? null, dimensions: p.dimensions ?? null,
        brand: p.brand ?? null, appearance: p.appearance ?? null,
        careInstructions: p.careInstructions ?? null, authenticityNote: p.authenticityNote ?? null,
        images: {
          create: p.images.map((url, i) => ({ url, isPrimary: i === 0, sortOrder: i })),
        },
      },
      update: {
        price: p.price, stock: p.stock, status: p.status, imageUrl: p.images[0],
        categoryId: cats[p.cat], description: p.description, shortDescription: p.shortDescription,
        tags: JSON.stringify(p.tags), compareAtPrice: p.compareAtPrice ?? null,
        productCode: p.code, silverType: p.silverType, fineness: p.fineness,
        weightGrams: p.weightGrams, size: p.size ?? null, dimensions: p.dimensions ?? null,
        brand: p.brand ?? null, appearance: p.appearance ?? null,
        careInstructions: p.careInstructions ?? null, authenticityNote: p.authenticityNote ?? null,
      },
    })
    productIds[p.slug] = row.id
    await upsertProductEmbedding(row.id).catch((e) => console.error('embed fail', p.name, e.message))
  }
  console.log(`✓ ${products.length} silver products (+images +embeddings)`)

  // ── Manual silver rate + history ────────────────────────────────────────
  await db.silverRate.createMany({
    data: [
      { ratePerGram: 89500, note: 'برآورد بازار — ثبت اولیه', createdByName: 'مدیر Silver Love', createdAt: daysAgo(9) },
      { ratePerGram: 92000, note: 'اصلاح بر اساس معاملات هفته', createdByName: 'مدیر Silver Love', createdAt: daysAgo(4) },
      { ratePerGram: 96500, note: 'نرخ مرجع فروشگاه — هر گرم نقره ۹۲۵', createdByName: 'مدیر Silver Love', createdAt: daysAgo(0, 9) },
    ],
  })
  console.log('✓ silver rate 96,500 T/g + 2 history rows')

  // ── Payment destinations (bank cards) ───────────────────────────────────
  await db.paymentDestination.createMany({
    data: [
      {
        bankName: 'بانک ملت', accountHolder: 'نام صاحب حساب فروشگاه', cardNumber: '6104337812345678',
        sheba: 'IR120120000000001234567890', note: 'کارت اصلی فروشگاه — منتظر واریز سفارش‌ها',
        active: true, sortOrder: 0,
      },
      {
        bankName: 'بانک سامان', accountHolder: 'نام صاحب حساب فروشگاه', cardNumber: '6219861012345678',
        note: 'کارت جایگزین برای مواقع اضطراری', active: false, sortOrder: 1,
      },
    ],
  })
  console.log('✓ 2 payment destinations (1 active)')

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

  // ── Orders (with paymentStatus + one receipt under review) ──────────────
  type OI = { slug: string; qty: number }
  type O = {
    n: number; cust: string; status: string; paymentStatus: string; created: Date
    phone: string; address: string; name: string; items: OI[]; trackingCode?: string
  }
  const orders: O[] = [
    { n: 1001, cust: '701100001', status: 'completed', paymentStatus: 'paid', created: daysAgo(9), name: 'امیر حساری', phone: '09121110001', address: 'تهران، خیابان ولیعصر، کوچه بهار، پلاک ۱۲، واحد ۳', items: [{ slug: 'nagarin-silver-ring', qty: 1 }] },
    { n: 1002, cust: '701100002', status: 'completed', paymentStatus: 'paid', created: daysAgo(6), name: 'سارا محمدی', phone: '09352220002', address: 'اصفهان، خیابان چهارباغ بالا، کوچه گلستان، پلاک ۸', items: [{ slug: 'baran-silver-earrings', qty: 1 }, { slug: 'naz-silver-bracelet', qty: 1 }] },
    { n: 1003, cust: '701100003', status: 'cancelled', paymentStatus: 'rejected', created: daysAgo(4), name: 'رضا کریمی', phone: '09193330003', address: 'شیراز، بلوار زند، ساختمان نور، طبقه ۲', items: [{ slug: 'cuba-silver-chain', qty: 1 }] },
    { n: 1004, cust: '701100001', status: 'shipped', paymentStatus: 'paid', created: daysAgo(2), name: 'امیر حساری', phone: '09121110001', address: 'تهران، خیابان ولیعصر، کوچه بهار، پلاک ۱۲، واحد ۳', items: [{ slug: 'silver-bar-50g', qty: 1 }], trackingCode: 'IR9251148750' },
    { n: 1005, cust: '701100002', status: 'confirmed', paymentStatus: 'payment_review', created: daysAgo(1), name: 'سارا محمدی', phone: '09352220002', address: 'اصفهان، خیابان چهارباغ بالا، کوچه گلستان، پلاک ۸', items: [{ slug: 'delnagare-heart-necklace', qty: 1 }] },
    { n: 1006, cust: '701100004', status: 'pending', paymentStatus: 'awaiting_payment', created: daysAgo(0, 2), name: 'مریم احمدی', phone: '09364440004', address: 'مشهد، بلوار وکیل‌آباد، خیابان لادن، پلاک ۲۱', items: [{ slug: 'rosegold-gift-set', qty: 1 }] },
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
        orderNumber: o.n, customerId: custIds[o.cust], status: o.status, paymentStatus: o.paymentStatus,
        subtotal, discount: 0, total: subtotal, customerName: o.name, address: o.address, phone: o.phone,
        trackingCode: o.trackingCode ?? null,
        createdAt: o.created, updatedAt: o.created,
        items: { create: itemsData },
      },
      update: { status: o.status, paymentStatus: o.paymentStatus, subtotal, total: subtotal, createdAt: o.created },
    })
  }

  // Payment awaiting review for order 1005 (private receipt file)
  const receiptUrl = ensureDemoReceipt()
  const o5 = await db.order.findUniqueOrThrow({ where: { orderNumber: 1005 } })
  await db.payment.deleteMany({ where: { orderId: o5.id } })
  await db.payment.create({
    data: {
      orderId: o5.id, amount: o5.total, receiptUrl, payerName: 'سارا محمدی',
      trackingNumber: '990877', customerNote: 'واریز از بانک ملت انجام شد', status: 'awaiting_review',
    },
  })
  // Approved payment history for order 1001
  const o1 = await db.order.findUniqueOrThrow({ where: { orderNumber: 1001 } })
  await db.payment.deleteMany({ where: { orderId: o1.id } })
  await db.payment.create({
    data: {
      orderId: o1.id, amount: o1.total, receiptUrl, payerName: 'امیر حساری',
      status: 'approved', reviewNote: 'تأیید شد — واریز مطابقت داشت',
      reviewedBy: admin.id, reviewedByName: admin.name, reviewedAt: daysAgo(8),
    },
  })
  // Rejected payment history for order 1003
  const o3 = await db.order.findUniqueOrThrow({ where: { orderNumber: 1003 } })
  await db.payment.deleteMany({ where: { orderId: o3.id } })
  await db.payment.create({
    data: {
      orderId: o3.id, amount: o3.total, receiptUrl, payerName: 'رضا کریمی',
      status: 'rejected', reviewNote: 'مبلغ واریزشده با مبلغ سفارش مطابقت نداشت',
      reviewedBy: admin.id, reviewedByName: admin.name, reviewedAt: daysAgo(3),
    },
  })

  await db.counter.upsert({
    where: { name: 'order' },
    create: { name: 'order', value: 1006 },
    update: { value: Math.max(1006, (await db.counter.findUnique({ where: { name: 'order' } }))?.value ?? 0) },
  })
  console.log(`✓ ${orders.length} orders + 3 payment records (next orderNumber = 1007)`)

  // ── Summary ─────────────────────────────────────────────────────────────
  const counts = {
    users: await db.user.count(), categories: await db.category.count(),
    products: await db.product.count(), productImages: await db.productImage.count(),
    customers: await db.customer.count(), orders: await db.order.count(),
    orderItems: await db.orderItem.count(), payments: await db.payment.count(),
    paymentDestinations: await db.paymentDestination.count(),
    silverRates: await db.silverRate.count(),
    embeddings: await db.productEmbedding.count(), settings: await db.setting.count(),
  }
  console.log('🌱 Silver Love seed complete:', counts)
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
