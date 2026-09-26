'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  StatCard,
  OrderStatusBadge,
  EmptyState,
  ErrorRetry,
  MoneyText,
} from '@/components/admin/bits'
import type { SectionKey } from '@/components/admin/admin-shell'
import {
  Package,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  ShoppingCart,
  Banknote,
  Users,
  ArrowLeft,
} from 'lucide-react'
import { api, fmtDate, fmtMoney, fmtNumber, type DashboardStats } from '@/lib/client'

// "MM-DD" → "۵/۱۲"
function faDay(dateStr: string): string {
  const [m, d] = dateStr.split('-')
  return `${fmtNumber(Number(d))}/${fmtNumber(Number(m))}`
}

export function DashboardSection({ onNavigate }: { onNavigate: (s: SectionKey) => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<DashboardStats>('/api/dashboard/stats')
      setStats(d)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading) return <DashboardSkeleton />

  if (error || !stats)
    return <ErrorRetry message={error ?? 'داده‌ای دریافت نشد'} onRetry={load} />

  const t = stats.totals
  const weekly = stats.weekly ?? []

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        <StatCard title="محصولات کل" value={fmtNumber(t.products)} icon={Package} tone="slate" onClick={() => onNavigate('products')} />
        <StatCard title="محصولات فعال" value={fmtNumber(t.activeProducts)} icon={CheckCircle2} tone="emerald" onClick={() => onNavigate('products')} />
        <StatCard title="کم‌موجود" value={fmtNumber(t.lowStock)} icon={AlertTriangle} tone="amber" onClick={() => onNavigate('products')} />
        <StatCard title="ناموجود" value={fmtNumber(t.outOfStock)} icon={XCircle} tone="rose" onClick={() => onNavigate('products')} />
        <StatCard title="سفارش در انتظار" value={fmtNumber(t.pendingOrders)} icon={Clock} tone="amber" onClick={() => onNavigate('orders')} />
        <StatCard title="سفارش امروز" value={fmtNumber(t.todayOrders)} icon={ShoppingCart} tone="teal" onClick={() => onNavigate('orders')} />
        <StatCard title="مجموع فروش" value={fmtMoney(t.totalSales)} icon={Banknote} tone="emerald" onClick={() => onNavigate('orders')} />
        <StatCard title="مشتریان" value={fmtNumber(t.customers)} icon={Users} tone="violet" onClick={() => onNavigate('customers')} />
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2 md:gap-6">
        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">فروش ۷ روز اخیر</CardTitle>
          </CardHeader>
          <CardContent>
            {weekly.length === 0 ? (
              <EmptyState icon={Banknote} title="داده فروشی موجود نیست" hint="با ثبت اولین سفارش، نمودار فروش اینجا نمایش داده می‌شود." />
            ) : (
              <div dir="ltr" className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={weekly} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={faDay}
                      fontSize={11}
                      tickLine={false}
                      axisLine={{ stroke: '#e5e7eb' }}
                    />
                    <YAxis
                      tickFormatter={(v: number) => fmtNumber(v)}
                      fontSize={11}
                      width={54}
                      tickLine={false}
                      axisLine={false}
                    />
                    <RTooltip
                      formatter={(value) => [fmtMoney(Number(value)), 'فروش']}
                      contentStyle={{
                        direction: 'rtl',
                        borderRadius: 12,
                        border: '1px solid #e5e7eb',
                        fontSize: 12,
                      }}
                      labelStyle={{ fontWeight: 600 }}
                      cursor={{ stroke: '#a7f3d0', strokeWidth: 1.5 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="sales"
                      name="فروش"
                      stroke="#10b981"
                      strokeWidth={2}
                      fill="url(#salesFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">سفارش‌های ۷ روز اخیر</CardTitle>
          </CardHeader>
          <CardContent>
            {weekly.length === 0 ? (
              <EmptyState icon={ShoppingCart} title="داده سفارشی موجود نیست" hint="با ثبت اولین سفارش، نمودار سفارش‌ها اینجا نمایش داده می‌شود." />
            ) : (
              <div dir="ltr" className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weekly} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={faDay}
                      fontSize={11}
                      tickLine={false}
                      axisLine={{ stroke: '#e5e7eb' }}
                    />
                    <YAxis
                      tickFormatter={(v: number) => fmtNumber(v)}
                      fontSize={11}
                      width={54}
                      allowDecimals={false}
                      tickLine={false}
                      axisLine={false}
                    />
                    <RTooltip
                      formatter={(value) => [fmtNumber(Number(value)), 'سفارش']}
                      contentStyle={{
                        direction: 'rtl',
                        borderRadius: 12,
                        border: '1px solid #e5e7eb',
                        fontSize: 12,
                      }}
                      labelStyle={{ fontWeight: 600 }}
                      cursor={{ fill: 'rgba(20, 184, 166, 0.08)' }}
                    />
                    <Bar
                      dataKey="orders"
                      name="سفارش"
                      fill="#14b8a6"
                      radius={[6, 6, 0, 0]}
                      maxBarSize={36}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent orders */}
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">آخرین سفارش‌ها</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => onNavigate('orders')}>
            مشاهده همه
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
        </CardHeader>
        <CardContent>
          {stats.recentOrders?.length ? (
            <ul className="divide-y">
              {stats.recentOrders.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate('orders')}
                    className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-2 py-3 text-right transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 outline-none"
                  >
                    <span dir="ltr" className="font-mono text-sm font-semibold text-emerald-700">
                      #{fmtNumber(o.orderNumber)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{o.customerName}</span>
                    <OrderStatusBadge status={o.status} />
                    <MoneyText value={o.total} className="text-sm" />
                    <span className="text-xs text-muted-foreground">{fmtDate(o.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={ShoppingCart}
              title="هنوز سفارشی ثبت نشده"
              hint="اولین سفارش از طریق ربات تلگرام اینجا نمایش داده می‌شود."
              action={
                <Button size="sm" variant="outline" onClick={() => onNavigate('telegram')}>
                  رفتن به بخش تلگرام
                </Button>
              }
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-xl border p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-14" />
              </div>
              <Skeleton className="size-10 rounded-xl" />
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border p-6">
            <Skeleton className="mb-4 h-5 w-40" />
            <Skeleton className="h-56 w-full" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border p-6">
        <Skeleton className="mb-4 h-5 w-32" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="mb-2 h-10 w-full" />
        ))}
      </div>
    </div>
  )
}
