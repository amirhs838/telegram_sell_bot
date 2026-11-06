'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { SectionHeader, ConfirmDeleteDialog } from '@/components/admin/bits'
import {
  Loader2,
  Store,
  Send,
  KeyRound,
  Info,
  CheckCircle2,
  XCircle,
  Landmark,
  CreditCard,
  Plus,
  Trash2,
  Bot,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  fmtNumber,
  type Settings,
  type TelegramInfo,
  type PaymentDestination,
} from '@/lib/client'

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
        <SectionHeader title="تنظیمات" description="اطلاعات فروشگاه، پرداخت، دستیار هوشمند و امنیت حساب" />
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
        <SectionHeader title="تنظیمات" description="اطلاعات فروشگاه، پرداخت، دستیار هوشمند و امنیت حساب" />
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
      <SectionHeader title="تنظیمات" description="اطلاعات فروشگاه، پرداخت، دستیار هوشمند و امنیت حساب" />

      <StoreInfoCard settings={data.settings} onSaved={load} />
      <PaymentDestinationsCard />

      <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
        <AiAssistantCard settings={data.settings} onSaved={load} />
        <TelegramStatusCard telegram={data.telegram} />
      </div>

      <PasswordCard />
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
              placeholder="Silver Love"
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
// 2) Payment destinations (card-to-card)
// ---------------------------------------------------------------------------

type DestResp = { destinations?: PaymentDestination[] } | PaymentDestination[]

function normalizeDestinations(d: DestResp): PaymentDestination[] {
  return Array.isArray(d) ? d : (d.destinations ?? [])
}

