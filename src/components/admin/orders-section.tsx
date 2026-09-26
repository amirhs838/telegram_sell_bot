'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Separator } from '@/components/ui/separator'
import {
  SectionHeader,
  OrderStatusBadge,
  MoneyText,
  EmptyState,
  ErrorRetry,
  TableSkeleton,
  useDebounced,
  orderStatusLabel,
} from '@/components/admin/bits'
import {
  Search,
  Eye,
  ShoppingCart,
  Loader2,
  MapPin,
  Phone,
  User,
  AtSign,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, qs, fmtDate, fmtNumber, type Order, type OrderStatus } from '@/lib/client'

const TABS: { value: string; label: string }[] = [
  { value: 'all', label: 'همه' },
  { value: 'pending', label: 'در انتظار' },
  { value: 'confirmed', label: 'تأیید شده' },
  { value: 'processing', label: 'در حال پردازش' },
  { value: 'shipped', label: 'ارسال شده' },
  { value: 'completed', label: 'تکمیل' },
  { value: 'cancelled', label: 'لغو شده' },
]

const ALL_STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'completed',
  'cancelled',
]

export function OrdersSection() {
  const [status, setStatus] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const search = useDebounced(searchInput, 300)
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [viewing, setViewing] = useState<Order | null>(null)
  const [patchingId, setPatchingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<{ items: Order[]; total?: number }>(
        `/api/orders${qs({ status: status === 'all' ? '' : status, search })}`,
      )
      setOrders(d.items ?? [])
      setTotal(d.total ?? d.items?.length ?? 0)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [status, search])

  useEffect(() => {
    load()
  }, [load])

  async function changeStatus(order: Order, next: OrderStatus) {
    setPatchingId(order.id)
    try {
      await api(`/api/orders/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      })
      toast.success('وضعیت به‌روزرسانی شد')
      setViewing((v) => (v && v.id === order.id ? { ...v, status: next } : v))
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setPatchingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="سفارش‌ها"
        description="مدیریت و پیگیری سفارش‌های ثبت‌شده از طریق ربات تلگرام"
      />

      <Tabs
        value={status}
        onValueChange={(v) => setStatus(v)}
      >
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="max-w-full overflow-x-auto scroll-thin">
            <TabsList className="h-auto w-max">
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value} className="whitespace-nowrap">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div className="relative lg:ms-auto lg:w-64">
            <Search className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="جستجوی شماره سفارش یا مشتری…"
              className="ps-8"
              aria-label="جستجوی سفارش"
            />
          </div>
        </div>
      </Tabs>

      <Card className="overflow-hidden rounded-xl shadow-sm">
        {error ? (
          <ErrorRetry message={error} onRetry={load} />
        ) : loading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : orders.length === 0 ? (
          <EmptyState
            icon={ShoppingCart}
            title="سفارشی یافت نشد"
            hint={
              search
                ? 'عبارت جستجو را تغییر دهید.'
                : 'سفارش‌ها از طریق ربات تلگرام ثبت می‌شوند و اینجا نمایش داده می‌شوند.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>شماره</TableHead>
                  <TableHead>مشتری</TableHead>
                  <TableHead>اقلام</TableHead>
                  <TableHead>مبلغ</TableHead>
                  <TableHead>وضعیت</TableHead>
                  <TableHead>تاریخ</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => {
                  const first = o.items?.[0]
                  const rest = (o.items?.length ?? 0) - 1
                  return (
                    <TableRow key={o.id}>
                      <TableCell>
                        <span dir="ltr" className="font-mono text-sm font-semibold text-emerald-700">
                          #{fmtNumber(o.orderNumber)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm font-medium">{o.customerName}</p>
                        {o.customer?.telegramUsername && (
                          <p dir="ltr" className="text-start text-xs text-muted-foreground">
                            @{o.customer.telegramUsername}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {first ? (
                          <p className="max-w-52 truncate text-sm">
                            {first.productNameSnapshot}
                            <span className="text-muted-foreground"> ×{fmtNumber(first.quantity)}</span>
                            {rest > 0 && (
                              <span className="text-xs text-muted-foreground"> +{fmtNumber(rest)} مورد دیگر</span>
                            )}
                          </p>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <MoneyText value={o.total} className="text-sm" />
                      </TableCell>
                      <TableCell>
                        <OrderStatusBadge status={o.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {fmtDate(o.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setViewing(o)}
                          aria-label={`مشاهده سفارش ${o.orderNumber}`}
                        >
                          <Eye className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {!loading && !error && total > 0 && (
        <p className="text-sm text-muted-foreground">مجموع {fmtNumber(total)} سفارش</p>
      )}

      {/* Order detail dialog */}
      <Dialog open={Boolean(viewing)} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <span dir="ltr">#{fmtNumber(viewing.orderNumber)}</span>
                  <OrderStatusBadge status={viewing.status} />
                </DialogTitle>
                <DialogDescription>ثبت شده در {fmtDate(viewing.createdAt)}</DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* Customer */}
                <div className="rounded-xl border p-4">
                  <p className="mb-2 text-sm font-semibold">مشتری</p>
                  <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                    <p className="flex items-center gap-2">
                      <User className="size-4 text-muted-foreground" aria-hidden />
                      {viewing.customerName}
                    </p>
                    {viewing.customer?.telegramUsername ? (
                      <p dir="ltr" className="flex items-center gap-2 text-start">
                        <AtSign className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        {viewing.customer.telegramUsername}
                      </p>
                    ) : (
                      <p className="text-muted-foreground">—</p>
                    )}
                    <p className="flex items-center gap-2">
                      <Phone className="size-4 text-muted-foreground" aria-hidden />
                      <span dir="ltr">{viewing.phone || '—'}</span>
                    </p>
                    <p className="flex items-start gap-2 sm:col-span-2">
                      <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span>{viewing.address || '—'}</span>
                    </p>
                  </div>
                </div>

                {/* Items */}
                <div className="overflow-hidden rounded-xl border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>محصول</TableHead>
                        <TableHead>تعداد</TableHead>
                        <TableHead>قیمت واحد</TableHead>
                        <TableHead>جمع</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(viewing.items ?? []).map((it) => (
                        <TableRow key={it.id}>
                          <TableCell className="text-sm">{it.productNameSnapshot}</TableCell>
                          <TableCell>{fmtNumber(it.quantity)}</TableCell>
                          <TableCell>
                            <MoneyText value={it.unitPriceSnapshot} className="text-sm font-normal" />
                          </TableCell>
                          <TableCell>
                            <MoneyText value={it.total} className="text-sm" />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">جمع اقلام:</span>
                    <MoneyText value={viewing.subtotal} />
                  </div>
                  {viewing.discount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">تخفیف:</span>
                      <MoneyText value={viewing.discount} />
                    </div>
                  )}
                  <Separator />
                  <div className="flex justify-between font-semibold">
                    <span>مبلغ نهایی:</span>
                    <MoneyText value={viewing.total} />
                  </div>
                </div>

                {/* Status changer */}
                <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/30 p-3">
                  <span className="text-sm font-medium">تغییر وضعیت:</span>
                  <Select
                    value={viewing.status}
                    onValueChange={(v) => changeStatus(viewing, v as OrderStatus)}
                    disabled={patchingId === viewing.id}
                  >
                    <SelectTrigger className="w-44" aria-label="تغییر وضعیت سفارش">
                      {patchingId === viewing.id ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          <SelectValue />
                        </span>
                      ) : (
                        <SelectValue />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {ALL_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {orderStatusLabel(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    لغو سفارش موجودی اقلام را برمی‌گرداند
                  </Badge>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
