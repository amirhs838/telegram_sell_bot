'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SectionHeader, ErrorRetry } from '@/components/admin/bits'
import {
  Banknote,
  Loader2,
  Plus,
  Trash2,
  Eye,
  CheckCircle2,
  XCircle,
  CreditCard,
  Clock,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, fmtRel } from '@/lib/client'

// ─── Types ──────────────────────────────────────────────────────────────────

type BankAccount = {
  id: string
  bankName: string
  holderName: string
  cardNumber: string
  sheba: string | null
  accountNumber: string | null
  note: string | null
  active: boolean
}

type PaymentEvent = {
  id: string
  type: string
  actorEmail: string | null
  note: string | null
  createdAt: string
}

type PaymentRow = {
  id: string
  status: string
  amountSnapshot: number
  receiptImage: string | null
  payerName: string | null
  trackingNumber: string | null
  customerNote: string | null
  reviewedByEmail: string | null
  reviewedAt: string | null
  rejectReason: string | null
  createdAt: string
  order: {
    id: string
    orderNumber: number
    status: string
    total: number
    customerName: string
    customer: { id: string; firstName: string; telegramUsername: string | null }
    items: Array<{ productNameSnapshot: string; quantity: number; total: number }>
  }
  events: PaymentEvent[]
}

const fmtMoney = (v: number) => `${Math.round(v).toLocaleString('fa-IR')} تومان`

const PAYMENT_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  awaiting_payment: { label: 'در انتظار پرداخت', cls: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  payment_review: { label: 'در انتظار بررسی', cls: 'bg-amber-200 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300' },
  paid: { label: 'تأیید شده', cls: 'bg-emerald-200 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300' },
  rejected: { label: 'رد شده', cls: 'bg-rose-200 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300' },
  refund_pending: { label: 'بازپرداخت در انتظار', cls: 'bg-sky-200 text-sky-800 dark:bg-sky-900/60 dark:text-sky-300' },
  refunded: { label: 'بازپرداخت شد', cls: 'bg-sky-200 text-sky-800 dark:bg-sky-900/60 dark:text-sky-300' },
}

function StatusBadge({ status }: { status: string }) {
  const meta = PAYMENT_STATUS_LABEL[status] ?? { label: status, cls: '' }
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
}

// ─── Main section ───────────────────────────────────────────────────────────

export function PaymentsSection() {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="پرداخت"
        description="اطلاعات کارت بانکی فروشگاه و بررسی دستی رسیدهای پرداخت مشتریان."
      />
      <BankAccountsCard />
      <ReviewQueueCard />
    </div>
  )
}

// ─── Bank accounts ──────────────────────────────────────────────────────────

const EMPTY_BANK: Omit<BankAccount, 'id'> = {
  bankName: '',
  holderName: '',
  cardNumber: '',
  sheba: null,
  accountNumber: null,
  note: null,
  active: true,
}