function PaymentDestinationsCard() {
  const [destinations, setDestinations] = useState<PaymentDestination[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [bankName, setBankName] = useState('')
  const [accountHolder, setAccountHolder] = useState('')
  const [cardNumber, setCardNumber] = useState('')
  const [sheba, setSheba] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [note, setNote] = useState('')
  const [adding, setAdding] = useState(false)

  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<PaymentDestination | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const d = await api<DestResp>('/api/payment-destinations')
      setDestinations(normalizeDestinations(d))
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function addDestination(e: FormEvent) {
    e.preventDefault()
    if (!bankName.trim()) {
      toast.error('نام بانک را وارد کنید')
      return
    }
    if (!accountHolder.trim()) {
      toast.error('نام صاحب حساب را وارد کنید')
      return
    }
    if (!cardNumber.trim()) {
      toast.error('شماره کارت را وارد کنید')
      return
    }
    setAdding(true)
    try {
      await api('/api/payment-destinations', {
        method: 'POST',
        body: JSON.stringify({
          bankName: bankName.trim(),
          accountHolder: accountHolder.trim(),
          cardNumber: cardNumber.trim(),
          sheba: sheba.trim() || undefined,
          accountNumber: accountNumber.trim() || undefined,
          note: note.trim() || undefined,
        }),
      })
      toast.success('مقصد پرداخت اضافه شد')
      setBankName('')
      setAccountHolder('')
      setCardNumber('')
      setSheba('')
      setAccountNumber('')
      setNote('')
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setAdding(false)
    }
  }

  async function toggleActive(dest: PaymentDestination, active: boolean) {
    setTogglingId(dest.id)
    try {
      await api(`/api/payment-destinations/${dest.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      })
      toast.success(active ? 'مقصد پرداخت فعال شد' : 'مقصد پرداخت غیرفعال شد')
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setTogglingId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await api(`/api/payment-destinations/${deleting.id}`, { method: 'DELETE' })
      toast.success('مقصد پرداخت حذف شد')
      setDeleting(null)
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setDeleteLoading(false)
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="size-4 text-emerald-600" aria-hidden />
          اطلاعات پرداخت (کارت به کارت)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="flex items-start gap-2 rounded-lg bg-emerald-50/70 p-2.5 text-xs text-emerald-800">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          این حساب‌ها به‌عنوان مقصد پرداخت کارت‌به‌کارت به مشتریان نمایش داده می‌شوند.
        </p>

        {/* Existing destinations */}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl border bg-muted/40" />
            ))}
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border p-6 text-center">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={load}>
              تلاش مجدد
            </Button>
          </div>
        ) : destinations.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            هنوز مقصد پرداختی ثبت نشده است — اولین حساب را از فرم زیر اضافه کنید.
          </p>
        ) : (
          <ul className="max-h-96 space-y-3 overflow-y-auto scroll-thin">
            {destinations.map((dest) => (
              <li key={dest.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <Landmark className="size-4 text-muted-foreground" aria-hidden />
                      {dest.bankName}
                    </p>
                    <p className="mt-1 text-sm">{dest.accountHolder}</p>
                    <p dir="ltr" className="mt-0.5 text-start font-mono text-sm tracking-wider">
                      {dest.cardNumber}
                    </p>
                    {dest.sheba && (
                      <p dir="ltr" className="mt-0.5 text-start font-mono text-xs text-muted-foreground">
                        {dest.sheba}
                      </p>
                    )}
                    {dest.accountNumber && (
                      <p dir="ltr" className="mt-0.5 text-start font-mono text-xs text-muted-foreground">
                        {dest.accountNumber}
                      </p>
                    )}
                    {dest.note && (
                      <p className="mt-1 text-xs text-muted-foreground">{dest.note}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        dest.active
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-slate-100 text-slate-600 border-slate-200'
                      }
                    >
                      {dest.active ? 'فعال' : 'غیرفعال'}
                    </Badge>
                    <Switch
                      checked={dest.active}
                      onCheckedChange={(checked) => toggleActive(dest, checked)}
                      disabled={togglingId === dest.id}
                      aria-label={`${dest.active ? 'غیرفعال کردن' : 'فعال کردن'} حساب ${dest.bankName}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleting(dest)}
                      aria-label={`حذف حساب ${dest.bankName}`}
                      className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <Separator />

        {/* Inline add form */}
        <form onSubmit={addDestination} className="space-y-3">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Plus className="size-4 text-emerald-600" aria-hidden />
            افزودن مقصد جدید
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pd-bank">نام بانک *</Label>
              <Input
                id="pd-bank"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="مثلاً: بانک ملت"
                disabled={adding}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pd-holder">نام صاحب حساب *</Label>
              <Input
                id="pd-holder"
                value={accountHolder}
                onChange={(e) => setAccountHolder(e.target.value)}
                placeholder="مثلاً: سارا محمدی"
                disabled={adding}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pd-card">شماره کارت *</Label>
              <Input
                id="pd-card"
                dir="ltr"
                className="text-left"
                inputMode="numeric"
                value={cardNumber}
                onChange={(e) => setCardNumber(e.target.value)}
                placeholder="6104XXXXXXXXXXXX"
                disabled={adding}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pd-sheba">شماره شبا</Label>
              <Input
                id="pd-sheba"
                dir="ltr"
                className="text-left"
                value={sheba}
                onChange={(e) => setSheba(e.target.value)}
                placeholder="IRXXXXXXXXXXXXXXXXXXXXXXXX"
                disabled={adding}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pd-acc">شماره حساب</Label>
              <Input
                id="pd-acc"
                dir="ltr"
                className="text-left"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                disabled={adding}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pd-note">یادداشت</Label>
              <Input
                id="pd-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="مثلاً: فقط برای سفارش‌های بالای ۲ میلیون"
                disabled={adding}
              />
            </div>
          </div>
          <Button type="submit" disabled={adding}>
            {adding && <Loader2 className="size-4 animate-spin" aria-hidden />}
            افزودن مقصد پرداخت
          </Button>
        </form>
      </CardContent>

      <ConfirmDeleteDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="حذف مقصد پرداخت"
        description={`آیا از حذف حساب «${deleting?.bankName ?? ''}» مطمئن هستید؟ این عمل قابل بازگشت نیست.`}
        loading={deleteLoading}
        onConfirm={confirmDelete}
      />
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 3) AI sales assistant
// ---------------------------------------------------------------------------

function AiAssistantCard({
  settings,
  onSaved,
}: {
  settings: Settings
  onSaved: () => void
}) {
  const [aiEnabled, setAiEnabled] = useState(Boolean(settings.aiEnabled))
  const [aiTone, setAiTone] = useState(settings.aiTone ?? '')
  const [saving, setSaving] = useState(false)

  // re-sync when settings reload from the server
  useEffect(() => {
    setAiEnabled(Boolean(settings.aiEnabled))
    setAiTone(settings.aiTone ?? '')
  }, [settings])

  async function save() {
    if (aiTone.length > 1000) {
      toast.error('متن لحن دستیار حداکثر ۱۰۰۰ کاراکتر است')
      return
    }
    setSaving(true)
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          aiEnabled,
          aiTone: aiTone.trim() || undefined,
        }),
      })
      toast.success('تنظیمات دستیار ذخیره شد')
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
          <Bot className="size-4 text-emerald-600" aria-hidden />
          دستیار هوش مصنوعی
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 p-3">
          <div>
            <Label htmlFor="ai-enabled" className="text-sm font-medium">
              فعال‌بودن دستیار فروش
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              پاسخ‌گویی خودکار و پیشنهاد محصول در گفتگوهای ربات
            </p>
          </div>
          <Switch
            id="ai-enabled"
            checked={aiEnabled}
            onCheckedChange={setAiEnabled}
            aria-label="فعال‌بودن دستیار فروش"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ai-tone">لحن و شخصیت فروشنده (اختیاری)</Label>
          <Textarea
            id="ai-tone"
            rows={4}
            value={aiTone}
            maxLength={1000}
            onChange={(e) => setAiTone(e.target.value)}
            placeholder="مثلاً: صمیمی و پرانرژی بنویس؛ با «شما» خطاب کن، روی کیفیت نقره ۹۲۵ و هدیه‌پذیر بودن تأکید کن و در پایان پیام، یک پیشنهاد کوتاه خرید اضافه کن."
          />
          <p className="text-xs text-muted-foreground">
            {fmtNumber(aiTone.length)} از ۱۰۰۰ کاراکتر
          </p>
        </div>

        <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
          قواعد قطعی قیمت‌گذاری و تأیید پرداخت قابل تغییر نیستند.
        </p>

        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          ذخیره تنظیمات دستیار
        </Button>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 4) Telegram connection (read-only)
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
          وضعیت اتصال به‌صورت خودکار بررسی می‌شود؛ برای آزمون ارسال از بخش «تلگرام و ربات» استفاده کنید.
        </p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 5) Change password
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
        <form onSubmit={submit} className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
          <div>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              تغییر رمز عبور
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
