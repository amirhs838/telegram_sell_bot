/**
 * Seed script — realistic Persian demo data.
 * Run: bun scripts/seed.ts          (idempotent — skips if already seeded)
 *      bun scripts/seed.ts --reset  (wipes all tables first)
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { upsertProductEmbedding } from '../src/lib/ai/embedding'

const db = new PrismaClient()

const daysAgo = (n: number, h = 12) => new Date(Date.now() - n * 24 * 3600 * 1000 + h * 3600 * 1000)

async function reset() {
  await db.activityLog.deleteMany()
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
    create: { email: 'admin@shop.local', name: 'مدیر فروشگاه', passwordHash, role: 'admin' },
    update: {},
  })
  console.log('✓ admin user (admin@shop.local / admin1234)')

  // ── Settings ────────────────────────────────────────────────────────────
  const settings: Array<[string, string]> = [
    ['storeName', 'فروشگاه تپش'],
    ['storeDescription', 'خرید آسان و مطمئن از طریق تلگرام — ارسال سریع به سراسر کشور'],
    ['supportUsername', 'tapesh_support'],
    ['currency', 'IRT'],
  ]
  for (const [key, value] of settings) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  console.log('✓ settings')

  // ── Categories ──────────────────────────────────────────────────────────
  const catData = [
    { name: 'کفش و صندل', slug: 'shoes', description: 'انواع کفش اسپرت، پیاده‌روی و رسمی' },
    { name: 'لوازم دیجیتال', slug: 'digital', description: 'گجت‌های هوشمند و لوازم جانبی' },
    { name: 'پوشاک', slug: 'apparel', description: 'پوشاک ترند و باکیفیت' },
    { name: 'خانه و زندگی', slug: 'home', description: 'لوازم کاربردی برای خانه' },
    { name: 'اکسسوری', slug: 'accessories', description: 'کوله، عینک و لوازم شخصی' },
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
    stock: number; status: string; image: string; shortDescription: string; description: string
    tags: string[]; lowStockThreshold?: number
  }
  const products: P[] = [
    {
      name: 'کفش اسپرت سفید مدل ایرفلکس', slug: 'airflex-white-sneaker', cat: 'shoes',
      price: 1850000, compareAtPrice: 2200000, stock: 12, status: 'active',
      image: '/api/uploads/seed-sneakers-white.png',
      shortDescription: 'کفش اسپرت سفید با رویه تنفس‌پذیر، مناسب پیاده‌روی روزمره و دویدن سبک. سبک و راحت.',
      description: 'کفش اسپرت ایرفلکس با طراحی مینیمال سفید، انتخابی عالی برای استفاده روزمره است. رویه مش تنفس‌پذیر از تعریق پا جلوگیری می‌کند و زیره EVA سبک، ضربات را به‌خوبی جذب می‌کند. کفی داخلی نرم و قابل تعویض، راحتی را در طول روز تضمین می‌کند. مناسب پیاده‌روی طولانی، دویدن سبک و استایل کژوال.',
      tags: ['کفش اسپرت', 'سفید', 'پیاده‌روی', 'روزمره', 'سبک'],
    },
    {
      name: 'کفش پیاده‌روی مردانه گیت‌وای', slug: 'gateway-walking-shoes', cat: 'shoes',
      price: 1450000, stock: 3, status: 'active',
      image: '/api/uploads/seed-walking-shoes.png',
      shortDescription: 'کفش پیاده‌روی مردانه با زیره طبی و کفی طبی، مناسب قدم‌های طولانی.',
      description: 'کفش پیاده‌روی گیت‌وای با زیره ضدلغزش و کفی طبی، برای افرادی که روزانه مسیرهای طولانی را پیاده می‌پیمایند طراحی شده است. وزن سبک و انعطاف بالا، خستگی پا را به حداقل می‌رساند.',
      tags: ['کفش مردانه', 'پیاده‌روی', 'زیره طبی', 'ضدلغزش'],
      lowStockThreshold: 5,
    },
    {
      name: 'هدفون بی‌سیم ساندبرگ پرو', slug: 'sandberg-pro-headphones', cat: 'digital',
      price: 2350000, compareAtPrice: 2700000, stock: 15, status: 'active',
      image: '/api/uploads/seed-headphones.png',
      shortDescription: 'هدفون بی‌سیم با نویز کنسلینگ فعال و ۳۰ ساعت پخش موسیقی.',
      description: 'هدفون ساندبرگ پرو با فناوری حذف نویز فعال (ANC)، صدایی شفاف و بیس عمیق ارائه می‌دهد. باتری ۳۰ ساعته، اتصال بلوتوث ۵.۳ و قابلیت اتصال هم‌زمان به دو دستگاه. راحتی برای استفاده طولانی با یوگا فوم پروتئینی.',
      tags: ['هدفون', 'بی‌سیم', 'نویز کنسلینگ', 'بلوتوث'],
    },
    {
      name: 'پاوربانک ولتکس ۱۰ هزار', slug: 'voltex-powerbank-10k', cat: 'digital',
      price: 890000, stock: 0, status: 'out_of_stock',
      image: '/api/uploads/seed-powerbank.png',
      shortDescription: 'پاوربانک ۱۰٬۰۰۰ میلی‌آمپر با نمایشگر دیجیتال و دو خروجی سریع.',
      description: 'پاوربانک ولتکس با ظرفیت واقعی ۱۰٬۰۰۰ میلی‌آمپر، شارژ سریع ۲۲.۵ واتی و نمایشگر درصد باتری، همراه مطمئن سفرها و روزهای پرمشغله شماست.',
      tags: ['پاوربانک', 'شارژ سریع', 'نمایشگر دیجیتال'],
    },
    {
      name: 'ساعت هوشمند اکتیو ۵', slug: 'active-5-smartwatch', cat: 'digital',
      price: 3200000, stock: 6, status: 'active',
      image: '/api/uploads/seed-smartwatch.png',
      shortDescription: 'ساعت هوشمند با نمایشگر AMOLED، پایش ضربان قلب و خواب و ۷ روز شارژدهی.',
      description: 'ساعت هوشمند اکتیو ۵ با نمایشگر AMOLED ۱.۴۳ اینچ، بیش از ۱۰۰ حالت ورزشی، پایش ضربان قلب و کیفیت خواب و مقاومت در برابر آب (5ATM). با یک بار شارژ تا ۷ روز همراه شماست.',
      tags: ['ساعت هوشمند', 'AMOLED', 'سلامت', 'ورزشی'],
    },
    {
      name: 'هودی مردانه مشکی اورسایز', slug: 'black-oversize-hoodie', cat: 'apparel',
      price: 980000, stock: 20, status: 'inactive',
      image: '/api/uploads/seed-hoodie.png',
      shortDescription: 'هودی اورسایز نخ پنبه سنگ‌شور، مناسب فصل سرد و استایل اسپرت.',
      description: 'هودی اورسایز از نخ پنبه سنگ‌شور با کیفیت، با جیب کانگورویی و بند قابل تنظیم. گرم، نرم و ماندگار — انتخابی مطمئن برای فصل سرد.',
      tags: ['هودی', 'مشکی', 'اورسایز', 'پنبه'],
    },
    {
      name: 'کوله‌پشتی لپ‌تاپ سیتی‌پک', slug: 'citypack-laptop-backpack', cat: 'accessories',
      price: 1250000, stock: 4, status: 'active',
      image: '/api/uploads/seed-backpack.png',
      shortDescription: 'کوله‌پشتی لپ‌تاپ ۱۵.۶ اینچ با محفظه ضدضربه و پارچه ضدآب.',
      description: 'کوله‌پشتی سیتی‌پک با محفظه مخصوص لپ‌تاپ ۱۵.۶ اینچ و محافظ ضدضربه، جیب‌های متعدد برای نظم اقلام و پارچه ضدآب مقاوم. پشت‌بند طبی و کمربند سینه برای حمل راحت.',
      tags: ['کوله‌پشتی', 'لپ‌تاپ', 'ضدآب', 'اداری'],
      lowStockThreshold: 5,
    },
    {
      name: 'ماگ حرارتی استیل برو', slug: 'brew-thermal-mug', cat: 'home',
      price: 320000, stock: 30, status: 'active',
      image: '/api/uploads/seed-mug.png',
      shortDescription: 'ماگ حرارتی استیل دوجداره، حفظ دما تا ۶ ساعت، درب ضدچکه.',
      description: 'ماگ حرارتی برو از استیل ضدزنگ دوجداره، دمای نوشیدنی گرم تا ۶ ساعت و سرد تا ۱۲ ساعت حفظ می‌کند. درب قفل‌شونده ضدچکه، مناسب ماشین، محل کار و سفر.',
      tags: ['ماگ', 'حرارتی', 'استیل', 'سفر'],
    },
    {
      name: 'عینک آفتابی پلاریزه رویال', slug: 'royal-polarized-sunglasses', cat: 'accessories',
      price: 760000, stock: 10, status: 'active',
      image: '/api/uploads/seed-sunglasses.png',
      shortDescription: 'عینک آفتابی پلاریزه با محافظت کامل UV400 و فریم سبک.',
      description: 'عینک آفتابی رویال با لنز پلاریزه، انعکاس نور خورشید را حذف می‌کند و دیدی شفاف و بدون خیرگی ارائه می‌دهد. محافظت کامل UV400 و فریم سبک و مقاوم.',
      tags: ['عینک آفتابی', 'پلاریزه', 'UV400', 'تابستان'],
    },
    {
      name: 'دفترچه یادداشت چرمی نوتا', slug: 'nota-leather-notebook', cat: 'home',
      price: 250000, stock: 2, status: 'draft',
      image: '/api/uploads/seed-notebook.png',
      shortDescription: 'دفترچه ۱۹۲ صفحه‌ای با جلد چرم طبیعی و کاغذ گلاسه ۱۲۰ گرمی.',
      description: 'دفترچه نوتا با جلد چرم طبیعی و کش بستن، ۱۹۲ صفحه کاغذ گلاسه ۱۲۰ گرمی مناسب انواع خودکار. همراه با ریبون نشان‌گذاری صفحه.',
      tags: ['دفترچه', 'چرمی', 'هدیه', 'نوشت‌افزار'],
      lowStockThreshold: 5,
    },
  ]

  const productIds: Record<string, string> = {}
  for (const p of products) {
    const row = await db.product.upsert({
      where: { slug: p.slug },
      create: {
        name: p.name, slug: p.slug, description: p.description, shortDescription: p.shortDescription,
        price: p.price, compareAtPrice: p.compareAtPrice ?? null, stock: p.stock,
        categoryId: cats[p.cat], imageUrl: p.image, status: p.status, tags: JSON.stringify(p.tags),
        lowStockThreshold: p.lowStockThreshold ?? 5,
      },
      update: {
        price: p.price, stock: p.stock, status: p.status, imageUrl: p.image,
        categoryId: cats[p.cat], description: p.description, shortDescription: p.shortDescription,
        tags: JSON.stringify(p.tags), compareAtPrice: p.compareAtPrice ?? null,
      },
    })
    productIds[p.slug] = row.id
    await upsertProductEmbedding(row.id).catch((e) => console.error('embed fail', p.name, e.message))
  }
  console.log(`✓ ${products.length} products (+embeddings)`)

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

  // ── Orders ──────────────────────────────────────────────────────────────
  type OI = { slug: string; qty: number }
  type O = {
    n: number; cust: string; status: string; created: Date; phone: string; address: string; name: string; items: OI[]
  }
  const orders: O[] = [
    { n: 1001, cust: '701100001', status: 'completed', created: daysAgo(9), name: 'امیر حساری', phone: '09121110001', address: 'تهران، خیابان ولیعصر، کوچه بهار، پلاک ۱۲، واحد ۳', items: [{ slug: 'airflex-white-sneaker', qty: 1 }] },
    { n: 1002, cust: '701100002', status: 'completed', created: daysAgo(6), name: 'سارا محمدی', phone: '09352220002', address: 'اصفهان، خیابان چهارباغ بالا، کوچه گلستان، پلاک ۸', items: [{ slug: 'sandberg-pro-headphones', qty: 1 }, { slug: 'brew-thermal-mug', qty: 2 }] },
    { n: 1003, cust: '701100003', status: 'cancelled', created: daysAgo(4), name: 'رضا کریمی', phone: '09193330003', address: 'شیراز، بلوار زند، ساختمان نور، طبقه ۲', items: [{ slug: 'active-5-smartwatch', qty: 1 }] },
    { n: 1004, cust: '701100001', status: 'shipped', created: daysAgo(2), name: 'امیر حساری', phone: '09121110001', address: 'تهران، خیابان ولیعصر، کوچه بهار، پلاک ۱۲، واحد ۳', items: [{ slug: 'citypack-laptop-backpack', qty: 1 }] },
    { n: 1005, cust: '701100002', status: 'confirmed', created: daysAgo(1), name: 'سارا محمدی', phone: '09352220002', address: 'اصفهان، خیابان چهارباغ بالا، کوچه گلستان، پلاک ۸', items: [{ slug: 'gateway-walking-shoes', qty: 1 }] },
    { n: 1006, cust: '701100004', status: 'pending', created: daysAgo(0, 2), name: 'مریم احمدی', phone: '09364440004', address: 'مشهد، بلوار وکیل‌آباد، خیابان لادن، پلاک ۲۱', items: [{ slug: 'royal-polarized-sunglasses', qty: 1 }, { slug: 'nota-leather-notebook', qty: 1 }] },
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
  }
  await db.counter.upsert({
    where: { name: 'order' },
    create: { name: 'order', value: 1006 },
    update: { value: Math.max(1006, (await db.counter.findUnique({ where: { name: 'order' } }))?.value ?? 0) },
  })
  console.log(`✓ ${orders.length} orders (next orderNumber = 1007)`)

  // ── Summary ─────────────────────────────────────────────────────────────
  const counts = {
    users: await db.user.count(), categories: await db.category.count(),
    products: await db.product.count(), customers: await db.customer.count(),
    orders: await db.order.count(), orderItems: await db.orderItem.count(),
    embeddings: await db.productEmbedding.count(), settings: await db.setting.count(),
  }
  console.log('🌱 Seed complete:', counts)
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
