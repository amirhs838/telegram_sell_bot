'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SectionHeader } from '@/components/admin/bits'
import { Loader2, Store, Send, KeyRound, Info, CheckCircle2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { api, type Settings, type TelegramInfo } from '@/lib/client'

type SettingsResp = { settings: Settings; telegram: TelegramInfo }

export function SettingsSection() {
  const [data, setData] = useState<SettingsResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const d = await api<SettingsResp>('/api/settings')
      setData(d)
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading)
    return (
      <div className="space-y-6">
        <SectionHeader title="تنظیمات" description="اطلاعات فروشگاه، اتصال تلگرام و امنیت حساب" />
        <div className="h-64 animate-pulse rounded-xl border bg-card" />
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="h-48 animate-pulse rounded-xl border bg-card" />
          <div className="h-48 animate-pulse rounded-xl border bg-card" />
        </div>
      </div>
    )

  if (loadError || !data)
    return (
      <div className="space-y-6">
        <SectionHeader title="تنظیمات" description="اطلاعات فروشگاه، اتصال تلگرام و امنیت حساب" />
        <Card className="rounded-xl shadow-sm">
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-destructive">{loadError ?? 'خطا در دریافت تنظیمات'}</p>
            <Button variant="outline" size="sm" onClick={load}>
              تلاش مجدد
            </Button>
          </div>
        </Card>
      </div>
    )

  return (
    <div className="space-y-4 md:space-y-6">
      <SectionHeader title="تنظیمات" description="اطلاعات فروشگاه، اتصال تلگرام و امنیت حساب" />

      <StoreInfoCard settings={data.settings} onSaved={load} />
      <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
        <TelegramStatusCard telegram={data.telegram} />
        <PasswordCard />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1) Store info
// ---------------------------------------------------------------------------

function StoreInfoCard({
  settings,
  onSaved,
}: {
  settings: Settings
  onSaved: () => void
}) {
  const [storeName, setStoreName] = useState(settings.storeName ?? '')
  const [storeDescription, setStoreDescription] = useState(settings.storeDescription ?? '')
  const [supportUsername, setSupportUsername] = useState(settings.supportUsername ?? '')
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!storeName.trim()) {
      toast.error('نام فروشگاه را وارد کنید')
      return
    }
    setSaving(true)
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          storeName: storeName.trim(),
          storeDescription: storeDescription.trim() || undefined,
          supportUsername: supportUsername.trim() || undefined,
        }),
      })
      toast.success('تنظیمات ذخیره شد')
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Store className="size-4 text-emerald-600" aria-hidden />
          اطلاعات فروشگاه
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-name">نام فروشگاه *</Label>
            <Input
              id="s-name"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              placeholder="مثلاً: فروشگاه اینترنتی نمونه"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-support">آیدی پشتیبانی تلگرام</Label>
            <Input
              id="s-support"
              dir="ltr"
              className="text-left"
              value={supportUsername}
              onChange={(e) => setSupportUsername(e.target.value)}
              placeholder="@support_username"
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="s-desc">درباره فروشگاه</Label>
            <Textarea
              id="s-desc"
              rows={3}
              value={storeDescription}
              onChange={(e) => setStoreDescription(e.target.value)}
              placeholder="توضیح کوتاهی که در پیام خوش‌آمد ربات نمایش داده می‌شود…"
            />
          </div>
          <div className="md:col-span-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              ذخیره تغییرات
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 2) Telegram connection (read-only)
// ---------------------------------------------------------------------------

function TelegramStatusCard({ telegram }: { telegram: TelegramInfo }) {
  const flags = [
    { label: 'ربات', ok: telegram.botConfigured },
    { label: 'کانال', ok: telegram.channelConfigured },
    { label: 'چت مدیر', ok: telegram.adminChatConfigured },
  ]
  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="size-4 text-emerald-600" aria-hidden />
          وضعیت اتصال تلگرام
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {flags.map((f) => (
            <Badge
              key={f.label}
              variant="outline"
              className={
                f.ok
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-rose-50 text-rose-700 border-rose-200'
              }
            >
              {f.ok ? (
                <CheckCircle2 className="size-3" aria-hidden />
              ) : (
                <XCircle className="size-3" aria-hidden />
              )}
              {f.label}: {f.ok ? 'برقرار' : 'ناموفق'}
            </Badge>
          ))}
          <Badge
            variant="outline"
            className={
              telegram.mockMode
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
            }
          >
            حالت: {telegram.mockMode ? 'شبیه‌سازی' : 'واقعی'}
          </Badge>
          {telegram.botUsername && (
            <Badge variant="outline" className="bg-muted text-muted-foreground border-border">
              <span dir="ltr">@{telegram.botUsername}</span>
            </Badge>
          )}
        </div>
        <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          تنظیمات مخفی (توکن و شناسه‌ها) فقط از طریق فایل <code dir="ltr" className="font-mono">.env</code> تغییر می‌کنند.
        </p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 3) Change password
// ---------------------------------------------------------------------------

function PasswordCard() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next.length < 8) {
      toast.error('رمز عبور جدید باید حداقل ۸ کاراکتر باشد')
      return
    }
    if (next !== confirm) {
      toast.error('تکرار رمز عبور مطابقت ندارد')
      return
    }
    setSaving(true)
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      toast.success('رمز عبور با موفقیت تغییر کرد')
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-emerald-600" aria-hidden />
          تغییر رمز عبور
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sp-current">رمز عبور فعلی</Label>
            <Input
              id="sp-current"
              type="password"
              dir="ltr"
              className="text-left"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sp-next">رمز عبور جدید</Label>
            <Input
              id="sp-next"
              type="password"
              dir="ltr"
              className="text-left"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sp-confirm">تکرار رمز عبور جدید</Label>
            <Input
              id="sp-confirm"
              type="password"
              dir="ltr"
              className="text-left"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            تغییر رمز عبور
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
