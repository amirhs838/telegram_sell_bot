'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  SectionHeader,
  OrderStatusBadge,
  MoneyText,
  EmptyState,
  ErrorRetry,
  TableSkeleton,
  useDebounced,
} from '@/components/admin/bits'
import { Search, Eye, Users, Phone, MapPin, AtSign, Bot } from 'lucide-react'
import { toast } from 'sonner'
import { api, qs, fmtDate, fmtNumber, type Customer, type Order } from '@/lib/client'

export function CustomersSection() {
  const [searchInput, setSearchInput] = useState('')
  const search = useDebounced(searchInput, 300)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [viewingId, setViewingId] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState<{ customer: Customer; orders: Order[] } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<{ items: Customer[]; total: number }>(
        `/api/customers${qs({ search })}`,
      )
      setCustomers(d.items ?? [])
      setTotal(d.total ?? d.items?.length ?? 0)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    load()
  }, [load])

  async function openDetail(id: string) {
    setViewingId(id)
    setDetail(null)
    setDetailLoading(true)
    try {
      const d = await api<{ customer: Customer; orders: Order[] }>(`/api/customers/${id}`)
      setDetail(d)
    } catch (err) {
      toast.error((err as Error).message)
      setViewingId(null)
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="مشتریان"
        description="مشتریانی که از طریق ربات تلگرام خرید کرده‌اند"
      />

      <div className="relative md:max-w-xs">
        <Search className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="جستجوی نام یا آیدی تلگرام…"
          className="ps-8"
          aria-label="جستجوی مشتری"
        />
      </div>

      <Card className="overflow-hidden rounded-xl shadow-sm">
        {error ? (
          <ErrorRetry message={error} onRetry={load} />
        ) : loading ? (
          <TableSkeleton rows={5} cols={5} />
        ) : customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title="مشتری‌ای یافت نشد"
            hint={
              search
                ? 'عبارت جستجو را تغییر دهید.'
                : 'با اولین خرید از طریق ربات، مشتریان اینجا نمایش داده می‌شوند.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>مشتری</TableHead>
                  <TableHead>تلفن</TableHead>
                  <TableHead>تعداد سفارش</TableHead>
                  <TableHead>مجموع خرید</TableHead>
                  <TableHead>آخرین سفارش</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">
                          {(c.firstName || '؟').trim().charAt(0)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {c.firstName} {c.lastName ?? ''}
                          </p>
                          {c.telegramUsername ? (
                            <p dir="ltr" className="text-start text-xs text-muted-foreground">
                              @{c.telegramUsername}
                            </p>
                          ) : (
                            <p dir="ltr" className="text-start text-xs text-muted-foreground">
                              ID: {c.telegramUserId}
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell dir="ltr" className="text-start text-sm">
                      {c.phone || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="tabular-nums-fa">{fmtNumber(c.totalOrders)}</TableCell>
                    <TableCell>
                      <MoneyText value={c.totalSpent} className="text-sm" />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {c.lastOrderAt ? fmtDate(c.lastOrderAt) : '—'}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openDetail(c.id)}
                        aria-label={`مشاهده پروفایل ${c.firstName}`}
                      >
                        <Eye className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {!loading && !error && total > 0 && (
        <p className="text-sm text-muted-foreground">مجموع {fmtNumber(total)} مشتری</p>
      )}

      {/* Customer detail dialog */}
      <Dialog open={Boolean(viewingId)} onOpenChange={(o) => !o && setViewingId(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          {detailLoading || !detail ? (
            <div className="flex items-center justify-center py-12">
              <Loader />
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {detail.customer.firstName} {detail.customer.lastName ?? ''}
                </DialogTitle>
                <DialogDescription>
                  عضویت از {fmtDate(detail.customer.createdAt)}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-2 rounded-xl border p-4 text-sm sm:grid-cols-2">
                  {detail.customer.telegramUsername ? (
                    <p dir="ltr" className="flex items-center gap-2 text-start">
                      <AtSign className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {detail.customer.telegramUsername}
                    </p>
                  ) : (
                    <p dir="ltr" className="flex items-center gap-2 text-start">
                      <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {detail.customer.telegramUserId}
                    </p>
                  )}
                  <p className="flex items-center gap-2">
                    <Phone className="size-4 text-muted-foreground" aria-hidden />
                    <span dir="ltr">{detail.customer.phone || '—'}</span>
                  </p>
                  <p className="flex items-start gap-2 sm:col-span-2">
                    <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span>{detail.customer.address || '—'}</span>
                  </p>
                  <div className="flex gap-6 sm:col-span-2">
                    <p className="text-muted-foreground">
                      سفارش‌ها: <span className="font-medium text-foreground">{fmtNumber(detail.customer.totalOrders)}</span>
                    </p>
                    <p className="text-muted-foreground">
                      مجموع خرید: <MoneyText value={detail.customer.totalSpent} />
                    </p>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-sm font-semibold">سفارش‌های اخیر</p>
                  {detail.orders?.length ? (
                    <ul className="max-h-96 divide-y overflow-y-auto scroll-thin rounded-xl border">
                      {detail.orders.map((o) => (
                        <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                          <span dir="ltr" className="font-mono text-sm font-semibold text-emerald-700">
                            #{fmtNumber(o.orderNumber)}
                          </span>
                          <OrderStatusBadge status={o.status} />
                          <MoneyText value={o.total} className="text-sm" />
                          <span className="ms-auto text-xs text-muted-foreground">{fmtDate(o.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-xl border p-4 text-sm text-muted-foreground">سفارشی ثبت نشده.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Loader() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
      <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-emerald-600" />
      در حال دریافت اطلاعات…
    </div>
  )
}

