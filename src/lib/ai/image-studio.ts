import 'server-only'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { logEvent } from '@/lib/logger'
import { AiError } from '@/lib/ai/client'
import { openRouterImageEdit } from '@/lib/ai/provider'
import { uploadDir } from '@/lib/upload-dir'

/**
 * AI Image Studio — turns a raw product photo into a professional studio shot.
 *
 * Pipeline (each AI call happens ONLY on an explicit seller click, never
 * automatically on upload — cost control):
 *   • cutout (optional)      removeBackground()   → product on pure white
 *   • compose (one AI call)  composeStudioImage() → product placed on a preset
 *                             OR a fully custom seller-described background
 *
 * The compose step works straight from the RAW photo (one billed render per
 * result); the cutout is optional when the seller wants an isolated subject.
 *
 * ABSOLUTE RULE (Master prompt §3): the AI must NEVER redesign the product.
 * Every prompt includes hard preservation constraints, and the result is only
 * attached to the product after the seller previews and explicitly approves it.
 */

// ─── Background template library ─────────────────────────────────────────────

export type BackgroundTemplate = {
  key: string
  name: string
  description: string
  /** tailwind classes that render the preview swatch in the panel */
  previewClass: string
  /** English prompt fragment describing the background + lighting */
  prompt: string
}

export const BACKGROUND_LIBRARY: BackgroundTemplate[] = [
  {
    key: 'luxury_white_studio',
    name: 'استودیوی سفید لوکس',
    description: 'پس‌زمینه سفید با نور استودیویی و سایه نرم — مناسب کاتالوگ',
    previewClass:
      'bg-gradient-to-br from-white via-stone-50 to-stone-200 ring-1 ring-stone-200',
    prompt:
      'a luxury pure white studio background, seamless white sweep, soft even softbox lighting, gentle natural soft shadow directly under the product, minimal clean e-commerce catalog look',
  },
  {
    key: 'black_luxury',
    name: 'مشکی لوکس',
    description: 'پس‌زمینه مشکی عمیق با نور متمرکز — محصولات خاص',
    previewClass:
      'bg-gradient-to-br from-zinc-900 via-black to-zinc-800 ring-1 ring-zinc-700',
    prompt:
      'a deep black luxury background, focused spotlight on the product, controlled elegant reflections, high-end premium jewelry advertising look, rich contrast without glare',
  },
  {
    key: 'marble_luxury',
    name: 'مرمر لوکس',
    description: 'سطح مرمری روشن با بافت ظریف طبیعی',
    previewClass:
      'bg-gradient-to-br from-stone-100 via-stone-50 to-stone-300 ring-1 ring-stone-200',
    prompt:
      'a bright natural marble surface with delicate veining as the background, soft daylight studio lighting, gentle soft shadow, elegant jewelry photography',
  },
  {
    key: 'beige_velvet',
    name: 'مخمل بژ',
    description: 'مخمل کرم با نور گرم و ملایم — مناسب هدیه',
    previewClass:
      'bg-gradient-to-br from-amber-50 via-orange-100 to-amber-200 ring-1 ring-amber-200',
    prompt:
      'a soft cream beige velvet fabric background, warm gentle diffused lighting, cozy gift-presenting mood, subtle velvet texture, soft shadow',
  },
  {
    key: 'silver_reflection',
    name: 'بازتاب نقره‌ای',
    description: 'سطح تیره با بازتاب کنترل‌شده — نمایش درخشش فلز',
    previewClass:
      'bg-gradient-to-br from-slate-600 via-slate-500 to-slate-700 ring-1 ring-slate-400',
    prompt:
      'a dark grey reflective glossy surface with controlled silver reflections beneath the product, professional jewelry lighting that highlights the natural shine of the metal without exaggeration',
  },
  {
    key: 'premium_dark_studio',
    name: 'استودیوی تیره پریمیوم',
    description: 'خاکستری تیره با نور سینمایی و نور لبه‌ای',
    previewClass:
      'bg-gradient-to-br from-zinc-700 via-zinc-800 to-zinc-900 ring-1 ring-zinc-600',
    prompt:
      'a premium dark grey studio background with cinematic rim lighting outlining the edges of the product, professional advertising photography, dramatic but tasteful',
  },
  {
    key: 'soft_pink_studio',
    name: 'صورتی ملایم',
    description: 'پس‌زمینه صورتی ظریف با نور نرم — هدیه و زیورآلات زنانه',
    previewClass:
      'bg-gradient-to-br from-rose-50 via-pink-100 to-rose-200 ring-1 ring-rose-200',
    prompt:
      'a soft pastel pink studio background with delicate minimal design, gentle flattering soft light, feminine gift mood, subtle gradient',
  },
  {
    key: 'royal_luxury',
    name: 'رویال لوکس',
    description: 'سرمه‌ای عمیق با نورپردازی لوکس — تصاویر خاص',
    previewClass:
      'bg-gradient-to-br from-indigo-950 via-slate-900 to-indigo-900 ring-1 ring-indigo-800',
    prompt:
      'a deep royal navy blue background with luxurious fine lighting and very subtle elegant details, prestigious jewelry campaign look',
  },
]

