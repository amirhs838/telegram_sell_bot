'use client'

/**
 * AI Image Studio (استودیوی تصویر) — wizard dialog that turns a raw product
 * photo into a professional studio image, powered by the seller's own Google
 * Gemini key (native image-editing models):
 *
 *   1. source image  → the product's MAIN image is pre-selected automatically;
 *                      no upload is required to continue (upload is optional)
 *   2. background    → 8 preset studio templates + «پس‌زمینه دلخواه»:
 *                      the seller describes a custom background in Persian
 *                      and/or uploads a reference photo (both optional)
 *   3. result        → ONE Gemini edit call places the product on the chosen
 *                      background (1 quota unit per render); optional cutout
 *                      step for a pure-white catalog shot
 *   4. approve       → attach as the product's primary image
 *
 * The old hard gate is gone: «ادامه» no longer requires a fresh upload or any
 * AI call — the seller can go straight from the main image to background
 * selection. All slow endpoints lock the buttons while in flight, with an
 * elapsed-seconds counter; quota errors surface with precise Persian copy.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  History,
  ImageOff,
  ImagePlus,
  Loader2,
  RefreshCcw,
  Scissors,
  Sparkles,
  Upload,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  fmtDate,
  fmtNumber,
  type Product,
  type StudioBackground,
  type StudioJob,
  type StudioState,
} from '@/lib/client'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5MB (mirrors POST /api/uploads limit)
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp']
const CUSTOM_BG_KEY = 'custom'

type Step = 'source' | 'subject' | 'compare' | 'approved'
type BusyAction = 'cutout' | 'generate' | 'approve' | 'reject' | null

/** Persian label + outline badge classes for each job status. */
const JOB_STATUS_FA: Record<string, { label: string; badgeClass: string }> = {
  raw: { label: 'شروع شده', badgeClass: 'bg-slate-100 text-slate-600 border-slate-200' },
  subject_ready: { label: 'سوژه آماده', badgeClass: 'bg-sky-50 text-sky-700 border-sky-200' },
  generated: { label: 'تصویر تولید شد', badgeClass: 'bg-violet-50 text-violet-700 border-violet-200' },
  approved: { label: 'تأییدشده', badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  rejected: { label: 'ردشده', badgeClass: 'bg-slate-100 text-slate-500 border-slate-200' },
  failed: { label: 'ناموفق', badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
}

function jobStatusFa(status: string): { label: string; badgeClass: string } {
  return (
    JOB_STATUS_FA[status] ?? {
      label: status,
      badgeClass: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  )
}

/** Subtle checkerboard so transparent subjects stay visible on light bgs. */
const CHECKER_STYLE = {
  backgroundImage: 'repeating-conic-gradient(#f4f4f5 0% 25%, #ffffff 0% 50%)',
  backgroundSize: '16px 16px',
} as const

const STEPS: { key: Step; label: string }[] = [
  { key: 'source', label: 'تصویر منبع' },
  { key: 'subject', label: 'پس‌زمینه و سبک' },
  { key: 'compare', label: 'نتیجه' },
  { key: 'approved', label: 'اتصال به محصول' },
]

/** Unique gallery URLs of a product (imageUrl first, then images[]). */
function productGalleryImages(p: Product | null): string[] {
  if (!p) return []
  const urls: string[] = []
  if (p.imageUrl) urls.push(p.imageUrl)
  for (const im of p.images ?? []) {
    if (im.url && !urls.includes(im.url)) urls.push(im.url)
  }
  return urls
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Stepper({ step }: { step: Step }) {
  const currentIdx = STEPS.findIndex((s) => s.key === step)
  return (
    <ol
      aria-label="مرحله‌های استودیو"
      className="flex items-center gap-1.5 rounded-xl border bg-muted/30 px-3 py-2 text-xs"
    >
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-current={i === currentIdx ? 'step' : undefined}
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold',
              i < currentIdx && 'border-emerald-200 bg-emerald-100 text-emerald-700',
              i === currentIdx && 'border-emerald-600 bg-emerald-600 text-white',
              i > currentIdx && 'border-border bg-background text-muted-foreground',
            )}
          >
            {i < currentIdx ? <Check className="size-3" aria-hidden /> : fmtNumber(i + 1)}
          </span>
          <span
            className={cn(
              'hidden truncate sm:inline',
              i === currentIdx ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {s.label}
          </span>
          {i < STEPS.length - 1 && (
            <span className="h-px w-3 shrink-0 bg-border sm:w-5" aria-hidden />
          )}
        </li>
      ))}
    </ol>
  )
}

/** Green status card shown while a slow AI request is running. */
function ProgressStatus({
  title,
  hint,
  elapsed,
}: {
  title: string
  hint: string
  elapsed: number
}) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4"
    >
      <Loader2 className="size-5 shrink-0 animate-spin text-emerald-600" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-emerald-900">{title}</p>
        <p className="text-xs text-emerald-800/80">
          {hint} — <span className="tabular-nums-fa font-medium">{fmtNumber(elapsed)}</span> ثانیه
          گذشته
        </p>
      </div>
    </div>
  )
}

