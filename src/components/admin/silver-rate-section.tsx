'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  SectionHeader,
  EmptyState,
  ErrorRetry,
} from '@/components/admin/bits'
import {
  CircleDollarSign,
  Info,
  Loader2,
  RefreshCcw,
  History,
  Send,
  CheckCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, fmtDate, fmtDay, fmtNumber, type SilverRateInfo, type SilverRateRecord } from '@/lib/client'

// ---------------------------------------------------------------------------
// Persian time formatter (fa-IR, short) — used in the Telegram post preview
// ---------------------------------------------------------------------------

const fmtTimeFa = (d: string | Date): string =>
  new Intl.DateTimeFormat('fa-IR', { timeStyle: 'short' }).format(new Date(d))

/** Minimal shape the channel-post preview needs (record values or typed draft). */
type PreviewRate = {
  ratePerGram: number
  unit: string
  note: string | null
  createdAt: string | Date
}

export function SilverRateSection() {
  const [data, setData] = useState<SilverRateInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [rate, setRate] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [retryingId, setRetryingId] = useState<string | null>(null)

  // toggle confirmation: the record + next active state
  const [toggleTarget, setToggleTarget] = useState<{ record: SilverRateRecord; next: boolean } | null>(null)
  const [toggling, setToggling] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<SilverRateInfo>('/api/silver-rate')
      setData(d)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** Replaces a single record in local state (current + history) without a reload. */
  const patchRecord = useCallback((updated: SilverRateRecord) => {
    setData((prev) => {
      if (!prev) return prev
      const apply = (r: SilverRateRecord) => (r.id === updated.id ? updated : r)
      return {
        current: prev.current ? apply(prev.current) : null,
        history: prev.history.map(apply),
      }
    })
  }, [])

  /** Marks a record as failed locally (used when the retry call itself errors). */
  const markFailed = useCallback((id: string, message: string) => {
    setData((prev) => {
      if (!prev) return prev
      const apply = (r: SilverRateRecord) =>
        r.id === id ? { ...r, publishStatus: 'failed', publishError: message } : r
      return {
        current: prev.current ? apply(prev.current) : null,
        history: prev.history.map(apply),
      }
    })
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const value = Number(rate)
    if (!rate.trim() || !Number.isFinite(value) || value <= 0) {
      toast.error('قیمت هر گرم نقره را به‌صورت عدد بزرگ‌تر از صفر وارد کنید')
      return
    }
    setSubmitting(true)
    try {
      // Saving also auto-publishes to the Telegram channel server-side.
      const { rate: saved } = await api<{ rate: SilverRateRecord }>('/api/silver-rate', {
        method: 'POST',
        body: JSON.stringify({ ratePerGram: value, note: note.trim() || undefined }),
      })
      patchRecord(saved)
      if (saved.publishStatus === 'published') {
        toast.success('نرخ ذخیره و در کانال منتشر شد ✅')
      } else if (saved.publishStatus === 'failed') {
        toast.warning('نرخ ذخیره شد اما انتشار در کانال ناموفق بود — با دکمه تلاش مجدد دوباره امتحان کنید')
      } else {
        toast.info('نرخ ذخیره شد و در انتظار انتشار در کانال قرار گرفت')
      }
      setRate('')
      setNote('')
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function retryPublish(record: SilverRateRecord) {
    setRetryingId(record.id)
    try {
      const { rate: published } = await api<{ rate: SilverRateRecord }>(
        `/api/silver-rate/${record.id}/publish`,
        { method: 'POST' },
      )
      patchRecord(published)
      toast.success('نرخ در کانال منتشر شد ✅')
    } catch (err) {
      const message = (err as Error).message
      // keep the row truthful without a full reload
      markFailed(record.id, message)
      toast.error(message)
    } finally {
      setRetryingId(null)
    }
  }

  async function confirmToggle() {
    if (!toggleTarget) return
    setToggling(true)
    try {
      await api(`/api/silver-rate/${toggleTarget.record.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: toggleTarget.next }),
      })
      toast.success(
        toggleTarget.next ? 'نرخ فعال شد' : 'نرخ غیرفعال شد',
      )
      setToggleTarget(null)
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setToggling(false)
    }
  }

  const current = data?.current ?? null
  const history = data?.history ?? []

  // Live preview source: the typed value while composing, otherwise the current record.
  const parsedRate = Number(rate)
  const composing = rate.trim() !== '' && Number.isFinite(parsedRate) && parsedRate > 0
  const previewRate: PreviewRate | null = composing
    ? {
        ratePerGram: parsedRate,
        unit: current?.unit || 'تومان / گرم',
        note: note.trim() || null,
        createdAt: new Date(),
      }
    : current
      ? {
          ratePerGram: current.ratePerGram,
          unit: current.unit || 'تومان / گرم',
          note: current.note,
          createdAt: current.createdAt,
        }
      : null

  return (
    <div className="space-y-4 md:space-y-6">
      <SectionHeader
        title="نرخ نقره"
        description="ثبت و مدیریت نرخ مرجع هر گرم نقره (بدون تأثیر بر قیمت محصولات)"
      >
        <Button variant="outline" onClick={load} disabled={loading} aria-label="بازخوانی نرخ‌ها">
          <RefreshCcw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
          بازخوانی
        </Button>
      </SectionHeader>

      {/* Info banner */}
      <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-800">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p>نرخ نقره صرفاً اطلاعات مرجع است و هیچ‌گاه قیمت محصولات را تغییر نمی‌دهد.</p>
      </div>

      {error ? (
        <Card className="rounded-xl shadow-sm">
          <ErrorRetry message={error} onRetry={load} />
        </Card>
      ) : loading && !data ? (
        <SilverRateSkeleton />
      ) : (
        <>
          {/* Hero + register form + channel-post preview */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Current rate hero */}
            <Card className="rounded-xl border-emerald-100 bg-gradient-to-br from-emerald-50/80 to-card shadow-sm">
              <CardContent className="flex h-full flex-col justify-between gap-4 p-6">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                      <CircleDollarSign className="size-4.5" aria-hidden />
                    </span>
                    نرخ فعلی نقره
                  </p>
                  {current && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <PublishStatusBadge record={current} />
                      <Badge
                        variant="outline"
                        className={
                          current.active
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }
                      >
                        {current.active ? 'فعال' : 'غیرفعال'}
                      </Badge>
                    </div>
                  )}
                </div>

                {current ? (
                  <div>
                    <p className="text-2xl font-bold tabular-nums-fa text-emerald-800 md:text-3xl">
                      {fmtNumber(current.ratePerGram)}{' '}
                      <span className="text-base font-medium text-muted-foreground">
                        {current.unit || 'تومان / گرم'}
                      </span>
                    </p>
                    {current.note && (
                      <p className="mt-2 text-sm text-muted-foreground">{current.note}</p>
                    )}
                    <p className="mt-3 text-xs text-muted-foreground">
                      آخرین ثبت: {fmtDate(current.createdAt)}
                    </p>
                  </div>
                ) : (
                  <EmptyState
                    icon={CircleDollarSign}
                    title="نرخی ثبت نشده است"
                    hint="برای نمایش نرخ مرجع، اولین نرخ را از فرم روبه‌رو ثبت کنید."
                  />
                )}
              </CardContent>
            </Card>

            {/* Register form + Telegram post preview (stacked) */}
            <div className="flex flex-col gap-4">
              <Card className="rounded-xl shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">ثبت نرخ جدید</CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={submit} className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="rate-value">نرخ (تومان) *</Label>
                      <Input
                        id="rate-value"
                        dir="ltr"
                        className="text-left"
                        type="number"
                        min={0}
                        step={100}
                        inputMode="numeric"
                        value={rate}
                        onChange={(e) => setRate(e.target.value)}
                        placeholder="96500"
                        disabled={submitting}
                        required
                      />
                      <p className="text-xs text-muted-foreground">قیمت هر گرم نقره به تومان</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="rate-note">یادداشت (اختیاری)</Label>
                      <Textarea
                        id="rate-note"
                        rows={2}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="مثلاً: نرخ بازار امروز، منبع: انجمن طلا و جواهر"
                        disabled={submitting}
                      />
                    </div>
                    <Button type="submit" disabled={submitting} className="bg-emerald-600 text-white hover:bg-emerald-700">
                      {submitting && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      ثبت نرخ
                    </Button>
                  </form>
                </CardContent>
              </Card>

              <TelegramPostPreview rate={previewRate} composing={composing} />
            </div>
          </div>

          {/* History */}
          <Card className="overflow-hidden rounded-xl shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="size-4 text-emerald-600" aria-hidden />
                تاریخچه نرخ‌ها
              </CardTitle>
            </CardHeader>
            {history.length === 0 ? (
              <EmptyState
                icon={History}
                title="تاریخچه‌ای موجود نیست"
                hint="نرخ‌های ثبت‌شده به‌ترتیب زمانی اینجا نمایش داده می‌شوند."
              />
            ) : (
              <div className="max-h-96 overflow-y-auto scroll-thin">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>تاریخ</TableHead>
                      <TableHead>نرخ</TableHead>
                      <TableHead>یادداشت</TableHead>
                      <TableHead>ثبت‌کننده</TableHead>
                      <TableHead>انتشار در کانال</TableHead>
                      <TableHead>وضعیت</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {fmtDate(r.createdAt)}
                        </TableCell>
                        <TableCell>
                          <span className="tabular-nums-fa font-semibold">
                            {fmtNumber(r.ratePerGram)}
                          </span>{' '}
                          <span className="text-xs text-muted-foreground">{r.unit || 'تومان / گرم'}</span>
                        </TableCell>
                        <TableCell className="max-w-48">
                          {r.note ? (
                            <span className="line-clamp-2 text-sm">{r.note}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {r.createdByName || <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="align-middle">
                          <div className="flex flex-col items-start gap-1.5">
                            <PublishStatusBadge record={r} />
                            {r.publishStatus === 'published' && r.telegramMessageId ? (
                              <span className="text-[11px] text-muted-foreground">
                                پیام #{fmtNumber(r.telegramMessageId)}
                              </span>
                            ) : null}
                            {r.publishStatus === 'failed' && r.publishError ? (
                              <p
                                className="max-w-44 truncate text-[11px] text-rose-600"
                                title={r.publishError}
                              >
                                {r.publishError}
                              </p>
                            ) : null}
                            {(r.publishStatus === 'pending' || r.publishStatus === 'failed') && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1 px-2 text-xs"
                                onClick={() => retryPublish(r)}
                                disabled={retryingId !== null}
                                aria-label={`تلاش مجدد برای انتشار نرخ ${fmtNumber(r.ratePerGram)} در کانال`}
                              >
                                {retryingId === r.id ? (
                                  <Loader2 className="size-3 animate-spin" aria-hidden />
                                ) : (
                                  <RefreshCcw className="size-3" aria-hidden />
                                )}
                                تلاش مجدد
                              </Button>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={
                                r.active
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : 'bg-slate-100 text-slate-600 border-slate-200'
                              }
                            >
                              {r.active ? 'فعال' : 'غیرفعال'}
                            </Badge>
                            <Switch
                              checked={r.active}
                              onCheckedChange={(checked) =>
                                setToggleTarget({ record: r, next: checked })
                              }
                              disabled={toggling}
                              aria-label={`${r.active ? 'غیرفعال کردن' : 'فعال کردن'} نرخ ${fmtNumber(r.ratePerGram)}`}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </>
      )}

      {/* Toggle confirm */}
      <AlertDialog open={Boolean(toggleTarget)} onOpenChange={(o) => !o && setToggleTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {toggleTarget?.next ? 'فعال‌سازی نرخ' : 'غیرفعال‌سازی نرخ'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {toggleTarget?.next
                ? 'این نرخ به‌عنوان نرخ مرجع فعال نمایش داده می‌شود. مطمئن هستید؟'
                : 'این نرخ از نمایش مرجع خارج می‌شود. مطمئن هستید؟'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={toggling}>انصراف</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                confirmToggle()
              }}
              disabled={toggling}
              className={
                toggleTarget?.next
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-destructive text-white hover:bg-destructive/90'
              }
            >
              {toggling && <Loader2 className="size-4 animate-spin" aria-hidden />}
              تأیید
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Publish status badge (pending / published / failed)
// ---------------------------------------------------------------------------

function PublishStatusBadge({ record }: { record: SilverRateRecord }) {
  if (record.publishStatus === 'published') {
    return (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
        <span aria-hidden>✅</span>
        منتشر شده
      </Badge>
    )
  }
  if (record.publishStatus === 'failed') {
    return (
      <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
        <span aria-hidden>❌</span>
        خطا در انتشار
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
      <span aria-hidden>⏳</span>
      در انتظار انتشار
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// Telegram channel-post preview (phone-like, mirrors the server post template)
// ---------------------------------------------------------------------------

function TelegramPostPreview({ rate, composing }: { rate: PreviewRate | null; composing: boolean }) {
  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Send className="size-4 text-emerald-600" aria-hidden />
          پیش‌نمایش پست کانال
          {composing ? (
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
              مقدار جدید (پیش‌نویس)
            </Badge>
          ) : rate ? (
            <Badge variant="outline" className="bg-slate-100 text-slate-600 border-slate-200">
              نرخ فعلی
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* phone-like frame */}
        <div className="mx-auto w-full max-w-xs overflow-hidden rounded-2xl border bg-card shadow-sm" dir="rtl">
          {/* Telegram channel header */}
          <div className="flex items-center gap-2 bg-[#517da2] px-3 py-2.5 text-white">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/20 text-base"
              aria-hidden
            >
              💎
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight">SILVER LOVE</p>
              <p className="text-[10px] leading-tight opacity-80">کانال تلگرام</p>
            </div>
          </div>

          {/* chat area */}
          <div className="min-h-44 bg-[#dce6ee] p-3">
            {rate ? (
              <div className="flex justify-start">
                <div className="w-fit max-w-full rounded-2xl rounded-ss-sm bg-white px-3 py-2 shadow-sm">
                  <p className="text-[11px] font-semibold text-[#517da2]">SILVER LOVE</p>
                  <div className="mt-1 text-xs leading-5 text-slate-800">
                    <p className="whitespace-pre-wrap">{'✨ SILVER LOVE\n📊 نرخ روز نقره'}</p>
                    <p className="mt-2 whitespace-pre-wrap text-slate-400">{'━━━━━━━━━━━━━━'}</p>
                    <p className="mt-1">💎 قیمت هر گرم نقره</p>
                    <p className="mt-0.5 text-sm font-bold tabular-nums-fa text-slate-900">
                      {fmtNumber(rate.ratePerGram)} تومان
                    </p>
                    <p className="mt-0.5">واحد: {rate.unit}</p>
                    <p className="mt-0.5">📅 تاریخ: {fmtDay(rate.createdAt)}</p>
                    <p className="mt-0.5">🕒 ساعت: {fmtTimeFa(rate.createdAt)}</p>
                    <p className="mt-1 whitespace-pre-wrap text-slate-400">{'━━━━━━━━━━━━━━'}</p>
                    <p className="mt-1">
                      این نرخ براساس اطلاعات ثبت‌شده توسط فروشگاه Silver Love منتشر شده است.
                    </p>
                    <p>برای مشاهده محصولات و دریافت مشاوره از ربات فروشگاه استفاده کنید.</p>
                    {rate.note && <em className="mt-1 block">📝 {rate.note}</em>}
                  </div>
                  <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-400">
                    <span>{fmtTimeFa(rate.createdAt)}</span>
                    <CheckCheck className="size-3.5 text-[#4fae4e]" aria-hidden />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-44 items-center justify-center">
                <p className="max-w-[240px] rounded-xl bg-white/90 px-3 py-2 text-center text-xs text-slate-500">
                  نرخی ثبت نشده است — پس از ثبت یا تایپ نرخ، پیش‌نمایش پست اینجا نمایش داده می‌شود.
                </p>
              </div>
            )}
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          این پست پس از ذخیره نرخ، به‌صورت خودکار در کانال تلگرام منتشر می‌شود.
        </p>
      </CardContent>
    </Card>
  )
}

function SilverRateSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border p-6">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-4 h-9 w-52" />
          <Skeleton className="mt-3 h-3 w-36" />
        </div>
        <div className="rounded-xl border p-6">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="mt-4 h-9 w-full" />
          <Skeleton className="mt-3 h-16 w-full" />
          <Skeleton className="mt-3 h-9 w-24" />
        </div>
      </div>
      {/* channel-post preview skeleton */}
      <div className="rounded-xl border p-6">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="mx-auto mt-4 h-56 w-full max-w-xs rounded-2xl" />
        <Skeleton className="mx-auto mt-3 h-3 w-72" />
      </div>
      <div className="rounded-xl border p-6">
        <Skeleton className="h-5 w-32" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}
