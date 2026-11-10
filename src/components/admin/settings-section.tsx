'use client'

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
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
  MessageSquareHeart,
  RotateCcw,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import {
  api,
  fmtNumber,
  type Settings,
  type TelegramInfo,
  type PaymentDestination,
} from '@/lib/client'
import {
  DEFAULT_WELCOME_TEMPLATE,
  renderWelcomeTemplate,
} from '@/lib/bot-templates'

type AiKeyStatus = { keySource: 'env' | 'panel' | 'none'; geminiKeySource: 'env' | 'panel' | 'none' }
type SettingsResp = { settings: Settings; telegram: TelegramInfo; ai: AiKeyStatus }

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
      <WelcomeMessageCard settings={data.settings} onSaved={load} />
      <PaymentDestinationsCard />

      <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
        <AiAssistantCard settings={data.settings} ai={data.ai} onSaved={load} />
        <TelegramStatusCard telegram={data.telegram} />
      </div>

      <PasswordCard />
      <DangerZoneCard />
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
// 1-b) Bot welcome message (/start) — fully dynamic template
// ---------------------------------------------------------------------------

function WelcomeMessageCard({
  settings,
  onSaved,
}: {
  settings: Settings
  onSaved: () => void
}) {
  const [text, setText] = useState(settings.welcomeMessage ?? '')
  const [saving, setSaving] = useState(false)
  const [previewName, setPreviewName] = useState('علی')

  // keep the editor in sync when settings reload after a save
  useEffect(() => {
    setText(settings.welcomeMessage ?? '')
  }, [settings.welcomeMessage])

  const preview = useMemo(
    () =>
      renderWelcomeTemplate(text || DEFAULT_WELCOME_TEMPLATE, {
        name: previewName,
        store: settings.storeName,
      }),
    [text, previewName, settings.storeName],
  )

  async function save(e: FormEvent) {
    e.preventDefault()
    if (text.length > 2000) {
      toast.error('متن خوش‌آمد حداکثر ۲۰۰۰ کاراکتر است')
      return
    }
    setSaving(true)
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ welcomeMessage: text.trim() || DEFAULT_WELCOME_TEMPLATE }),
      })
      toast.success('پیام خوش‌آمد ذخیره شد — از این پس ربات همان را می‌فرستد')
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
          <MessageSquareHeart className="size-4 text-emerald-600" aria-hidden />
          پیام خوش‌آمدگویی ربات
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="s-welcome">متن پیام /start</Label>
            <Textarea
              id="s-welcome"
              rows={7}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={DEFAULT_WELCOME_TEMPLATE}
              className="font-medium"
            />
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
              <span>متغیرهای مجاز:</span>
              <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5">{'{name}'}</code>
              <span>نام کوچک مشتری —</span>
              <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5">{'{store}'}</code>
              <span>نام فروشگاه</span>
              <span className="ms-auto tabular-nums">{fmtNumber(text.length)}/۲۰۰۰</span>
            </div>
          </div>

          {/* Live preview with a sample customer name */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>پیش‌نمایش زنده</Label>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                نام نمونه:
                <Input
                  value={previewName}
                  onChange={(e) => setPreviewName(e.target.value)}
                  className="h-7 w-28 text-xs"
                  aria-label="نام نمونه برای پیش‌نمایش"
                />
              </span>
            </div>
            <div className="rounded-xl border bg-muted/40 p-4" dir="rtl">
              <p className="whitespace-pre-wrap text-sm leading-6">{preview}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              ذخیره پیام
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setText(DEFAULT_WELCOME_TEMPLATE)}
              disabled={saving || text === DEFAULT_WELCOME_TEMPLATE}
            >
              <RotateCcw className="size-4" aria-hidden />
              بازگردانی به متن پیش‌فرض
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
  ai,
  onSaved,
}: {
  settings: Settings
  ai: AiKeyStatus
  onSaved: () => void
}) {
  const [aiEnabled, setAiEnabled] = useState(Boolean(settings.aiEnabled))
  const [aiTone, setAiTone] = useState(settings.aiTone ?? '')
  const [apiKey, setApiKey] = useState('')
  const [geminiKey, setGeminiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  // re-sync when settings reload from the server
  useEffect(() => {
    setAiEnabled(Boolean(settings.aiEnabled))
    setAiTone(settings.aiTone ?? '')
  }, [settings])

  async function save(clearKey = false, clearGemini = false) {
    if (aiTone.length > 1000) {
      toast.error('متن لحن دستیار حداکثر ۱۰۰۰ کاراکتر است')
      return
    }
    if (!clearKey && apiKey.trim() && apiKey.trim().length < 20) {
      toast.error('کلید واردشده کوتاه به نظر می‌رسد')
      return
    }
    if (!clearGemini && geminiKey.trim() && geminiKey.trim().length < 20) {
      toast.error('کلید جمنای واردشده کوتاه به نظر می‌رسد')
      return
    }
    setSaving(true)
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          aiEnabled,
          aiTone: aiTone.trim() || undefined,
          ...(apiKey.trim() ? { zaiApiKey: apiKey.trim() } : {}),
          ...(clearKey ? { zaiApiKeyClear: true } : {}),
          ...(geminiKey.trim() ? { geminiApiKey: geminiKey.trim() } : {}),
          ...(clearGemini ? { geminiApiKeyClear: true } : {}),
        }),
      })
      toast.success(clearKey || clearGemini ? 'کلید حذف شد' : 'تنظیمات دستیار ذخیره شد')
      if (!clearKey) setApiKey('')
      if (!clearGemini) setGeminiKey('')
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function testConnection() {
    setTesting(true)
    try {
      const res = await api<{
        ok: boolean
        via?: string
        latencyMs?: number
        error?: string
        gemini?: { ok: boolean; error?: string; latencyMs?: number }
      }>('/api/ai/test-key', { method: 'POST' })
      // Gemini-specific result first — a broken Gemini key must never hide
      // behind a lower-tier success.
      if (res.gemini && !res.gemini.ok) {
        if (res.gemini.error === 'کلید جمنای تنظیم نشده است') {
          toast.warning('کلید جمنای ثبت نشده است — دستیار با گزینه‌های جایگزین کار می‌کند.')
        } else {
          toast.error(`کلید جمنای کار نمی‌کند: ${res.gemini.error ?? 'خطای نامشخص'}`)
        }
      } else if (res.ok) {
        const viaLabel =
          res.via === 'gemini'
            ? 'گوگل جمنای'
            : res.via === 'user-key'
              ? 'کلید اختصاصی Z.ai'
              : res.via === 'platform'
                ? 'گیت‌وی پلتفرم'
                : 'گیت‌وی رایگان (محدود)'
        toast.success(
          `اتصال برقرار است (${viaLabel}) — ${fmtNumber(Math.round((res.latencyMs ?? 0) / 100) / 10)} ثانیه`,
        )
      } else {
        toast.error(`اتصال ناموفق: ${res.error ?? 'خطای نامشخص'}`)
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const keyBadge =
    ai.keySource === 'env' ? (
      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">کلید از فایل سرور</Badge>
    ) : ai.keySource === 'panel' ? (
      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">کلید متصل است</Badge>
    ) : (
      <Badge variant="outline" className="border-amber-300 text-amber-700">
        بدون کلید — حالت محدود
      </Badge>
    )

  const geminiBadge =
    ai.geminiKeySource === 'env' ? (
      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">کلید از فایل سرور</Badge>
    ) : ai.geminiKeySource === 'panel' ? (
      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">کلید متصل است</Badge>
    ) : (
      <Badge variant="outline" className="border-amber-300 text-amber-700">
        بدون کلید
      </Badge>
    )

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="size-4 text-emerald-600" aria-hidden />
          دستیار هوش مصنوعی
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Gemini key — Tier A: the owner-requested default brain of the sales assistant */}
        <div className="space-y-2 rounded-xl border-2 border-emerald-200 bg-emerald-50/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="gemini-key" className="text-sm font-medium">
              کلید گوگل جمنای (Gemini) — موتور اصلی دستیار
            </Label>
            {geminiBadge}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            یک کلید رایگان از{' '}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-emerald-700 underline underline-offset-2"
              dir="ltr"
            >
              aistudio.google.com/apikey
            </a>{' '}
            بگیرید و اینجا وارد کنید. با این کلید، دستیار فروش با هوش مصنوعی گوگل جمنای به همه
            پیام‌ها پاسخ می‌دهد.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="gemini-key"
              type="password"
              dir="ltr"
              autoComplete="off"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder={
                ai.geminiKeySource === 'none'
                  ? 'کلید جمنای خود را اینجا بچسبانید'
                  : '•••••••• (برای تغییر، کلید جدید وارد کنید)'
              }
            />
            <div className="flex gap-2">
              <Button onClick={() => save(false, false)} disabled={saving} className="sm:w-auto">
                {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
                ذخیره
              </Button>
              <Button variant="outline" onClick={testConnection} disabled={testing}>
                {testing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Zap className="size-4" aria-hidden />}
                تست اتصال
              </Button>
            </div>
          </div>
          {ai.geminiKeySource === 'panel' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-destructive hover:text-destructive"
              onClick={() => save(false, true)}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden />
              حذف کلید جمنای
            </Button>
          )}
        </div>

        {/* Z.ai key — Tier B alternative when no Gemini key is configured */}
        <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="ai-key" className="text-sm font-medium">
              کلید جایگزین Z.ai (اختیاری)
            </Label>
            {keyBadge}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            اگر کلید جمنای نداشته باشید، دستیار از این کلید استفاده می‌کند؛ بدون هیچ‌کدام، حالت
            محدود (گیت‌وی رایگان) فعال می‌شود.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="ai-key"
              type="password"
              dir="ltr"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                ai.keySource === 'none'
                  ? 'کلید Z.ai خود را اینجا بچسبانید'
                  : '•••••••• (برای تغییر، کلید جدید وارد کنید)'
              }
            />
            <div className="flex gap-2">
              <Button onClick={() => save(false, false)} disabled={saving} className="sm:w-auto">
                {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
                ذخیره
              </Button>
            </div>
          </div>
          {ai.keySource === 'panel' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-destructive hover:text-destructive"
              onClick={() => save(true, false)}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden />
              حذف کلید
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
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

        <Button onClick={() => save(false, false)} disabled={saving}>
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

// ---------------------------------------------------------------------------
// 8) Danger zone — irreversible database reset
// ---------------------------------------------------------------------------

type ResetScope = 'catalog' | 'sales' | 'all'

const RESET_OPTIONS: {
  scope: ResetScope
  title: string
  description: string
}[] = [
  {
    scope: 'catalog',
    title: 'حذف محصولات و دسته‌بندی‌ها',
    description: 'همهٔ محصولات، دسته‌ها، گالری تصاویر و نوشته‌های منتشرشده در کانال حذف می‌شوند. سفارش‌ها و مشتریان دست‌نخورده می‌مانند.',
  },
  {
    scope: 'sales',
    title: 'حذف سفارش‌ها و مشتریان',
    description: 'همهٔ سفارش‌ها، پرداخت‌ها، مشتریان، گفتگوهای ربات و شماره‌گذاری سفارش‌ها از صفر شروع می‌شود. محصولات دست‌نخورده می‌مانند.',
  },
  {
    scope: 'all',
    title: 'ریست کامل فروشگاه',
    description: 'محصولات + دسته‌بندی‌ها + سفارش‌ها + مشتریان، همه با هم حذف می‌شوند. فروشگاه کاملاً خالی می‌شود.',
  },
]

function DangerZoneCard() {
  const [scope, setScope] = useState<ResetScope | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState<ResetScope | null>(null)

  const option = RESET_OPTIONS.find((o) => o.scope === scope) ?? null
  const confirmReady = confirmText.trim() === 'ریست'

  async function runReset() {
    if (!scope) return
    setBusy(scope)
    try {
      const d = await api<{ ok: boolean; message: string; deleted: Record<string, number> }>(
        '/api/admin/reset',
        {
          method: 'POST',
          body: JSON.stringify({ scope, confirm: 'ریست' }),
        },
      )
      const total = Object.values(d.deleted ?? {}).reduce((a, b) => a + (b ?? 0), 0)
      toast.success(`${d.message} (${fmtNumber(total)} رکورد حذف شد)`)
      setScope(null)
      setConfirmText('')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="rounded-xl border-red-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-red-700">
          <TriangleAlert className="size-4" aria-hidden />
          منطقهٔ خطر — بازنشانی دیتابیس
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          این عملیات <span className="font-semibold text-red-600">غیرقابل بازگشت</span> است.
          اطلاعات فروشگاه (نام، رمز عبور، کارت‌های پرداخت و نرخ نقره) حفظ می‌شود؛ فقط داده‌های
          انتخاب‌شده در هر گزینه پاک می‌شوند. قبل از ریست، از بکاپ روزانه مطمئن شوید.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {RESET_OPTIONS.map((o) => (
            <div
              key={o.scope}
              className="flex flex-col justify-between gap-3 rounded-lg border border-red-100 bg-red-50/40 p-4"
            >
              <div className="space-y-1">
                <p className="text-sm font-semibold text-red-800">{o.title}</p>
                <p className="text-xs leading-5 text-muted-foreground">{o.description}</p>
              </div>
              <AlertDialog
                onOpenChange={(open) => {
                  if (!open) {
                    setScope(null)
                    setConfirmText('')
                  }
                }}
              >
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setScope(o.scope)
                      setConfirmText('')
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    {o.title}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent dir="rtl" className="max-h-[90vh] overflow-y-auto sm:max-w-md">
                  <AlertDialogHeader className="text-right">
                    <AlertDialogTitle className="text-red-700">{option?.title}</AlertDialogTitle>
                    <AlertDialogDescription className="leading-6">
                      {option?.description}
                      <br />
                      <br />
                      برای تأیید، کلمهٔ <span className="font-bold text-red-700" dir="rtl">ریست</span> را در کادر زیر بنویسید.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <Input
                    dir="rtl"
                    placeholder="ریست"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    aria-label="کلمهٔ تأیید"
                  />
                  <AlertDialogFooter className="flex-row-reverse gap-2">
                    <AlertDialogAction
                      disabled={!confirmReady || busy !== null}
                      onClick={(e) => {
                        e.preventDefault() // keep the dialog open while busy
                        void runReset()
                      }}
                      className="bg-red-600 text-white hover:bg-red-700"
                    >
                      {busy !== null && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      بله، حذف کن
                    </AlertDialogAction>
                    <AlertDialogCancel>انصراف</AlertDialogCancel>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
