import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { AiError } from '@/lib/ai/client'
import { BACKGROUND_LIBRARY, composeStudioImage, removeBackground } from '@/lib/ai/image-studio'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { syncProductPost } from '@/lib/telegram'
import { PRODUCT_INCLUDE, replaceProductGallery, serializeProduct } from '../../shared'

// ─── AI Image Studio — per-product processing jobs ───────────────────────────
// Every AI call is triggered by an EXPLICIT seller action (never automatic),
// and the raw upload + subject cutout are preserved: the approved composite is
// only ADDED to the gallery as the primary image, never overwriting the source.

function serializeJob(j: {
  id: string
  productId: string
  rawUrl: string
  subjectUrl: string | null
  finalUrl: string | null
  backgroundKey: string | null
  status: string
  error: string | null
  approvedAt: Date | null
  createdAt: Date
}) {
  return {
    id: j.id,
    productId: j.productId,
    rawUrl: j.rawUrl,
    subjectUrl: j.subjectUrl,
    finalUrl: j.finalUrl,
    backgroundKey: j.backgroundKey,
    status: j.status,
    error: j.error,
    approvedAt: j.approvedAt,
    createdAt: j.createdAt,
  }
}

export const GET = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const product = await db.product.findUnique({ where: { id }, select: { id: true } })
    if (!product) throw new ApiError(404, 'محصول یافت نشد')

    const jobs = await db.imageStudioJob.findMany({
      where: { productId: id },
      orderBy: { createdAt: 'desc' },
      take: 12,
    })

    return ok({
      backgrounds: BACKGROUND_LIBRARY.map((b) => ({
        key: b.key,
        name: b.name,
        description: b.description,
        previewClass: b.previewClass,
      })),
      jobs: jobs.map(serializeJob),
    })
  },
)

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('remove-background'),
    imageUrl: z.string().min(1, 'تصویر ورودی ارسال نشده است'),
  }),
  z.object({
    action: z.literal('generate'),
    jobId: z.string().min(1),
    backgroundKey: z.string().min(1, 'پس‌زمینه انتخاب نشده است'),
  }),
  z.object({ action: z.literal('approve'), jobId: z.string().min(1) }),
  z.object({ action: z.literal('reject'), jobId: z.string().min(1) }),
])

export const POST = route<{ params: Promise<{ id: string }> }>(
  async (req: NextRequest, { params }) => {
    const user = await requireAuth()
    const { id } = await params
    const body = actionSchema.parse(await readJson(req))

    const product = await db.product.findUnique({ where: { id } })
    if (!product) throw new ApiError(404, 'محصول یافت نشد')

    if (body.action === 'remove-background') {
      // create the job first so the whole pipeline is traceable
      const job = await db.imageStudioJob.create({
        data: { productId: id, rawUrl: body.imageUrl, status: 'raw' },
      })
      try {
        const subjectUrl = await removeBackground(body.imageUrl)
        const updated = await db.imageStudioJob.update({
          where: { id: job.id },
          data: { subjectUrl, status: 'subject_ready', error: null },
        })
        return ok({ job: serializeJob(updated) }, 201)
      } catch (e) {
        const message =
          e instanceof AiError ? e.message : 'جداسازی سوژه ناموفق بود — لطفاً دوباره تلاش کنید'
        await db.imageStudioJob.update({
          where: { id: job.id },
          data: { status: 'failed', error: message },
        })
        await logEvent(
          'studio.failed',
          `جداسازی پس‌زمینه محصول «${product.name}» ناموفق بود`,
          { productId: id, error: message },
          'warn',
        )
        throw new ApiError(502, message)
      }
    }

    // remaining actions work on an existing job
    const job = await db.imageStudioJob.findUnique({ where: { id: body.jobId } })
    if (!job || job.productId !== id) throw new ApiError(404, 'کار پردازش یافت نشد')

    if (body.action === 'generate') {
      const source = job.subjectUrl ?? job.rawUrl
      try {
        const finalUrl = await composeStudioImage(source, body.backgroundKey)
        const updated = await db.imageStudioJob.update({
          where: { id: job.id },
          data: { finalUrl, backgroundKey: body.backgroundKey, status: 'generated', error: null },
        })
        return ok({ job: serializeJob(updated) })
      } catch (e) {
        const message =
          e instanceof AiError
            ? e.message
            : 'تولید تصویر استودیویی ناموفق بود — لطفاً دوباره تلاش کنید'
        await db.imageStudioJob.update({
          where: { id: job.id },
          data: { status: 'failed', error: message },
        })
        await logEvent(
          'studio.failed',
          `تولید تصویر استودیویی «${product.name}» ناموفق بود`,
          { jobId: job.id, error: message },
          'warn',
        )
        throw new ApiError(502, message)
      }
    }

    if (body.action === 'reject') {
      const updated = await db.imageStudioJob.update({
        where: { id: job.id },
        data: { status: 'rejected' },
      })
      await logEvent('studio.rejected', `تصویر استودیویی «${product.name}» توسط فروشنده رد شد`, {
        jobId: job.id,
      })
      return ok({ job: serializeJob(updated) })
    }

    // action === 'approve' — attach the composite as the product's PRIMARY image
    if (!job.finalUrl) {
      throw new ApiError(400, 'این کار هنوز تصویر نهایی ندارد')
    }

    const existing = await db.productImage.findMany({ where: { productId: id } })
    const gallery = [
      { url: job.finalUrl, isPrimary: true, sortOrder: 0 },
      ...existing
        .filter((img) => img.url !== job.finalUrl)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((img) => ({ url: img.url, isPrimary: false, sortOrder: img.sortOrder + 1 })),
    ]
    await replaceProductGallery(id, gallery)

    const updated = await db.imageStudioJob.update({
      where: { id: job.id },
      data: { status: 'approved', approvedAt: new Date(), error: null },
    })

    await logEvent(
      'studio.approved',
      `تصویر استودیویی «${product.name}» تأیید و به محصول متصل شد`,
      {
        jobId: job.id,
        finalUrl: job.finalUrl,
        approvedBy: user.email,
      },
    )

    // keep an already-published channel post in sync (best-effort, never blocks)
    const refreshed = await db.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE })
    if (refreshed && refreshed.status === 'active') {
      void syncProductPost(refreshed).catch(() => undefined)
    }

    return ok({
      job: serializeJob(updated),
      product: refreshed ? serializeProduct(refreshed) : null,
    })
  },
)
