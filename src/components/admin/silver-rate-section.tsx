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
} from 'lucide-react'
import { toast } from 'sonner'
import { api, fmtDate, fmtNumber, type SilverRateInfo, type SilverRateRecord } from '@/lib/client'

export function SilverRateSection() {
  const [data, setData] = useState<SilverRateInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [rate, setRate] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

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

  async function submit(e: FormEvent) {
    e.preventDefault()
    const value = Number(rate)
    if (!rate.trim() || !Number.isFinite(value) || value <= 0) {
      toast.error('قیمت هر گرم نقره را به‌صورت عدد بزرگ‌تر از صفر وارد کنید')
      return
    }
    setSubmitting(true)
    try {
      await api('/api/silver-rate', {
        method: 'POST',
        body: JSON.stringify({ ratePerGram: value, note: note.trim() || undefined }),
      })
      toast.success('نرخ جدید ثبت شد')
      setRate('')
      setNote('')
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
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
          {/* Hero + register form */}
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

            {/* Register form */}
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
