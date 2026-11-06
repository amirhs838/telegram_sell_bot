'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  SectionHeader,
  EmptyState,
  ErrorRetry,
} from '@/components/admin/bits'
import { ReceiptViewButton } from '@/components/admin/receipt-image'
import {
  Clock,
  CheckCircle2,
  XCircle,
  User,
  Phone,
  Hash,
  MessageSquareText,
  Loader2,
  ChevronRight,
  ChevronLeft,
  ShoppingBag,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  qs,
  fmtDate,
  fmtMoney,
  fmtNumber,
  type PaymentRecord,
} from '@/lib/client'

const PAGE_SIZE = 10

const PAYMENT_TABS = [
  { value: 'awaiting_review', label: 'در انتظار بررسی' },
  { value: 'approved', label: 'تأییدشده' },
  { value: 'rejected', label: 'ردشده' },
] as const

type PaymentStatusFilter = (typeof PAYMENT_TABS)[number]['value']

/** Persian labels for the payment RECORD status (distinct from order paymentStatus). */
const RECORD_STATUS_FA: Record<string, { label: string; badgeClass: string }> = {
  awaiting_review: {
    label: 'در انتظار بررسی',
    badgeClass: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  approved: {
    label: 'تأییدشده',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  rejected: {
    label: 'ردشده',
    badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
  },
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function PaymentsSection() {
  const [tab, setTab] = useState<PaymentStatusFilter>('awaiting_review')
  const [page, setPage] = useState(1)
  const [payments, setPayments] = useState<PaymentRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})

  const [approveTarget, setApproveTarget] = useState<{
    paymentId: string
    orderNumber: number
    amount: number
  } | null>(null)
  const [rejectTarget, setRejectTarget] = useState<{ paymentId: string; orderNumber: number } | null>(null)

  const loadCounts = useCallback(async () => {
    const results = await Promise.allSettled(
      PAYMENT_TABS.map(async (t) => {
        const d = await api<{ payments: PaymentRecord[]; total: number }>(
          `/api/payments${qs({ status: t.value, page: 1, pageSize: 1 })}`,
        )
        return [t.value, d.total ?? 0] as const
      }),
    )
    const next: Record<string, number> = {}
    for (const r of results) {
      if (r.status === 'fulfilled') next[r.value[0]] = r.value[1]
    }
    setCounts(next)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<{ payments: PaymentRecord[]; total: number; page: number; pageSize: number }>(
        `/api/payments${qs({ status: tab, page, pageSize: PAGE_SIZE })}`,
      )
      setPayments(d.payments ?? [])
      setTotal(d.total ?? d.payments?.length ?? 0)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [tab, page])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    loadCounts()
  }, [loadCounts])

  function refreshAll() {
    load()
    loadCounts()
  }

  function afterAction(done: boolean) {
    if (done) refreshAll()
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-4 md:space-y-6">
      <SectionHeader
        title="پرداخت‌ها"
        description="بررسی رسیدهای کارت‌به‌کارت و تأیید یا رد پرداخت سفارش‌ها"
      />

      {/* Tabs with counts */}
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as PaymentStatusFilter)
          setPage(1)
        }}
      >
        <div className="max-w-full overflow-x-auto scroll-thin">
          <TabsList className="h-auto w-max">
            {PAYMENT_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="gap-1.5 whitespace-nowrap">
                {t.label}
                <Badge
                  variant="secondary"
                  className="ms-1 h-5 min-w-5 px-1 text-xs tabular-nums-fa"
                  aria-label={`${fmtNumber(counts[t.value] ?? 0)} مورد`}
                >
                  {fmtNumber(counts[t.value] ?? 0)}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>

      {/* List */}
      {error ? (
        <Card className="rounded-xl shadow-sm">
          <ErrorRetry message={error} onRetry={load} />
        </Card>
      ) : loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-6 w-32" />
              </div>
              <Skeleton className="mt-4 h-4 w-44" />
              <Skeleton className="mt-2 h-4 w-full max-w-md" />
              <Skeleton className="mt-3 h-9 w-56" />
            </Card>
          ))}
        </div>
      ) : payments.length === 0 ? (
        <Card className="rounded-xl shadow-sm">
          <TabEmptyState status={tab} />
        </Card>
      ) : (
        <div className="space-y-3">
          {payments.map((p) => (
            <PaymentCard
              key={p.id}
              payment={p}
              onApprove={() =>
                setApproveTarget({
                  paymentId: p.id,
                  orderNumber: p.order.orderNumber,
                  amount: p.amount,
                })
              }
              onReject={() =>
                setRejectTarget({ paymentId: p.id, orderNumber: p.order.orderNumber })
              }
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && !error && total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            صفحه {fmtNumber(page)} از {fmtNumber(totalPages)} — مجموع {fmtNumber(total)} پرداخت
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              disabled={page >= totalPages}
              onClick={() => setPage((v) => v + 1)}
              aria-label="صفحه بعد"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              disabled={page <= 1}
              onClick={() => setPage((v) => v - 1)}
              aria-label="صفحه قبل"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Approve confirm */}
      <ApprovePaymentDialog
        target={approveTarget}
        onClose={() => setApproveTarget(null)}
        onDone={afterAction}
      />

      {/* Reject with reason */}
      <RejectPaymentDialog
        target={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onDone={afterAction}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Payment card
// ---------------------------------------------------------------------------

function PaymentCard({
  payment: p,
  onApprove,
  onReject,
}: {
  payment: PaymentRecord
  onApprove: () => void
  onReject: () => void
}) {
  const st = RECORD_STATUS_FA[p.status] ?? { label: p.status, badgeClass: '' }
  const items = p.order?.items ?? []
  const awaiting = p.status === 'awaiting_review'

  return (
    <Card className="rounded-xl p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span dir="ltr" className="font-mono text-sm font-semibold text-emerald-700">
              #{fmtNumber(p.order?.orderNumber)}
            </span>
            <Badge variant="outline" className={st.badgeClass}>
              {st.label}
            </Badge>
            <span className="text-xs text-muted-foreground">{fmtDate(p.createdAt)}</span>
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
            <span className="flex items-center gap-1.5">
              <User className="size-3.5 text-muted-foreground" aria-hidden />
              {p.order?.customerName || '—'}
            </span>
            {p.order?.phone && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Phone className="size-3.5" aria-hidden />
                <span dir="ltr">{p.order.phone}</span>
              </span>
            )}
          </p>
        </div>
        <p className="text-lg font-bold tabular-nums-fa md:text-xl">{fmtMoney(p.amount)}</p>
      </div>

      {/* Items summary */}
      {items.length > 0 && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShoppingBag className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="line-clamp-2">
            {items
              .map((it) => `${it.productNameSnapshot} ×${fmtNumber(it.quantity)}`)
              .join('، ')}
          </span>
        </p>
      )}

      {/* Chips */}
      {(p.payerName || p.trackingNumber || p.customerNote) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.payerName && (
            <Badge variant="outline" className="max-w-full gap-1 bg-muted/50 font-normal">
              <User className="size-3 shrink-0" aria-hidden />
              پرداخت‌کننده: {p.payerName}
            </Badge>
          )}
          {p.trackingNumber && (
            <Badge variant="outline" className="max-w-full gap-1 bg-muted/50 font-normal">
              <Hash className="size-3 shrink-0" aria-hidden />
              کد پیگیری: <span dir="ltr">{p.trackingNumber}</span>
            </Badge>
          )}
          {p.customerNote && (
            <Badge variant="outline" className="max-w-full gap-1 bg-muted/50 font-normal">
              <MessageSquareText className="size-3 shrink-0" aria-hidden />
              یادداشت مشتری: {p.customerNote}
            </Badge>
          )}
        </div>
      )}

      {/* Review info for approved/rejected */}
      {!awaiting && (p.reviewNote || p.reviewedByName || p.reviewedAt) && (
        <div className="mt-3 rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
          {p.reviewNote && (
            <p className="mb-1 text-foreground">
              <span className="font-medium">نتیجه بررسی:</span> {p.reviewNote}
            </p>
          )}
          <p>
            بررسی‌کننده: {p.reviewedByName || '—'}
            {p.reviewedAt ? ` — ${fmtDate(p.reviewedAt)}` : ''}
          </p>
        </div>
      )}

      <Separator className="my-3" />

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <ReceiptViewButton url={p.receiptUrl} />
        {awaiting && (
          <>
            <Button
              size="sm"
              onClick={onApprove}
              className="min-h-9 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <CheckCircle2 className="size-4" aria-hidden />
              تأیید پرداخت
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onReject}
              className="min-h-9 border-rose-200 text-rose-700 hover:bg-rose-50"
            >
              <XCircle className="size-4" aria-hidden />
              رد پرداخت
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Empty state per tab
// ---------------------------------------------------------------------------

function TabEmptyState({ status }: { status: PaymentStatusFilter }) {
  if (status === 'awaiting_review') {
    return (
      <EmptyState
        icon={Clock}
        title="پرداختی در انتظار بررسی نیست"
        hint="وقتی مشتری برای سفارشی رسید کارت‌به‌کارت ارسال کند، اینجا برای بررسی نمایش داده می‌شود."
      />
    )
  }
  if (status === 'approved') {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="پرداخت تأییدشده‌ای نیست"
        hint="پرداخت‌هایی که تأیید کرده‌اید اینجا آرشیو می‌شوند."
      />
    )
  }
  return (
    <EmptyState
      icon={XCircle}
      title="پرداخت ردشده‌ای نیست"
      hint="پرداخت‌های ردشده به‌همراه دلیل رد اینجا نمایش داده می‌شوند."
    />
  )
}

// ---------------------------------------------------------------------------
// Shared: approve confirm dialog (also used by OrdersSection)
// ---------------------------------------------------------------------------

export type ApprovePaymentTarget = {
  paymentId: string
  orderNumber: number
  amount: number
}

export function ApprovePaymentDialog({
  target,
  onClose,
  onDone,
}: {
  target: ApprovePaymentTarget | null
  onClose: () => void
  onDone: (done: boolean) => void
}) {
  const [loading, setLoading] = useState(false)

  async function confirm() {
    if (!target) return
    setLoading(true)
    try {
      const res = await api<{ payment: unknown; alreadyApproved?: boolean }>(
        `/api/payments/${target.paymentId}/approve`,
        { method: 'POST' },
      )
      if (res?.alreadyApproved) {
        toast.info('این پرداخت قبلاً تأیید شده بود')
      } else {
        toast.success('پرداخت تأیید شد')
      }
      onDone(true)
    } catch (err) {
      toast.error((err as Error).message)
      onDone(false)
    } finally {
      setLoading(false)
      onClose()
    }
  }

  return (
    <AlertDialog open={Boolean(target)} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>تأیید پرداخت</AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? `آیا از تأیید پرداخت سفارش #${fmtNumber(target.orderNumber)} به مبلغ ${fmtMoney(target.amount)} مطمئن هستید؟`
              : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel disabled={loading}>انصراف</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              confirm()
            }}
            disabled={loading}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
            تأیید پرداخت
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Shared: reject dialog with required reason (also used by OrdersSection)
// ---------------------------------------------------------------------------

export type RejectPaymentTarget = {
  paymentId: string
  orderNumber: number
}

export function RejectPaymentDialog({
  target,
  onClose,
  onDone,
}: {
  target: RejectPaymentTarget | null
  onClose: () => void
  onDone: (done: boolean) => void
}) {
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit() {
    if (!target) return
    if (reason.trim().length < 3) {
      toast.error('دلیل رد پرداخت را وارد کنید (حداقل ۳ کاراکتر)')
      return
    }
    setLoading(true)
    try {
      await api(`/api/payments/${target.paymentId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      })
      toast.success('پرداخت رد شد')
      setReason('')
      onDone(true)
    } catch (err) {
      toast.error((err as Error).message)
      onDone(false)
    } finally {
      setLoading(false)
      onClose()
    }
  }

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(o) => {
        if (!o) {
          setReason('')
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>رد پرداخت</DialogTitle>
          <DialogDescription>
            {target
              ? `دلیل رد رسید سفارش #${fmtNumber(target.orderNumber)} را برای مشتری بنویسید.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reject-reason">دلیل رد *</Label>
          <Textarea
            id="reject-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً: تصویر رسید ناخوانا است — لطفاً تصویر واضح‌تری ارسال کنید"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">این متن برای مشتری نمایش داده می‌شود.</p>
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setReason('')
              onClose()
            }}
            disabled={loading}
          >
            انصراف
          </Button>
          <Button
            onClick={submit}
            disabled={loading}
            className="bg-rose-600 text-white hover:bg-rose-700"
          >
            {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
            رد پرداخت
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