/** Destructive alert with an optional retry affordance. */
function StepErrorAlert({
  message,
  onRetry,
  retryLabel,
}: {
  message: string
  onRetry?: () => void
  retryLabel?: string
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden />
      <AlertTitle>عملیات ناموفق بود</AlertTitle>
      <AlertDescription className="items-start">
        <span className="break-words">{message}</span>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="mt-1">
            <RefreshCcw className="size-3.5" aria-hidden />
            {retryLabel ?? 'تلاش مجدد'}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

/** One selectable source-image thumbnail (gallery item or fresh upload). */
function SourceThumb({
  url,
  selected,
  onSelect,
  badge,
  disabled,
}: {
  url: string
  selected: boolean
  onSelect: () => void
  badge?: string
  disabled?: boolean
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
        className={cn(
          'relative block aspect-square w-full overflow-hidden rounded-lg border-2 outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60',
          selected
            ? 'border-emerald-500 ring-2 ring-emerald-500/30'
            : 'border-transparent hover:border-muted-foreground/30',
        )}
      >
        <img src={url} alt="تصویر گالری محصول" className="size-full object-cover" />
        {badge && (
          <span className="absolute start-1 top-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-white">
            {badge}
          </span>
        )}
        {selected && (
          <span className="absolute end-1 top-1 flex size-5 items-center justify-center rounded-full bg-emerald-600 text-white shadow">
            <Check className="size-3" aria-hidden />
          </span>
        )}
      </button>
    </li>
  )
}

/** One background template card; the subject is overlaid on the preview. */
function BackgroundCard({
  bg,
  subjectUrl,
  selected,
  onSelect,
  disabled,
}: {
  bg: StudioBackground
  subjectUrl: string | null
  selected: boolean
  onSelect: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'rounded-xl border p-2 text-start outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60',
        selected
          ? 'border-emerald-500 bg-emerald-50/50 ring-2 ring-emerald-500/40'
          : 'border-border hover:border-emerald-300 hover:bg-muted/40',
      )}
    >
      <span
        className={cn(
          'relative block h-24 w-full overflow-hidden rounded-lg border border-black/5',
          bg.previewClass,
        )}
      >
        {subjectUrl && (
          <img
            src={subjectUrl}
            alt=""
            className="pointer-events-none absolute inset-0 size-full object-contain p-1.5"
          />
        )}
        {selected && (
          <span className="absolute end-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-emerald-600 text-white shadow">
            <Check className="size-3" aria-hidden />
          </span>
        )}
      </span>
      <span className="mt-2 flex items-center gap-1 text-xs font-medium">{bg.name}</span>
      <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
        {bg.description}
      </span>
    </button>
  )
}

