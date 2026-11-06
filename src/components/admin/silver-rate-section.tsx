'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SectionHeader, ErrorRetry } from '@/components/admin/bits'
import { Gem, Loader2, History, Save } from 'lucide-react'
import { toast } from 'sonner'
import { api, fmtRel } from '@/lib/client'

type SilverRate = {
  id: string
  pricePerGram: number
  unit: string
  note: string | null
  active: boolean
  createdByEmail: string | null
  createdAt: string
}

export function SilverRateSection() {
  const [current, setCurrent] = useState<SilverRate | null>(null)
  const [history, setHistory] = useState<SilverRate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [price, setPrice] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<{ current: SilverRate | null; history: SilverRate[] }>('/api/silver-rate')
      setCurrent(d.current)
      setHistory(d.history ?? [])
      setPrice(d.current ? String(d.current.pricePerGram) : '')
      setNote(d.current?.note ?? '')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function save(e: FormEvent) {
    e.preventDefault()
    const value = Number(price)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('نرخ معتبر وارد کنید (بزرگ‌تر از صفر)')
      return
    }
    setSaving(true)
    try {
      await api('/api/silver-rate', {
        method: 'POST',
        body: JSON.stringify({ pricePerGram: value, note: note.trim() || undefined }),
      })
      toast.success('نرخ نقره ثبت شد (قیمت محصولات تغییر نمی‌کند)')
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" aria-hidden />
      </div>
    )
  }
  if (error) return <ErrorRetry message={error} onRetry={load} />

  return (
    <div className="space-y-6">
      <SectionHeader
        title="نرخ نقره"
        description="نرخ دستی و مرجع — فقط برای نمایش و اعلام به مشتری. تغییر نرخ هرگز قیمت محصولات را تغییر نمی‌دهد."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Current rate + entry form */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gem className="size-4 text-slate-500" aria-hidden />
              نرخ فعلی و ثبت نرخ جدید
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {current ? (
              <div className="rounded-xl border bg-emerald-50/60 p-4 text-center dark:bg-emerald-950/20">
                <p className="text-xs text-muted-foreground">آخرین نرخ ثبت‌شده</p>
                <p className="mt-1 text-2xl font-bold text-emerald-700 dark:text-emerald-400" dir="ltr">
                  {current.pricePerGram.toLocaleString('fa-IR')}
                  <span className="mr-1 text-sm font-normal"> {current.unit}</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {fmtRel(current.createdAt)}
                  {current.createdByEmail ? ` — توسط ${current.createdByEmail}` : ''}
                </p>
                {current.note && <p className="mt-1 text-xs text-muted-foreground">{current.note}</p>}
              </div>
            ) : (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-400">
                هنوز نرخی ثبت نشده است.
              </p>
            )}

            <form onSubmit={save} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="rate-price">نرخ هر گرم نقره (تومان) *</Label>
                <Input
                  id="rate-price"
                  dir="ltr"
                  className="text-left"
                  type="number"
                  min={1}
                  step="any"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="98000"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rate-note">توضیح یا منبع نرخ</Label>
                <Input
                  id="rate-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="مثلاً: نرخ بازار امروز"
                />
              </div>
              <Button type="submit" disabled={saving} className="w-full bg-emerald-600 text-white hover:bg-emerald-700">
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
                ثبت نرخ جدید
              </Button>
              <p className="text-xs text-muted-foreground">
                نرخ قبلی در تاریخچه حفظ می‌شود و قابل مشاهده است.
              </p>
            </form>
          </CardContent>
        </Card>

        {/* History */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="size-4 text-muted-foreground" aria-hidden />
              تاریخچه نرخ‌ها
            </CardTitle>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">تاریخچه‌ای وجود ندارد.</p>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                <ul className="space-y-2">
                  {history.map((r) => (
                    <li key={r.id} className="flex items-center justify-between rounded-lg border p-2.5">
                      <div>
                        <p className="text-sm font-medium" dir="ltr">
                          {r.pricePerGram.toLocaleString('fa-IR')} <span className="text-xs font-normal text-muted-foreground">{r.unit}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {fmtRel(r.createdAt)}
                          {r.createdByEmail ? ` — ${r.createdByEmail}` : ''}
                        </p>
                        {r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}
                      </div>
                      {r.active ? (
                        <Badge className="bg-emerald-600 text-white">فعلی</Badge>
                      ) : (
                        <Badge variant="secondary">قدیمی</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