function BankAccountsCard() {
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<BankAccount | null>(null)
  const [form, setForm] = useState<Omit<BankAccount, 'id'>>({ ...EMPTY_BANK })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<{ accounts: BankAccount[] }>('/api/bank-accounts')
      setAccounts(d.accounts ?? [])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function openNew() {
    setEditing(null)
    setForm({ ...EMPTY_BANK })
    setDialogOpen(true)
  }

  function openEdit(a: BankAccount) {
    setEditing(a)
    setForm({ ...a })
    setDialogOpen(true)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      if (editing) {
        await api(`/api/bank-accounts/${editing.id}`, { method: 'PATCH', body: JSON.stringify(form) })
        toast.success('اطلاعات کارت ویرایش شد')
      } else {
        await api('/api/bank-accounts', { method: 'POST', body: JSON.stringify(form) })
        toast.success('کارت بانکی ثبت شد')
      }
      setDialogOpen(false)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(a: BankAccount) {
    try {
      await api(`/api/bank-accounts/${a.id}`, { method: 'PATCH', body: JSON.stringify({ active: !a.active }) })
      await load()
      toast.success(a.active ? 'کارت غیرفعال شد' : 'کارت فعال شد')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function remove(a: BankAccount) {
    try {
      await api(`/api/bank-accounts/${a.id}`, { method: 'DELETE' })
      await load()
      toast.success('حذف شد')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-10 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" aria-hidden />
        </CardContent>
      </Card>
    )
  }
  if (error) return <ErrorRetry message={error} onRetry={load} />

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="size-4 text-muted-foreground" aria-hidden />
          اطلاعات کارت بانکی فروشگاه
        </CardTitle>
        <Button size="sm" onClick={openNew} className="bg-emerald-600 text-white hover:bg-emerald-700">
          <Plus className="size-4" aria-hidden /> افزودن کارت
        </Button>
      </CardHeader>
      <CardContent>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            هنوز کارتی ثبت نشده — مشتری بدون اطلاعات کارت نمی‌تواند پرداخت را انجام دهد.
          </p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Banknote className="size-4 text-muted-foreground" aria-hidden />
                    {a.bankName}
                    {a.active ? (
                      <Badge className="bg-emerald-600 text-white">فعال</Badge>
                    ) : (
                      <Badge variant="secondary">غیرفعال</Badge>
                    )}
                  </p>
                  <p className="mt-0.5 text-sm" dir="ltr">{a.cardNumber}</p>
                  <p className="text-xs text-muted-foreground">به نام {a.holderName}</p>
                  {a.note && <p className="text-xs text-muted-foreground">{a.note}</p>}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => openEdit(a)}>ویرایش</Button>
                  <Button size="sm" variant="outline" onClick={() => toggleActive(a)}>
                    {a.active ? 'غیرفعال' : 'فعال'}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-rose-500" aria-label={`حذف کارت ${a.bankName}`} onClick={() => remove(a)}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'ویرایش کارت بانکی' : 'افزودن کارت بانکی'}</DialogTitle>
            <DialogDescription>این اطلاعات در ربات به مشتری نمایش داده می‌شود.</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ba-bank">نام بانک *</Label>
                <Input id="ba-bank" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ba-holder">نام صاحب حساب *</Label>
                <Input id="ba-holder" value={form.holderName} onChange={(e) => setForm({ ...form, holderName: e.target.value })} required />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ba-card">شماره کارت *</Label>
              <Input id="ba-card" dir="ltr" className="text-left" value={form.cardNumber} onChange={(e) => setForm({ ...form, cardNumber: e.target.value })} placeholder="6104-3372-XXXX-XXXX" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ba-sheba">شماره شبا (اختیاری)</Label>
              <Input id="ba-sheba" dir="ltr" className="text-left" value={form.sheba ?? ''} onChange={(e) => setForm({ ...form, sheba: e.target.value || null })} placeholder="IR1200000000000000000000" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ba-note">توضیحات پرداخت</Label>
              <Textarea id="ba-note" rows={2} value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value || null })} placeholder="مثلاً: واریز فقط به کارت فعال" />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>انصراف</Button>
              <Button type="submit" disabled={saving} className="bg-emerald-600 text-white hover:bg-emerald-700">
                {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
                ذخیره
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ─── Review queue ───────────────────────────────────────────────────────────

const FILTERS = [
  { value: 'payment_review', label: 'در انتظار بررسی' },
  { value: 'awaiting_payment', label: 'در انتظار پرداخت' },
  { value: 'paid', label: 'تأیید شده' },
  { value: 'rejected', label: 'رد شده' },
] as const

function ReviewQueueCard() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('payment_review')
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [stats, setStats] = useState<{ reviewCount: number; paidCount: number; awaitingCount: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<PaymentRow | null>(null)
  const [rejecting, setRejecting] = useState<PaymentRow | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [confirmApproving, setConfirmApproving] = useState<PaymentRow | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<{ payments: PaymentRow[]; stats: { reviewCount: number; paidCount: number; awaitingCount: number } }>(
        `/api/payments?status=${filter}`,
      )
      setPayments(d.payments ?? [])
      setStats(d.stats)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  async function approve(p: PaymentRow) {
    setBusy(true)
    try {
      const d = await api<{ ok: boolean; alreadyDone?: boolean }>(`/api/payments/${p.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      })
      toast.success(d.alreadyDone ? 'این پرداخت قبلاً تأیید شده بود' : `پرداخت سفارش #${p.order.orderNumber} تأیید شد`)
      setConfirmApproving(null)
      setViewing(null)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function reject(p: PaymentRow) {
    if (rejectReason.trim().length < 3) {
      toast.error('دلیل رد الزامی است (حداقل ۳ کاراکتر)')
      return
    }
    setBusy(true)
    try {
      await api(`/api/payments/${p.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action: 'reject', reason: rejectReason.trim() }),
      })
      toast.success(`پرداخت سفارش #${p.order.orderNumber} رد شد`)
      setRejecting(null)
      setRejectReason('')
      setViewing(null)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="size-4 text-muted-foreground" aria-hidden />
          بررسی پرداخت‌ها
          {stats && (
            <span className="text-xs font-normal text-muted-foreground">
              ({stats.reviewCount} در انتظار، {stats.paidCount} تأیید، {stats.awaitingCount} بدون رسید)
            </span>
          )}
        </CardTitle>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? 'default' : 'outline'}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" aria-hidden />
          </div>
        ) : error ? (
          <ErrorRetry message={error} onRetry={load} />
        ) : payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">موردی در این وضعیت نیست.</p>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto">
            <ul className="space-y-2">
              {payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      سفارش #{p.order.orderNumber} — <StatusBadge status={p.status} />
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {p.order.customerName} — {fmtMoney(p.amountSnapshot)} — {fmtRel(p.updatedAt)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.order.items.map((i) => `${i.productNameSnapshot} × ${i.quantity}`).join('، ')}
                    </p>
                    {p.status === 'rejected' && p.rejectReason && (
                      <p className="text-xs text-rose-500">دلیل رد: {p.rejectReason}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => setViewing(p)} disabled={!p.receiptImage}>
                      <Eye className="size-4" aria-hidden /> رسید
                    </Button>
                    {p.status === 'payment_review' && (
                      <>
                        <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => setConfirmApproving(p)}>
                          <CheckCircle2 className="size-4" aria-hidden /> تأیید
                        </Button>
                        <Button size="sm" variant="outline" className="text-rose-500" onClick={() => { setRejecting(p); setRejectReason('') }}>
                          <XCircle className="size-4" aria-hidden /> رد
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>

      {/* Receipt viewer */}
      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle>رسید پرداخت — سفارش #{viewing.order.orderNumber}</DialogTitle>
                <DialogDescription>
                  مبلغ: {fmtMoney(viewing.amountSnapshot)} — {viewing.payerName ?? 'نام پرداخت‌کننده ثبت نشده'}
                  {viewing.trackingNumber ? ` — پیگیری: ${viewing.trackingNumber}` : ''}
                </DialogDescription>
              </DialogHeader>
              {viewing.receiptImage ? (
                <img
                  src={`/api/payments/receipts/${viewing.receiptImage}`}
                  alt={`تصویر رسید پرداخت سفارش ${viewing.order.orderNumber}`}
                  className="max-h-[50vh] w-full rounded-lg border object-contain"
                />
              ) : (
                <p className="text-sm text-muted-foreground">تصویری ثبت نشده است.</p>
              )}
              {viewing.events.length > 0 && (
                <div className="rounded-lg border p-2 text-xs text-muted-foreground">
                  <p className="mb-1 font-medium text-foreground">تاریخچه بررسی:</p>
                  <ul className="space-y-0.5">
                    {viewing.events.map((e) => (
                      <li key={e.id}>
                        • {e.type} {e.actorEmail ? `— ${e.actorEmail}` : ''} — {fmtRel(e.createdAt)}
                        {e.note ? ` — ${e.note}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {viewing.status === 'payment_review' && (
                <DialogFooter className="gap-2">
                  <Button variant="outline" className="text-rose-500" onClick={() => { setRejecting(viewing); setRejectReason('') }}>
                    رد پرداخت
                  </Button>
                  <Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => setConfirmApproving(viewing)}>
                    تأیید پرداخت
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Approve confirmation (prevents accidental clicks) */}
      <Dialog open={confirmApproving !== null} onOpenChange={(o) => !o && setConfirmApproving(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>تأیید نهایی پرداخت</DialogTitle>
            <DialogDescription>
              {confirmApproving && (
                <>
                  مبلغ {fmtMoney(confirmApproving.amountSnapshot)} برای سفارش #{confirmApproving.order.orderNumber} تأیید شود؟
                  <br />
                  وضعیت سفارش به «تأیید شده» تغییر می‌کند. موجودی قبلاً رزرو شده و دوباره کسر نمی‌شود.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmApproving(null)} disabled={busy}>انصراف</Button>
            <Button
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={busy}
              onClick={() => confirmApproving && approve(confirmApproving)}
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              بله، تأیید می‌کنم
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject with mandatory reason */}
      <Dialog open={rejecting !== null} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>رد پرداخت</DialogTitle>
            <DialogDescription>
              {rejecting && <>دلیل رد رسید سفارش #{rejecting.order.orderNumber} را بنویسید — برای مشتری ارسال می‌شود.</>}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="مثلاً: مبلغ رسید با مبلغ سفارش مطابقت ندارد"
          />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRejecting(null)} disabled={busy}>انصراف</Button>
            <Button variant="destructive" disabled={busy || rejectReason.trim().length < 3} onClick={() => rejecting && reject(rejecting)}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              ثبت و اطلاع‌رسانی
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
