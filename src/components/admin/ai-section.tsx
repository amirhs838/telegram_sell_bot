'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { AiSuggestionList } from '@/components/admin/ai-suggestion'
import { SectionHeader, ErrorRetry } from '@/components/admin/bits'
import {
  Sparkles,
  Loader2,
  Database,
  Wrench,
  RefreshCw,
  Info,
  Terminal,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, fmtNumber, type AiSuggestion } from '@/lib/client'

// ---------------------------------------------------------------------------
// Tool registry (static descriptions — mirrors backend JSON tool protocol)
// ---------------------------------------------------------------------------

const TOOLS: { name: string; description: string }[] = [
  { name: 'search_products', description: 'جستجوی محصولات بر اساس نام و دسته‌بندی (برای مشتریان در ربات)' },
  { name: 'get_product', description: 'دریافت اطلاعات کامل یک محصول بر اساس نام یا شناسه' },
  { name: 'check_stock', description: 'بررسی موجودی لحظه‌ای محصول — همیشه از پایگاه داده' },
  { name: 'get_categories', description: 'فهرست دسته‌بندی‌های فروشگاه به‌همراه تعداد محصولات' },
  { name: 'get_customer_orders', description: 'مشاهده سفارش‌های اخیر یک مشتری تلگرامی' },
]

export function AiSection() {
  return (
    <div className="space-y-4 md:space-y-6">
      <SectionHeader
        title="ابزارهای هوش مصنوعی"
        description="تولید محتوا، پایگاه دانش برداری و ابزارهای دستیار ربات"
      />
      <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
        <ContentGenerator />
        <KnowledgeBase />
        <ToolsCard />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1) Content generator
// ---------------------------------------------------------------------------

function ContentGenerator() {
  const [roughInfo, setRoughInfo] = useState('')
  const [generating, setGenerating] = useState(false)
  const [suggestion, setSuggestion] = useState<AiSuggestion | null>(null)

  async function generate() {
    if (roughInfo.trim().length < 10) {
      toast.error('اطلاعات خام را بیشتر توضیح دهید (حداقل ۱۰ کاراکتر)')
      return
    }
    setGenerating(true)
    try {
      const d = await api<{ suggestion: AiSuggestion }>('/api/ai/generate-content', {
        method: 'POST',
        body: JSON.stringify({ roughInfo: roughInfo.trim() }),
      })
      setSuggestion(d.suggestion)
      toast.success('محتوا تولید شد — با دکمه کپی بردارید')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Card className="rounded-xl shadow-sm lg:row-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-emerald-600" aria-hidden />
          تولید محتوای محصول
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          rows={5}
          value={roughInfo}
          onChange={(e) => setRoughInfo(e.target.value)}
          placeholder="اطلاعات خام محصول… مثلاً: ساعت هوشمند، صفحه ۱.۸ اینچی، پایش ضربان قلب، باتری ۷ روز، مقاوم به آب، مناسب هدیه"
          aria-label="اطلاعات خام محصول"
        />
        <Button onClick={generate} disabled={generating}>
          {generating ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-4" aria-hidden />
          )}
          {generating ? 'در حال تولید…' : 'تولید محتوای محصول'}
        </Button>
        <p className="text-xs text-muted-foreground">
          خروجی شامل نام، توضیح کوتاه و کامل، پیشنهاد دسته‌بندی، برچسب‌ها و کپشن تلگرام است. قیمت و
          موجودی تولید نمی‌شود.
        </p>
        {suggestion && <AiSuggestionList suggestion={suggestion} />}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 2) Knowledge base (RAG)
// ---------------------------------------------------------------------------

type EmbeddingStatus = { total: number; products: number; model: string }

function KnowledgeBase() {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<EmbeddingStatus>('/api/ai/embeddings/status')
      setStatus(d)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function rebuild() {
    setRebuilding(true)
    try {
      const d = await api<{ count: number }>('/api/ai/embeddings/rebuild', { method: 'POST' })
      toast.success(`${fmtNumber(d.count)} بردار بازسازی شد`)
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setRebuilding(false)
    }
  }

  const percent =
    status && status.products > 0 ? Math.min(100, Math.round((status.total / status.products) * 100)) : 0

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="size-4 text-emerald-600" aria-hidden />
          پایگاه دانش (RAG)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorRetry message={error} onRetry={load} />
        ) : loading || !status ? (
          <div className="space-y-3">
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="h-2 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">محصولات برداری‌شده:</span>
              <span className="font-medium tabular-nums-fa">
                {fmtNumber(status.total)} از {fmtNumber(status.products)}
              </span>
            </div>
            <Progress value={percent} aria-label={`پیشرفت برداری‌سازی ${percent} درصد`} />
            <p className="text-xs text-muted-foreground">
              مدل: <code dir="ltr" className="rounded bg-muted px-1 py-0.5 font-mono">{status.model || '—'}</code>
            </p>
            <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <p>
                بردارها فقط برای جستجوی معنایی دستیار استفاده می‌شوند؛ قیمت و موجودی همیشه مستقیماً
                از پایگاه داده خوانده می‌شود.
              </p>
            </div>
            <Button variant="outline" onClick={rebuild} disabled={rebuilding}>
              {rebuilding ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="size-4" aria-hidden />
              )}
              {rebuilding ? 'در حال بازسازی…' : 'بازسازی بردارها'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 3) Assistant tools
// ---------------------------------------------------------------------------

function ToolsCard() {
  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wrench className="size-4 text-emerald-600" aria-hidden />
          ابزارهای دستیار
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2.5">
          {TOOLS.map((t) => (
            <li key={t.name} className="flex items-start gap-2.5 rounded-lg border p-2.5">
              <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <code dir="ltr" className="text-start block font-mono text-xs font-semibold text-emerald-700">
                  {t.name}
                </code>
                <p className="mt-0.5 text-sm text-muted-foreground">{t.description}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          دستیار در ربات با حلقه پروتکل JSON این ابزارها را صدا می‌زند (حداکثر ۴ تکرار) و پاسخ
          نهایی را به مشتری می‌فرستد.
        </p>
      </CardContent>
    </Card>
  )
}