export const CUSTOM_BACKGROUND_KEY = 'custom'

export function getBackground(key: string): BackgroundTemplate | null {
  return BACKGROUND_LIBRARY.find((b) => b.key === key) ?? null
}

// ─── File helpers (upload dir — same storage as /api/uploads) ────────────────

const UPLOAD_DIR = uploadDir()
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/
const AI_TIMEOUT_MS = 150_000

async function readUploadBuffer(url: string): Promise<{ buf: Buffer; mime: string }> {
  const name = url.replace(/^\/api\/uploads\//, '').trim()
  if (!name || name.includes('/') || name.includes('..') || !SAFE_NAME_RE.test(name)) {
    throw new AiError('آدرس تصویر ورودی معتبر نیست')
  }
  try {
    const buf = await readFile(path.join(UPLOAD_DIR, name))
    const ext = path.extname(name).toLowerCase()
    const mime =
      ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.webp'
          ? 'image/webp'
          : 'image/png'
    return { buf, mime }
  } catch {
    throw new AiError('فایل تصویر ورودی پیدا نشد — لطفاً دوباره آپلود کنید')
  }
}

function toDataUrl(buf: Buffer, mime: string): string {
  return `data:${mime};base64,${buf.toString('base64')}`
}

async function saveStudioImage(buffer: Buffer, kind: 'subject' | 'final'): Promise<string> {
  await mkdir(UPLOAD_DIR, { recursive: true })
  const name = `studio-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  await writeFile(path.join(UPLOAD_DIR, name), buffer)
  return `/api/uploads/${name}`
}

/** Downscale/normalize the AI output so it is ready for panel + Telegram use. */
async function normalizeOutput(raw: Buffer): Promise<Buffer> {
  try {
    const sharpModule = await import('sharp')
    const sharp = sharpModule.default
    return await sharp(raw)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer()
  } catch {
    return raw // sharp unavailable → keep the original bytes
  }
}

// ─── Prompt engineering ──────────────────────────────────────────────────────

const PRESERVE_RULES = `CRITICAL PRESERVATION RULES (highest priority):
- This is a REAL silver product for sale. Do NOT redesign, reshape, recolor or restyle it.
- Keep the product EXACTLY as in the source photo: same shape, same angle, same stones, same chain links, same clasp, same engravings, same proportions, same silver color and finish.
- Do NOT add any detail that is not in the source photo. Do NOT remove any real detail. Do NOT create a similar-but-different product.`

const REMOVE_BG_PROMPT = `Isolate the silver jewelry product from its background with pixel-perfect precision.
Preserve the delicate metal edges, thin chains, decorative stones, clasps and engravings exactly as they are.
Remove the old background, stray shadows and any distracting elements around the product.
Output: only the product, centered, on a pure uniform plain white background (#FFFFFF), professional jewelry photo, razor-sharp.
${PRESERVE_RULES}`

function composePrompt(bg: BackgroundTemplate): string {
  return `Place this exact silver product, unchanged, onto ${bg.prompt}.
The product stays fully sharp and identical to the source — only the background and lighting change.
Professional jewelry studio photography: softbox lighting, soft natural shadow under the product, controlled subtle reflections, premium commercial look.
No exaggerated glow, no artificial sparkles, no extra decorative props around the product.
${PRESERVE_RULES}`
}

function customComposePrompt(customPrompt: string | null, hasReference: boolean): string {
  const bgLine = hasReference
    ? customPrompt?.trim()
      ? `Place this exact silver product onto a background that matches BOTH: (1) the environment, surfaces, colors and mood shown in the SECOND image (the seller's background reference), and (2) the seller's written description: "${customPrompt.trim()}".`
      : `Place this exact silver product onto the exact environment shown in the SECOND image (the seller's background reference photo). Rebuild that scene naturally around the product: same surfaces, same colors, same mood and lighting as the reference.`
    : `Place this exact silver product onto a custom background the seller described: "${customPrompt?.trim()}". Realize that description as a believable, professionally-lit photographic scene.`

  return `${bgLine}
Integrate the product into the scene with realistic soft shadow and natural perspective; the product must look photographed there, not pasted.
Professional jewelry studio photography: softbox-quality lighting, controlled subtle reflections, premium commercial look.
No exaggerated glow, no artificial sparkles, no extra decorative props that hide the product.
${PRESERVE_RULES}`
}

// ─── AI call (OpenRouter ONLY — the seller's own key + credit balance) ─────

async function callImageEdit(prompt: string, dataUrls: string[]): Promise<Buffer> {
  try {
    // Runs on OpenRouter's image-output models with the seller's own key —
    // billed per render from the credit balance, no daily free-quota roulette.
    const { base64 } = await openRouterImageEdit(prompt, dataUrls, AI_TIMEOUT_MS)
    const raw = Buffer.from(base64, 'base64')
    return await normalizeOutput(raw)
  } catch (e) {
    if (e instanceof AiError) {
      // Precise Persian error (quota / key / safety / timeout) — surface as-is.
      await logEvent('studio.ai_error', e.message.slice(0, 200), {}, 'warn')
      throw e
    }
    const msg = e instanceof Error ? e.message : String(e)
    await logEvent('studio.ai_error', `خطای سرویس تصویر: ${msg.slice(0, 200)}`, {}, 'warn')
    if (msg.includes('timeout') || msg.includes('aborted')) {
      throw new AiError('پردازش تصویر بیش از حد طول کشید — لطفاً دوباره تلاش کنید')
    }
    throw new AiError('تولید تصویر ناموفق بود — لطفاً کمی بعد دوباره تلاش کنید')
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type ComposeOptions = {
  backgroundKey?: string | null
  customPrompt?: string | null
  customBgUrl?: string | null
}

/** Optional step: isolate the product on a pure white background. */
export async function removeBackground(imageUrl: string): Promise<string> {
  const { buf, mime } = await readUploadBuffer(imageUrl)
  const out = await callImageEdit(REMOVE_BG_PROMPT, [toDataUrl(buf, mime)])
  const url = await saveStudioImage(out, 'subject')
  await logEvent('studio.subject', 'سوژه محصول از پس‌زمینه جدا شد', { imageUrl, url })
  return url
}

/**
 * ONE AI call: place the product (raw photo or cutout) on the chosen
 * background — a preset from the library, or a fully custom seller-defined
 * background (free-text description and/or a reference photo upload).
 */
export async function composeStudioImage(
  sourceUrl: string,
  opts: ComposeOptions,
): Promise<{ url: string; backgroundKey: string | null; customPrompt: string | null; customBgUrl: string | null }> {
  const isCustom =
    !opts.backgroundKey ||
    opts.backgroundKey === CUSTOM_BACKGROUND_KEY ||
    Boolean(opts.customPrompt?.trim()) ||
    Boolean(opts.customBgUrl?.trim())

  const customPrompt = opts.customPrompt?.trim() || null
  const customBgUrl = opts.customBgUrl?.trim() || null

  const dataUrls: string[] = []
  let backgroundKey: string | null

  if (isCustom) {
    if (!customPrompt && !customBgUrl) {
      throw new AiError(
        'برای پس‌زمینه دلخواه، یک توضیح بنویسید یا یک عکس مرجع پس‌زمینه انتخاب کنید',
      )
    }
    backgroundKey = CUSTOM_BACKGROUND_KEY
    const { buf, mime } = await readUploadBuffer(sourceUrl)
    dataUrls.push(toDataUrl(buf, mime))
    if (customBgUrl) {
      const ref = await readUploadBuffer(customBgUrl)
      dataUrls.push(toDataUrl(ref.buf, ref.mime))
    }
    await logEvent(
      'studio.compose_custom',
      `پس‌زمینه دلخواه: ${customPrompt ? 'توضیح متنی' : ''}${customPrompt && customBgUrl ? ' + ' : ''}${customBgUrl ? 'عکس مرجع' : ''}`,
      { sourceUrl },
    )
    const out = await callImageEdit(customComposePrompt(customPrompt, Boolean(customBgUrl)), dataUrls)
    const url = await saveStudioImage(out, 'final')
    return { url, backgroundKey, customPrompt, customBgUrl }
  }

  const bg = getBackground(opts.backgroundKey ?? '')
  if (!bg) throw new AiError('پس‌زمینه انتخاب‌شده معتبر نیست')
  backgroundKey = bg.key
  const { buf, mime } = await readUploadBuffer(sourceUrl)
  dataUrls.push(toDataUrl(buf, mime))
  const out = await callImageEdit(composePrompt(bg), dataUrls)
  const url = await saveStudioImage(out, 'final')
  await logEvent('studio.composed', `تصویر استودیویی با پس‌زمینه «${bg.name}» ساخته شد`, {
    sourceUrl,
    backgroundKey,
    url,
  })
  return { url, backgroundKey, customPrompt: null, customBgUrl: null }
}
