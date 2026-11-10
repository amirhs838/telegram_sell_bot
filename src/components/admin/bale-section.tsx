'use client'

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  SectionHeader,
  ErrorRetry,
} from '@/components/admin/bits'
import {
  MessageCircle,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Inbox,
  RefreshCw,
  CloudUpload,
  Activity,
  Loader2,
  PlugZap,
  Eye,
  EyeOff,
  ChevronDown,
  BookOpen,
  Unplug,
  StepForward,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  fmtRel,
  type ActivityLogItem,
  type BaleStatus,
  type BaleConfigInfo,
  type BaleSaveResult,
  type TelegramCheck,
} from '@/lib/client'
import { cn } from '@/lib/utils'

/**
 * Bale section — mirrors the Telegram section design 1:1 (same form, same
 * status cards, same verification flow). The Bale Bot API is a Telegram
 * clone at tapi.bale.ai, so the UX and the checks are identical; only the
 * guide steps (ble.ir, BotFather inside Bale) and the activity log types
 * (bale_out / bale_error / …) differ.
 */
export function BaleSection() {
  const [status, setStatus] = useState<BaleStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ mode: string; checks: TelegramCheck[] } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<BaleStatus>('/api/bale/status')
      setStatus(d)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function testConnection() {
    setTesting(true)
    try {
      const d = await api<{ ok: boolean; mode: string; checks: TelegramCheck[] }>(
        '/api/bale/test',
        { method: 'POST' },
      )
      setTestResult({ mode: d.mode, checks: d.checks ?? [] })
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setTesting(false)
    }
  }

  if (loading)
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border bg-card" />
          ))}
        </div>
        <div className="h-96 animate-pulse rounded-xl border bg-card" />
      </div>
    )

  if (error || !status) return <ErrorRetry message={error ?? ''} onRetry={load} />

  return (
    <div className="space-y-6">
      <SectionHeader
        title="بله و ربات"
        description="اتصال ربات و کانال بله — همان فروشگاه، همان محصولات، همان دستیار هوشمند"
      >
        <Button onClick={testConnection} disabled={testing} variant="outline">
          {testing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Activity className="size-4" aria-hidden />}
          تست اتصال
        </Button>
      </SectionHeader>

      {/* Connection wizard — connect bot & channel from the panel */}
      <BaleConfigCard onSaved={load} />

      {/* Status cards */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        <StatusCard
          label="ربات بله"
          ok={status.botConfigured}
          okText="پیکربندی شده"
          badText="پیکربندی نشده"
          sub={status.botUsername ? <span dir="ltr">@{status.botUsername}</span> : undefined}
        />
        <StatusCard label="کانال بله" ok={status.channelConfigured} okText="متصل" badText="تنظیم نشده" />
        <StatusCard label="چت مدیر" ok={status.adminChatConfigured} okText="تنظیم شده" badText="تنظیم نشده" />
        <StatusCard
          label="حالت اجرا"
          ok={!status.mockMode}
          okText="واقعی"
          badText="شبیه‌سازی"
          okClassName="bg-emerald-50 text-emerald-700 border-emerald-200"
          badClassName="bg-amber-50 text-amber-700 border-amber-200"
          sub={
            <span className="text-xs text-muted-foreground">
              {status.mockMode
                ? 'پیام‌ها ثبت می‌شوند، ارسال واقعی انجام نمی‌شود'
                : status.source === 'panel'
                  ? 'اتصال از پنل — اتصال واقعی به Bale Bot API'
                  : 'اتصال واقعی به Bale Bot API'}
            </span>
          }
        />
      </div>

      {status.botUsername && (
        <div className="rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground">
          نمونه لینک سفارش محصول (deep link):
          <code dir="ltr" className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">
            https://ble.ir/{status.botUsername}?start=product_&lt;id&gt;
          </code>
        </div>
      )}

      {/* Recent activity feed */}
      <Card className="rounded-xl shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4 text-emerald-600" aria-hidden />
            فعالیت اخیر بله
          </CardTitle>
        </CardHeader>
        <CardContent>
          {status.recentMessages?.length ? (
            <ul className="max-h-96 space-y-1 divide-y overflow-y-auto scroll-thin">
              {status.recentMessages.map((m) => (
                <li key={m.id} className="flex items-start gap-3 py-2.5">
                  <LogIcon type={m.type} />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 break-words text-sm leading-6">{m.message}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{fmtRel(m.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Inbox className="size-8 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">فعالیتی ثبت نشده است</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Test-connection diagnostics dialog */}
      <Dialog open={testResult !== null} onOpenChange={(o) => !o && setTestResult(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>نتیجه تست اتصال بله</DialogTitle>
            <DialogDescription>
              {testResult?.mode === 'mock'
                ? 'حالت شبیه‌سازی فعال است — برای ارسال واقعی، ربات بله خود را وصل کنید'
                : 'نتیجه بررسی اجزای اتصال به بله'}
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            {testResult?.checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2 rounded-lg border p-2.5">
                {c.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-rose-500" aria-hidden />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium">{c.label}</p>
                  <p className="break-words text-xs text-muted-foreground">{c.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connection wizard — connect bot & channel from the panel
// ---------------------------------------------------------------------------

type Step = { title: string; body: ReactNode }

const BALE_CONNECT_STEPS: Step[] = [
  {
    title: 'ساخت ربات در بله',
    body: (
      <>
        در پیام‌رسان بله به{' '}
        <a href="https://ble.ir/botfather" target="_blank" rel="noreferrer" className="font-medium text-emerald-700 underline underline-offset-2" dir="ltr">@BotFather</a>{' '}
        پیام بدهید و بازوی خود را بسازید. توکن دریافتی (شکل{' '}
        <code dir="ltr" className="rounded bg-muted px-1">123456789:AAE…</code>) را در فیلد «توکن ربات» وارد کنید.
      </>
    ),
  },
  {
    title: 'مدیرکردن ربات در کانال بله',
    body: (
      <>
        در کانال خود بخش مدیریت را باز کنید و ربات را با دسترسی ارسال پیام به‌عنوان مدیر اضافه کنید؛
        وگرنه انتشار پست ممکن نیست.
      </>
    ),
  },
  {
    title: 'شناسه کانال',
    body: (
      <>
        شناسه کانال بله را وارد کنید (عددی یا یوزرنیم کانال مثل{' '}
        <code dir="ltr" className="rounded bg-muted px-1">@mychannel</code>). برای کانال خصوصی، شناسه عددی را از
        اطلاعات کانال کپی کنید.
      </>
    ),
  },
  {
    title: 'شناسه چت شما (اعلان سفارش‌ها)',
    body: (
      <>
        شناسه عددی حساب خودتان در بله را وارد کنید. نکته: قبل از تست، یک‌بار در ربات خودتان
        <code dir="ltr" className="mx-1 rounded bg-muted px-1">/start</code> بزنید تا ربات بتواند برایتان پیام بفرستد.
      </>
    ),
  },
  {
    title: 'یوزرنیم ربات',
    body: (
      <>
        یوزرنیم ربات را بدون @ وارد کنید (مثل <code dir="ltr" className="rounded bg-muted px-1">my_store_bot</code>).
        این یوزرنیم برای ساخت دکمه «🛒 سفارش در ربات» زیر پست‌های کانال استفاده می‌شود.
      </>
    ),
  },
]

function BaleConfigCard({ onSaved }: { onSaved: () => void }) {
  const [cfg, setCfg] = useState<BaleConfigInfo | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [botToken, setBotToken] = useState('')
  const [channelId, setChannelId] = useState('')
  const [adminChatId, setAdminChatId] = useState('')
  const [botUsername, setBotUsername] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [checks, setChecks] = useState<TelegramCheck[] | null>(null)

  const load = useCallback(async () => {
    setLoadErr(null)
    try {
      const d = await api<BaleConfigInfo>('/api/bale/config')
      setCfg(d)
      setChannelId(d.channelId ?? '')
      setAdminChatId(d.adminChatId ?? '')
      setBotUsername(d.botUsername ?? '')
      setBotToken('')
    } catch (err) {
      setLoadErr((err as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!botToken.trim() || !channelId.trim() || !adminChatId.trim() || !botUsername.trim()) {
      toast.error('همه فیلدها را پر کنید')
      return
    }
    setSaving(true)
    setChecks(null)
    try {
      const d = await api<BaleSaveResult>('/api/bale/config', {
        method: 'PUT',
        body: JSON.stringify({
          botToken: botToken.trim(),
          channelId: channelId.trim(),
          adminChatId: adminChatId.trim(),
          botUsername: botUsername.trim(),
        }),
      })
      setChecks(d.checks ?? [])
      const okCount = (d.checks ?? []).filter((c) => c.ok).length
      const total = (d.checks ?? []).length
      if (d.warnings?.length) {
        for (const w of d.warnings) toast.warning(w)
      }
      if (okCount === total) {
        toast.success('اتصال بله ذخیره و تأیید شد ✅ — ظرف چند ثانیه فعال می‌شود')
      } else {
        toast.info('اتصال ذخیره شد — نتیجه بررسی را در کارت ببینید')
      }
      await load()
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function disconnect() {
    setDisconnecting(true)
    try {
      await api('/api/bale/config', { method: 'DELETE' })
      toast.success('اتصال بله از پنل حذف شد')
      setChecks(null)
      await load()
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <PlugZap className="size-4 text-emerald-600" aria-hidden />
          اتصال ربات و کانال بله
          {cfg && (
            <Badge
              variant="outline"
              className={cn(
                'text-xs',
                cfg.source === 'panel'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-slate-100 text-slate-600 border-slate-200',
              )}
            >
              {cfg.source === 'panel' ? 'متصل از پنل' : 'از متغیرهای محیطی'}
            </Badge>
          )}
        </CardTitle>
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setGuideOpen((v) => !v)}>
          <BookOpen className="size-3.5" aria-hidden />
          راهنمای گام‌به‌گام
          <ChevronDown className={cn('size-3.5 transition-transform', guideOpen && 'rotate-180')} aria-hidden />
        </Button>
      </CardHeader>
      <CardContent>
        {loadErr ? (
          <div className="flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            <span>{loadErr}</span>
            <Button variant="outline" size="sm" onClick={load}>تلاش دوباره</Button>
          </div>
        ) : !cfg ? (
          <div className="h-32 animate-pulse rounded-lg bg-muted" />
        ) : (
          <>
            <Collapsible open={guideOpen} onOpenChange={setGuideOpen} className="col-span-full">
              <CollapsibleContent>
                <ol className="mb-4 space-y-2.5 rounded-xl border border-emerald-200/70 bg-emerald-50/50 p-4">
                  {BALE_CONNECT_STEPS.map((s, i) => (
                    <li key={s.title} className="flex items-start gap-2.5 text-sm leading-6">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white">
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium">{s.title}</p>
                        <p className="text-muted-foreground">{s.body}</p>
                      </div>
                    </li>
                  ))}
                  <li className="flex items-start gap-2.5 rounded-lg bg-emerald-100/60 p-2.5 text-xs text-emerald-800">
                    <StepForward className="mt-0.5 size-4 shrink-0" aria-hidden />
                    بعد از پرکردن فیلدها، «ذخیره و اتصال» را بزنید. اتصال جدید ظرف حداکثر ~۳۰ ثانیه
                    در سرویس ربات فعال می‌شود (نیازی به ری‌استارت نیست).
                  </li>
                </ol>
              </CollapsibleContent>
            </Collapsible>

            <form onSubmit={save} className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="bale-token">توکن ربات (Bot Token)</Label>
                <div className="relative">
                  <Input
                    id="bale-token"
                    dir="ltr"
                    className="pe-10 text-left font-mono text-xs"
                    type={showToken ? 'text' : 'password'}
                    autoComplete="off"
                    placeholder={cfg.botTokenMasked ?? '123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxx'}
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    aria-describedby="bale-token-hint"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((v) => !v)}
                    className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showToken ? 'پنهانکردن توکن' : 'نمایش توکن'}
                  >
                    {showToken ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                  </button>
                </div>
                <p id="bale-token-hint" className="text-xs text-muted-foreground">
                  {cfg.botTokenMasked
                    ? <>توکن فعلی: <span dir="ltr" className="font-mono">{cfg.botTokenMasked}</span> — برای تغییر، توکن جدید را وارد کنید</>
                    : 'از @BotFather داخل بله دریافت می‌شود (مرحله ۱)'}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bale-channel">شناسه کانال بله</Label>
                <Input
                  id="bale-channel"
                  dir="ltr"
                  className="text-left font-mono text-xs"
                  autoComplete="off"
                  placeholder="1234567 یا @mychannel"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">شناسه کانال یا یوزرنیم آن (مرحله ۳)</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bale-admin">شناسه چت مدیر (اعلان سفارش‌ها)</Label>
                <Input
                  id="bale-admin"
                  dir="ltr"
                  className="text-left font-mono text-xs"
                  autoComplete="off"
                  placeholder="123456789"
                  value={adminChatId}
                  onChange={(e) => setAdminChatId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">شناسه عددی حساب شما در بله (مرحله ۴)</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bale-username">یوزرنیم ربات</Label>
                <Input
                  id="bale-username"
                  dir="ltr"
                  className="text-left font-mono text-xs"
                  autoComplete="off"
                  placeholder="my_store_bot"
                  value={botUsername}
                  onChange={(e) => setBotUsername(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">بدون @ — برای دکمه «سفارش در ربات» (مرحله ۵)</p>
              </div>

              {/* Verification results */}
              {checks && checks.length > 0 && (
                <ul className="space-y-1.5 md:col-span-2" aria-live="polite">
                  {checks.map((c) => (
                    <li key={c.key} className="flex items-start gap-2 rounded-lg border bg-muted/30 p-2.5 text-xs">
                      {c.ok ? (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
                      ) : (
                        <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-500" aria-hidden />
                      )}
                      <span className="min-w-0 break-words">
                        <b>{c.label}:</b> {c.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-2 md:col-span-2">
                <Button type="submit" disabled={saving}>
                  {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <PlugZap className="size-4" aria-hidden />}
                  ذخیره و اتصال
                </Button>
                {cfg.source === 'panel' && (
                  <Button type="button" variant="outline" onClick={disconnect} disabled={disconnecting} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                    {disconnecting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Unplug className="size-4" aria-hidden />}
                    قطع اتصال
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  توکن فقط در سرور ذخیره می‌شود و هرگز کامل نمایش داده نمی‌شود.
                </p>
              </div>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Status card
// ---------------------------------------------------------------------------

function StatusCard({
  label,
  ok,
  okText,
  badText,
  sub,
  okClassName = 'bg-emerald-50 text-emerald-700 border-emerald-200',
  badClassName = 'bg-rose-50 text-rose-700 border-rose-200',
}: {
  label: string
  ok: boolean
  okText: string
  badText: string
  sub?: ReactNode
  okClassName?: string
  badClassName?: string
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        {ok ? (
          <CheckCircle2 className="size-5 text-emerald-600" aria-hidden />
        ) : (
          <XCircle className="size-5 text-rose-500" aria-hidden />
        )}
        <Badge variant="outline" className={ok ? okClassName : badClassName}>
          {ok ? okText : badText}
        </Badge>
      </div>
      {sub && <div className="mt-1.5 text-xs">{sub}</div>}
    </div>
  )
}

function LogIcon({ type }: { type: string }) {
  const cls = 'mt-0.5 size-4 shrink-0'
  if (type === 'bale_error') return <AlertTriangle className={cn(cls, 'text-rose-500')} aria-hidden />
  if (type === 'bale.publish') return <CloudUpload className={cn(cls, 'text-emerald-600')} aria-hidden />
  if (type === 'bale.sync') return <RefreshCw className={cn(cls, 'text-amber-600')} aria-hidden />
  if (type === 'bale.config_updated') return <PlugZap className={cn(cls, 'text-teal-600')} aria-hidden />
  if (type === 'bale.config_removed') return <Unplug className={cn(cls, 'text-slate-500')} aria-hidden />
  return <MessageCircle className={cn(cls, 'text-emerald-600')} aria-hidden />
}