/** One row of the «سابقه پردازش» list. */
function HistoryRow({
  job,
  isCurrent,
  busy,
  onResume,
}: {
  job: StudioJob
  isCurrent: boolean
  busy: boolean
  onResume: (j: StudioJob) => void
}) {
  const st = jobStatusFa(job.status)
  const thumb = job.finalUrl ?? job.subjectUrl ?? job.rawUrl
  const resumable = ['raw', 'subject_ready', 'generated', 'approved', 'failed'].includes(job.status)
  return (
    <li className="flex items-center gap-3 p-3">
      {thumb ? (
        <img
          src={thumb}
          alt={`نتیجه پردازش ${fmtDate(job.createdAt)}`}
          className="size-11 shrink-0 rounded-lg border object-cover"
        />
      ) : (
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-muted">
          <ImageOff className="size-4 text-muted-foreground" aria-hidden />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={st.badgeClass}>
            {st.label}
          </Badge>
          {job.backgroundKey === CUSTOM_BG_KEY && (
            <Badge variant="outline" className="border-fuchsia-200 bg-fuchsia-50 text-[10px] text-fuchsia-700">
              پس‌زمینه دلخواه
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">{fmtDate(job.createdAt)}</span>
          {isCurrent && (
            <Badge variant="secondary" className="text-[10px]">
              در حال کار
            </Badge>
          )}
        </div>
        {job.error && <p className="mt-1 text-xs text-destructive">{job.error}</p>}
      </div>
      {resumable && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onResume(job)}
          aria-label={`ادامه پردازش ${fmtDate(job.createdAt)}`}
        >
          ادامه
        </Button>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function ImageStudioDialog({
  open,
  onOpenChange,
  productId,
  productName,
  onProductUpdated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  productId: string
  productName: string
  onProductUpdated?: (product: Product) => void
}) {
  // workflow
  const [step, setStep] = useState<Step>('source')
  const [busy, setBusy] = useState<BusyAction>(null)
  const [elapsed, setElapsed] = useState(0)
  const [stepError, setStepError] = useState<string | null>(null)

  // data
  const [product, setProduct] = useState<Product | null>(null)
  const [productLoading, setProductLoading] = useState(false)
  const [productError, setProductError] = useState<string | null>(null)
  const [studio, setStudio] = useState<StudioState | null>(null)
  const [studioLoading, setStudioLoading] = useState(false)
  const [studioError, setStudioError] = useState<string | null>(null)

  // wizard state
  const [rawUrl, setRawUrl] = useState<string | null>(null)
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [job, setJob] = useState<StudioJob | null>(null)
  const [backgroundKey, setBackgroundKey] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  // custom background state
  const [customPrompt, setCustomPrompt] = useState('')
  const [customBgUrl, setCustomBgUrl] = useState<string | null>(null)
  const [customUploading, setCustomUploading] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const customBgRef = useRef<HTMLInputElement>(null)

  // -------------------------------------------------------------------------
  // Data loading (fresh start every time the dialog opens)
  // -------------------------------------------------------------------------

  const loadProduct = useCallback(async () => {
    setProductLoading(true)
    setProductError(null)
    try {
      const d = await api<{ product: Product }>(`/api/products/${productId}`)
      setProduct(d.product)
    } catch (err) {
      setProductError((err as Error).message)
    } finally {
      setProductLoading(false)
    }
  }, [productId])

  const reloadStudio = useCallback(async () => {
    setStudioLoading(true)
    setStudioError(null)
    try {
      const d = await api<StudioState>(`/api/products/${productId}/studio`)
      setStudio(d)
    } catch (err) {
      setStudioError((err as Error).message)
    } finally {
      setStudioLoading(false)
    }
  }, [productId])

  useEffect(() => {
    if (!open || !productId) return
    // reset the wizard on every open — resumable jobs come from the history
    setStep('source')
    setBusy(null)
    setStepError(null)
    setJob(null)
    setRawUrl(null)
    setUploadedUrl(null)
    setBackgroundKey(null)
    setCustomPrompt('')
    setCustomBgUrl(null)
    setProduct(null)
    setStudio(null)
    setHistoryOpen(false)
    loadProduct()
    reloadStudio()
  }, [open, productId, loadProduct, reloadStudio])

  // AUTO-SELECT the product's main image as the source — the seller must
  // never be forced to upload something just to move forward.
  useEffect(() => {
    if (!product || rawUrl) return
    const primary =
      product.images?.find((im) => im.isPrimary)?.url ?? product.imageUrl ?? null
    const fallback = productGalleryImages(product)[0] ?? null
    const pick = primary ?? fallback
    if (pick) setRawUrl(pick)
  }, [product])

  // elapsed-seconds counter for slow AI requests
  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const startedAt = Date.now()
    const iv = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(iv)
  }, [busy])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function upsertJob(j: StudioJob) {
    setStudio((prev) =>
      prev ? { ...prev, jobs: [j, ...prev.jobs.filter((x) => x.id !== j.id)] } : prev,
    )
  }

  /** Optional AI step: isolate the subject (pure-white catalog shot). */
  async function cutoutBackground() {
    if (!rawUrl || busy) return
    setBusy('cutout')
    setStepError(null)
    try {
      const d = await api<{ job: StudioJob }>(`/api/products/${productId}/studio`, {
        method: 'POST',
        body: JSON.stringify({ action: 'remove-background', imageUrl: rawUrl }),
      })
      const j = d.job
      setJob(j)
      upsertJob(j)
      if (j.status === 'failed') {
        setStepError(j.error || 'حذف پس‌زمینه ناموفق بود — دوباره تلاش کنید.')
      } else {
        setStep('subject')
        setBackgroundKey((k) => k)
      }
    } catch (err) {
      setStepError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function generate() {
    if (busy) return
    if (!job && !rawUrl) {
      setStepError('ابتدا تصویر منبع را انتخاب کنید یا عکس جدیدی آپلود کنید.')
      return
    }
    const isCustom = backgroundKey === CUSTOM_BG_KEY
    if (!isCustom && !backgroundKey) {
      setStepError('ابتدا یک پس‌زمینه انتخاب کنید.')
      return
    }
    if (isCustom && !customPrompt.trim() && !customBgUrl) {
      setStepError('برای پس‌زمینه دلخواه، یک توضیح بنویسید یا یک عکس مرجع انتخاب کنید.')
      return
    }
    setBusy('generate')
    setStepError(null)
    try {
      const payload: Record<string, unknown> = job
        ? { action: 'generate', jobId: job.id }
        : { action: 'generate', imageUrl: rawUrl }
      if (isCustom) {
        payload.backgroundKey = CUSTOM_BG_KEY
        if (customPrompt.trim()) payload.customPrompt = customPrompt.trim()
        if (customBgUrl) payload.customBgUrl = customBgUrl
      } else {
        payload.backgroundKey = backgroundKey
      }
      const d = await api<{ job: StudioJob }>(`/api/products/${productId}/studio`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const j = d.job
      setJob(j)
      upsertJob(j)
      if (j.status === 'failed') {
        setStepError(j.error || 'تولید تصویر ناموفق بود — دوباره تلاش کنید.')
      } else if (j.finalUrl) {
        setStep('compare')
      }
    } catch (err) {
      setStepError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function approve() {
    if (!job || busy) return
    setBusy('approve')
    setStepError(null)
    try {
      const d = await api<{ job: StudioJob; product: Product }>(
        `/api/products/${productId}/studio`,
        {
          method: 'POST',
          body: JSON.stringify({ action: 'approve', jobId: job.id }),
        },
      )
      setJob(d.job)
      upsertJob(d.job)
      setStep('approved')
      toast.success('تصویر استودیویی به‌عنوان تصویر اصلی محصول متصل شد')
      onProductUpdated?.(d.product)
    } catch (err) {
      setStepError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function rejectJob() {
    if (!job || busy) return
    setBusy('reject')
    setStepError(null)
    try {
      const d = await api<{ job: StudioJob }>(`/api/products/${productId}/studio`, {
        method: 'POST',
        body: JSON.stringify({ action: 'reject', jobId: job.id }),
      })
      upsertJob(d.job)
      toast.info('تصویر رد شد — می‌توانید دوباره شروع کنید.')
      setJob(null)
      setBackgroundKey(null)
      setStep('source')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function resumeJob(j: StudioJob) {
    setStepError(null)
    setJob(j.status === 'failed' ? null : j)
    setRawUrl(j.rawUrl)
    setCustomPrompt(j.customPrompt ?? '')
    setCustomBgUrl(j.customBgUrl)
    setBackgroundKey(j.backgroundKey)
    if (j.status === 'subject_ready') setStep('subject')
    else if (j.status === 'generated') setStep('compare')
    else if (j.status === 'approved') setStep('approved')
    else setStep('source')
    setHistoryOpen(false)
  }

  async function onUploadFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!ACCEPTED_MIME.includes(file.type)) {
      toast.error('فرمت فایل مجاز نیست. فقط JPG، PNG یا WebP مجاز است.')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('حجم فایل نباید بیشتر از ۵ مگابایت باشد.')
      return
    }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api<{ url: string; name: string }>('/api/uploads', {
        method: 'POST',
        body: fd,
      })
      setUploadedUrl(res.url)
      setRawUrl(res.url)
      setStepError(null)
      toast.success('تصویر خام آپلود شد')
    } catch (err) {
      toast.error(`آپلود ناموفق بود: ${(err as Error).message}`)
    } finally {
      setUploading(false)
    }
  }

  async function onUploadCustomBg(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!ACCEPTED_MIME.includes(file.type)) {
      toast.error('فرمت فایل مجاز نیست. فقط JPG، PNG یا WebP مجاز است.')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('حجم فایل نباید بیشتر از ۵ مگابایت باشد.')
      return
    }
    setCustomUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api<{ url: string; name: string }>('/api/uploads', {
        method: 'POST',
        body: fd,
      })
      setCustomBgUrl(res.url)
      toast.success('عکس مرجع پس‌زمینه ذخیره شد')
    } catch (err) {
      toast.error(`آپلود ناموفق بود: ${(err as Error).message}`)
    } finally {
      setCustomUploading(false)
    }
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const primaryUrl = product?.images?.find((im) => im.isPrimary)?.url ?? product?.imageUrl ?? null
  const gallery = productGalleryImages(product).filter((u) => u !== uploadedUrl)
  const jobs = studio?.jobs ?? []
  const disabledByBusy = busy !== null
  const compareRaw = rawUrl ?? job?.rawUrl ?? null
  const customSelected = backgroundKey === CUSTOM_BG_KEY
  const customReady = customPrompt.trim().length > 0 || Boolean(customBgUrl)
  const canGenerate =
    !disabledByBusy &&
    Boolean(job || rawUrl) &&
    Boolean(backgroundKey) &&
    (!customSelected || customReady)
  const approvedResultUrl = job?.finalUrl ?? job?.subjectUrl ?? null

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader className="text-start">
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="size-5 text-emerald-600" aria-hidden />
            استودیوی تصویر
          </DialogTitle>
          <DialogDescription>
            تبدیل عکس «{productName}» به تصویر استودیویی حرفه‌ای با جمنای — انتخاب پس‌زمینهٔ آماده یا
            دلخواه، بدون نیاز به آپلود مجدد.
          </DialogDescription>
        </DialogHeader>

        <Stepper step={step} />

        {/* ------------------------------------------------ step 1: source */}
        {step === 'source' && (
          <section className="space-y-4" aria-label="انتخاب تصویر منبع">
            <div className="space-y-1">
              <p className="text-sm font-medium">۱. تصویر منبع</p>
              <p className="text-xs text-muted-foreground">
                تصویر اصلی محصول به‌طور خودکار انتخاب شده است. اگر می‌خواهید تصویر دیگری را پردازش
                کنید، از گالری انتخاب کنید یا عکس جدید آپلود کنید — برای ادامه لازم نیست عکس جدیدی
                آپلود کنید.
              </p>
            </div>

            {productError ? (
              <StepErrorAlert
                message={productError}
                onRetry={loadProduct}
                retryLabel="دریافت مجدد گالری"
              />
            ) : productLoading ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" aria-label="در حال دریافت گالری">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-square rounded-lg" />
                ))}
              </div>
            ) : (
              (gallery.length > 0 || uploadedUrl) && (
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {uploadedUrl && (
                    <SourceThumb
                      url={uploadedUrl}
                      selected={rawUrl === uploadedUrl}
                      onSelect={() => setRawUrl(uploadedUrl)}
                      badge="آپلود جدید"
                      disabled={disabledByBusy}
                    />
                  )}
                  {gallery.map((url) => (
                    <SourceThumb
                      key={url}
                      url={url}
                      selected={rawUrl === url}
                      onSelect={() => setRawUrl(url)}
                      badge={url === primaryUrl ? 'تصویر اصلی' : undefined}
                      disabled={disabledByBusy}
                    />
                  ))}
                </ul>
              )
            )}

            {/* upload zone (optional — never a gate) */}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={onUploadFile}
              aria-label="انتخاب عکس خام برای آپلود"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || disabledByBusy}
              className="flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed py-5 text-sm text-muted-foreground outline-none transition-colors hover:border-emerald-300 hover:bg-emerald-50/40 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            >
              {uploading ? (
                <Loader2 className="size-5 animate-spin text-emerald-600" aria-hidden />
              ) : (
                <Upload className="size-5" aria-hidden />
              )}
              {uploading ? 'در حال آپلود…' : 'آپلود عکس جدید (اختیاری)'}
              <span className="text-xs">JPG، PNG یا WebP — حداکثر ۵ مگابایت</span>
            </button>

            {/* selected source summary */}
            {rawUrl && (
              <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
                <img
                  src={rawUrl}
                  alt="پیش‌نمایش تصویر منبع"
                  className="size-14 shrink-0 rounded-lg border object-cover"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-emerald-900">تصویر منبع انتخاب شد</p>
                  <p className="text-xs text-emerald-800/80">
                    برای ادامه، پس‌زمینه و سبک را در مرحلهٔ بعد انتخاب کنید.
                  </p>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button onClick={() => setStep('subject')} disabled={!rawUrl || disabledByBusy}>
                <ArrowLeft className="size-4" aria-hidden />
                ادامه و انتخاب پس‌زمینه
              </Button>
              <Button
                variant="outline"
                onClick={cutoutBackground}
                disabled={!rawUrl || disabledByBusy}
              >
                {busy === 'cutout' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Scissors className="size-4" aria-hidden />
                )}
                {busy === 'cutout' ? 'در حال پردازش…' : 'برش سوژه با هوش مصنوعی (اختیاری)'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              «برش سوژه» محصول را کاملاً از پس‌زمینه جدا می‌کند (۲۰ تا ۹۰ ثانیه)؛ معمولاً لازم نیست —
              ساخت تصویر نهایی مستقیماً از همین عکس انجام می‌شود.
            </p>

            {busy === 'cutout' && (
              <ProgressStatus
                title="در حال جداسازی سوژه از پس‌زمینه…"
                hint="این کار تا یک دقیقه طول می‌کشد"
                elapsed={elapsed}
              />
            )}

            {stepError && (
              <StepErrorAlert
                message={stepError}
                onRetry={busy === null ? cutoutBackground : undefined}
                retryLabel="تلاش مجدد حذف پس‌زمینه"
              />
            )}
          </section>
        )}

        {/* --------------------------- step 2: background library + custom */}
        {step === 'subject' && (
          <section className="space-y-4" aria-label="انتخاب پس‌زمینه استودیویی">
            <div className="rounded-xl border p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="border-transparent bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                    {job?.subjectUrl ? 'سوژه آماده است' : 'تصویر منبع انتخاب شد'}
                  </Badge>
                  <p className="text-sm font-medium">۲. انتخاب پس‌زمینه و سبک</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStepError(null)
                    setStep('source')
                  }}
                  disabled={disabledByBusy}
                >
                  تغییر تصویر منبع
                </Button>
              </div>
              <img
                src={job?.subjectUrl ?? rawUrl ?? job?.rawUrl ?? ''}
                alt="پیش‌نمایش تصویر ورودی"
                style={job?.subjectUrl ? CHECKER_STYLE : undefined}
                className="mx-auto max-h-56 rounded-lg border object-contain"
              />
            </div>

            {/* cutout shortcut — approve the pure-white version directly */}
            {job?.subjectUrl && !disabledByBusy && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-sky-200 bg-sky-50/60 p-3">
                <p className="text-xs text-sky-900">
                  اگر همین نسخهٔ سفیدِ بدون پس‌زمینه را می‌خواهید، لازم نیست ادامه دهید:
                </p>
                <Button variant="outline" size="sm" onClick={approve} disabled={disabledByBusy}>
                  <Check className="size-3.5" aria-hidden />
                  تأیید همین نسخهٔ سفید
                </Button>
              </div>
            )}

            {studioError ? (
              <StepErrorAlert
                message={studioError}
                onRetry={reloadStudio}
                retryLabel="دریافت مجدد پس‌زمینه‌ها"
              />
            ) : studioLoading ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="در حال دریافت پس‌زمینه‌ها">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-36 rounded-xl" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {(studio?.backgrounds ?? []).map((bg) => (
                  <BackgroundCard
                    key={bg.key}
                    bg={bg}
                    subjectUrl={job?.subjectUrl ?? null}
                    selected={backgroundKey === bg.key && !customSelected}
                    onSelect={() => {
                      setBackgroundKey(bg.key)
                      setStepError(null)
                    }}
                    disabled={disabledByBusy}
                  />
                ))}

                {/* ─── custom background card ─── */}
                <div
                  className={cn(
                    'col-span-2 rounded-xl border-2 border-dashed p-3 outline-none transition-all md:col-span-4',
                    customSelected
                      ? 'border-emerald-500 bg-emerald-50/40 ring-2 ring-emerald-500/30'
                      : 'border-border hover:border-emerald-300 hover:bg-muted/40',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setBackgroundKey(CUSTOM_BG_KEY)
                      setStepError(null)
                    }}
                    disabled={disabledByBusy}
                    aria-pressed={customSelected}
                    className="flex w-full items-center gap-2 text-start outline-none"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-fuchsia-100 via-amber-50 to-sky-100 ring-1 ring-black/5">
                      <ImagePlus className="size-4 text-fuchsia-600" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">پس‌زمینه دلخواه</span>
                      <span className="block text-[11px] leading-4 text-muted-foreground">
                        خودتان توضیح دهید چه پس‌زمینه‌ای می‌خواهید، یا عکس مرجع بدهید — دلخواه و
                        اختیاری
                      </span>
                    </span>
                    {customSelected && (
                      <span className="ms-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow">
                        <Check className="size-3" aria-hidden />
                      </span>
                    )}
                  </button>

                  {customSelected && (
                    <div className="mt-3 space-y-2.5">
                      <Textarea
                        rows={2}
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        disabled={disabledByBusy}
                        maxLength={500}
                        placeholder="توضیح پس‌زمینه… مثلاً: روی میز چوب گردو کنار شمع و گل رز، با نور گرم عصر"
                        aria-label="توضیح پس‌زمینه دلخواه"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          ref={customBgRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="sr-only"
                          onChange={onUploadCustomBg}
                          aria-label="انتخاب عکس مرجع پس‌زمینه"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => customBgRef.current?.click()}
                          disabled={customUploading || disabledByBusy}
                        >
                          {customUploading ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <ImagePlus className="size-3.5" aria-hidden />
                          )}
                          {customUploading ? 'در حال آپلود…' : 'عکس مرجع پس‌زمینه (اختیاری)'}
                        </Button>
                        {customBgUrl && (
                          <span className="flex items-center gap-1.5 rounded-lg border bg-background p-1 ps-2">
                            <img
                              src={customBgUrl}
                              alt="عکس مرجع پس‌زمینه"
                              className="size-8 rounded border object-cover"
                            />
                            <span className="text-[11px] text-muted-foreground">مرجع انتخاب شد</span>
                            <button
                              type="button"
                              onClick={() => setCustomBgUrl(null)}
                              disabled={disabledByBusy}
                              aria-label="حذف عکس مرجع"
                              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-rose-50 hover:text-destructive outline-none"
                            >
                              <X className="size-3.5" aria-hidden />
                            </button>
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        توضیح متنی و عکس مرجع هر دو اختیاری‌اند؛ حداقل یکی را پر کنید. می‌توانید هر
                        دو را با هم بدهید تا دقیق‌تر ساخته شود.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={generate}
                disabled={!canGenerate}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {busy === 'generate' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="size-4" aria-hidden />
                )}
                {busy === 'generate' ? 'در حال ساخت…' : 'ساخت تصویر حرفه‌ای با جمنای'}
              </Button>
              {!backgroundKey && !disabledByBusy && (
                <p className="text-xs text-muted-foreground">ابتدا یک پس‌زمینه انتخاب کنید.</p>
              )}
            </div>

            {busy === 'generate' && (
              <ProgressStatus
                title="جمنای در حال ساخت تصویر است…"
                hint="معمولاً ۱۵ تا ۶۰ ثانیه؛ تا دو دقیقه"
                elapsed={elapsed}
              />
            )}

            {stepError && (
              <StepErrorAlert
                message={stepError}
                onRetry={busy === null ? generate : undefined}
                retryLabel="تلاش مجدد تولید"
              />
            )}
          </section>
        )}

        {/* ------------------------------------------- step 3: compare & decide */}
        {step === 'compare' && (
          <section className="space-y-4" aria-label="مقایسه و تصمیم‌گیری">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <figure className="space-y-1.5">
                {compareRaw && (
                  <img
                    src={compareRaw}
                    alt="تصویر اصلی محصول"
                    className="aspect-square w-full rounded-xl border bg-muted/30 object-cover"
                  />
                )}
                <figcaption className="text-center text-xs text-muted-foreground">
                  تصویر اصلی
                </figcaption>
              </figure>
              <figure className="space-y-1.5">
                {busy === 'generate' ? (
                  <div
                    className="flex aspect-square w-full items-center justify-center rounded-xl border"
                    style={CHECKER_STYLE}
                    role="status"
                    aria-label="در حال تولید مجدد تصویر"
                  >
                    <Loader2 className="size-6 animate-spin text-emerald-600" aria-hidden />
                  </div>
                ) : (
                  job?.finalUrl && (
                    <img
                      src={job.finalUrl}
                      alt="تصویر استودیویی محصول"
                      className="aspect-square w-full rounded-xl border bg-muted/30 object-cover"
                    />
                  )
                )}
                <figcaption className="text-center text-xs font-medium text-emerald-700">
                  تصویر استودیویی
                </figcaption>
              </figure>
            </div>

            {busy === 'generate' && (
              <ProgressStatus
                title="جمنای در حال ساخت تصویر جدید…"
                hint="معمولاً ۱۵ تا ۶۰ ثانیه؛ تا دو دقیقه"
                elapsed={elapsed}
              />
            )}

            {stepError && (
              <StepErrorAlert
                message={stepError}
                onRetry={busy === null ? generate : undefined}
                retryLabel="تلاش مجدد تولید"
              />
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={generate} disabled={disabledByBusy || !canGenerate}>
                <RefreshCcw className="size-3.5" aria-hidden />
                تولید مجدد با همین پس‌زمینه
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStepError(null)
                  setStep('subject')
                }}
                disabled={disabledByBusy}
              >
                تغییر پس‌زمینه یا سبک
              </Button>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                onClick={approve}
                disabled={disabledByBusy || !job?.finalUrl}
                className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {busy === 'approve' && <Loader2 className="size-4 animate-spin" aria-hidden />}
                تأیید و اتصال به محصول
              </Button>
              <Button
                variant="outline"
                onClick={rejectJob}
                disabled={disabledByBusy}
                className="text-destructive hover:bg-rose-50 hover:text-destructive"
              >
                {busy === 'reject' && <Loader2 className="size-4 animate-spin" aria-hidden />}
                رد تصویر
              </Button>
            </div>
          </section>
        )}

        {/* ------------------------------------------------ step 4: approved */}
        {step === 'approved' && (
          <section className="space-y-4" aria-label="تصویر تأییدشده">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-6 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-emerald-100">
                <CheckCircle2 className="size-7 text-emerald-600" aria-hidden />
              </span>
              <div>
                <p className="font-medium text-emerald-900">تصویر استودیویی تأیید شد</p>
                <p className="mt-1 text-sm text-emerald-800/80">
                  تصویر جدید به‌عنوان تصویر اصلی «{productName}» متصل شد و در فروشگاه نمایش داده
                  می‌شود.
                </p>
              </div>
              {approvedResultUrl && (
                <img
                  src={approvedResultUrl}
                  alt="تصویر استودیویی تأییدشده"
                  className="max-h-64 rounded-xl border object-contain"
                />
              )}
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setStepError(null)
                    setJob(null)
                    setBackgroundKey(null)
                    setCustomPrompt('')
                    setCustomBgUrl(null)
                    setStep('source')
                  }}
                  disabled={disabledByBusy}
                >
                  ساخت تصویر دیگر
                </Button>
                <Button onClick={() => onOpenChange(false)}>بستن استودیو</Button>
              </div>
            </div>
          </section>
        )}

        {/* ------------------------------------------------------- history */}
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-between"
              aria-expanded={historyOpen}
            >
              <span className="flex items-center gap-2">
                <History className="size-4 text-muted-foreground" aria-hidden />
                سابقه پردازش
                {jobs.length > 0 && (
                  <Badge variant="secondary" className="tabular-nums-fa">
                    {fmtNumber(jobs.length)}
                  </Badge>
                )}
              </span>
              <ChevronDown
                className={cn('size-4 transition-transform', historyOpen && 'rotate-180')}
                aria-hidden
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {studioLoading ? (
              <div className="mt-2 space-y-2" aria-label="در حال دریافت سابقه پردازش">
                <Skeleton className="h-16 rounded-xl" />
                <Skeleton className="h-16 rounded-xl" />
              </div>
            ) : studioError ? (
              <div className="mt-2">
                <StepErrorAlert
                  message={studioError}
                  onRetry={reloadStudio}
                  retryLabel="دریافت مجدد سابقه"
                />
              </div>
            ) : jobs.length === 0 ? (
              <p className="mt-2 rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
                هنوز پردازشی برای این محصول ثبت نشده است.
              </p>
            ) : (
              <ScrollArea className="mt-2 max-h-72 rounded-xl border">
                <ul className="divide-y">
                  {jobs.map((j) => (
                    <HistoryRow
                      key={j.id}
                      job={j}
                      isCurrent={j.id === job?.id}
                      busy={disabledByBusy}
                      onResume={resumeJob}
                    />
                  ))}
                </ul>
              </ScrollArea>
            )}
          </CollapsibleContent>
        </Collapsible>
      </DialogContent>
    </Dialog>
  )
}
