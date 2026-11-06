'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Loader2, ReceiptText, AlertTriangle } from 'lucide-react'
import { fetchReceiptBlobUrl } from '@/lib/client'
import { cn } from '@/lib/utils'

/**
 * Renders a PRIVATE receipt image. The receipt URL requires authentication,
 * so the image is fetched with the bearer token and displayed via a blob URL.
 * The object URL is always revoked on unmount or URL change — never put the
 * raw receipt URL into <img src>.
 */
export function ReceiptImage({
  url,
  alt = 'تصویر رسید پرداخت',
  className,
}: {
  url: string
  alt?: string
  className?: string
}) {
  const [data, setData] = useState<{ url: string; blobUrl: string | null; error: string | null }>(
    () => ({ url, blobUrl: null, error: null }),
  )

  // Reset derived state when the URL prop changes (React-recommended render-time reset).
  if (data.url !== url) {
    setData({ url, blobUrl: null, error: null })
  }

  useEffect(() => {
    let alive = true
    let created: string | null = null
    fetchReceiptBlobUrl(url)
      .then((u) => {
        if (!alive) {
          URL.revokeObjectURL(u)
          return
        }
        created = u
        setData({ url, blobUrl: u, error: null })
      })
      .catch((err: unknown) => {
        if (!alive) return
        setData({
          url,
          blobUrl: null,
          error: (err as Error)?.message || 'دریافت تصویر رسید ناموفق بود',
        })
      })
    return () => {
      alive = false
      if (created) URL.revokeObjectURL(created)
    }
  }, [url])

  if (data.error) {
    return (
      <div
        role="alert"
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center text-sm text-destructive',
          className,
        )}
      >
        <AlertTriangle className="size-6" aria-hidden />
        <p>{data.error}</p>
      </div>
    )
  }

  if (!data.blobUrl) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-xl border bg-muted/40 p-8',
          className,
        )}
        role="status"
        aria-label="در حال دریافت تصویر رسید"
      >
        <Loader2 className="size-6 animate-spin text-emerald-600" aria-hidden />
      </div>
    )
  }

  return (
    <img
      src={data.blobUrl}
      alt={alt}
      className={cn('rounded-xl border object-contain', className)}
    />
  )
}

/**
 * Auth-fetched receipt viewer dialog. Only mounts the image while open so the
 * blob URL lifecycle stays clean.
 */
export function ReceiptViewerDialog({
  url,
  open,
  onOpenChange,
}: {
  url: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>رسید پرداخت</DialogTitle>
          <DialogDescription>تصویر رسید با احراز هویت و به‌صورت امن بارگذاری می‌شود.</DialogDescription>
        </DialogHeader>
        {open && url ? (
          <ReceiptImage url={url} className="max-h-[60vh] w-full" />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Button + dialog combo: «مشاهده رسید» opens the secure receipt viewer. */
export function ReceiptViewButton({
  url,
  label = 'مشاهده رسید',
  variant = 'outline',
}: {
  url: string | null | undefined
  label?: string
  variant?: 'outline' | 'ghost' | 'secondary'
}) {
  const [open, setOpen] = useState(false)
  if (!url) return null
  return (
    <>
      <Button type="button" variant={variant} size="sm" onClick={() => setOpen(true)}>
        <ReceiptText className="size-4" aria-hidden />
        {label}
      </Button>
      <ReceiptViewerDialog url={url} open={open} onOpenChange={setOpen} />
    </>
  )
}
