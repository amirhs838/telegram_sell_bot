'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Loader2, RefreshCcw, type LucideIcon } from 'lucide-react'
import { productStatusFa, orderStatusFa } from '@/lib/telegram-render'
import type { OrderStatus, ProductStatus } from '@/lib/client'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Tone helpers (emerald theme — no blue/indigo)
// ---------------------------------------------------------------------------

export type Tone = 'emerald' | 'amber' | 'rose' | 'violet' | 'teal' | 'slate'

const TONE_CHIP: Record<Tone, string> = {
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  teal: 'bg-teal-50 text-teal-700 border-teal-200',
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
}

const TONE_SOFT: Record<Tone, string> = {
  emerald: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700',
  rose: 'bg-rose-100 text-rose-700',
  violet: 'bg-violet-100 text-violet-700',
  teal: 'bg-teal-100 text-teal-700',
  slate: 'bg-slate-100 text-slate-600',
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

const PRODUCT_STATUS_TONE: Record<ProductStatus, Tone> = {
  draft: 'slate',
  active: 'emerald',
  inactive: 'amber',
  out_of_stock: 'rose',
}

const ORDER_STATUS_TONE: Record<OrderStatus, Tone> = {
  pending: 'amber',
  confirmed: 'emerald',
  processing: 'violet',
  shipped: 'teal',
  completed: 'emerald',
  cancelled: 'rose',
}

export function ProductStatusBadge({ status }: { status: string }) {
  const s = (status || 'draft') as ProductStatus
  return (
    <Badge variant="outline" className={TONE_CHIP[PRODUCT_STATUS_TONE[s] ?? 'slate']}>
      {productStatusFa(s)}
    </Badge>
  )
}

export function OrderStatusBadge({ status }: { status: string }) {
  const s = (status || 'pending') as OrderStatus
  const { label, emoji } = orderStatusFa(s)
  return (
    <Badge variant="outline" className={TONE_CHIP[ORDER_STATUS_TONE[s] ?? 'slate']}>
      <span aria-hidden>{emoji}</span>
      {label}
    </Badge>
  )
}

export function orderStatusLabel(status: string): string {
  return orderStatusFa(status).label
}

// ---------------------------------------------------------------------------
// StatCard
// ---------------------------------------------------------------------------

export function StatCard({
  title,
  value,
  icon: Icon,
  tone = 'emerald',
  loading = false,
  onClick,
}: {
  title: string
  value: string
  icon: LucideIcon
  tone?: Tone
  loading?: boolean
  onClick?: () => void
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'block w-full text-right rounded-xl border bg-card p-4 shadow-sm transition-all',
        onClick &&
          'hover:shadow-md hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring/50 outline-none cursor-pointer',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{title}</p>
          {loading ? (
            <div className="mt-2 h-6 w-16 rounded bg-muted animate-pulse" />
          ) : (
            <p className="mt-1 text-xl md:text-2xl font-bold tabular-nums-fa truncate">{value}</p>
          )}
        </div>
        <span
          className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', TONE_SOFT[tone])}
        >
          <Icon className="size-5" aria-hidden />
        </span>
      </div>
    </Comp>
  )
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-muted">
        <Icon className="size-7 text-muted-foreground" aria-hidden />
      </span>
      <div>
        <p className="font-medium">{title}</p>
        {hint && <p className="mt-1 text-sm text-muted-foreground max-w-sm">{hint}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SectionHeader
// ---------------------------------------------------------------------------

export function SectionHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-lg md:text-xl font-bold">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MoneyText
// ---------------------------------------------------------------------------

export function MoneyText({
  value,
  className,
}: {
  value: number | null | undefined
  className?: string
}) {
  return (
    <span className={cn('tabular-nums-fa font-medium', className)}>
      {new Intl.NumberFormat('fa-IR').format(Math.round(Number(value ?? 0)))} تومان
    </span>
  )
}

// ---------------------------------------------------------------------------
// ConfirmDeleteDialog
// ---------------------------------------------------------------------------

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'حذف',
  loading = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  loading?: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel disabled={loading}>انصراف</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              onConfirm()
            }}
            disabled={loading}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Skeleton table rows
// ---------------------------------------------------------------------------

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className="h-4 animate-pulse rounded bg-muted"
              style={{ width: c === 0 ? '22%' : '14%' }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// useDebounced
// ---------------------------------------------------------------------------

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

// ---------------------------------------------------------------------------
// ErrorRetry (error + retry affordance)
// ---------------------------------------------------------------------------

export function ErrorRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState
      icon={RefreshCcw}
      title="خطا در دریافت اطلاعات"
      hint={message}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCcw className="size-4" aria-hidden />
          تلاش مجدد
        </Button>
      }
    />
  )
}
