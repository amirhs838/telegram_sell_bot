'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import {
  SectionHeader,
  ErrorRetry,
} from '@/components/admin/bits'
import {
  Send,
  CheckCircle2,
  XCircle,
  FlaskConical,
  RotateCcw,
  AlertTriangle,
  Inbox,
  RefreshCw,
  CloudUpload,
  CloudOff,
  Activity,
  Bot,
  ExternalLink,
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
  stripHtml,
  fmtRel,
  type ActivityLogItem,
  type BotKeyboardButton,
  type BotReply,
  type TelegramStatus,
  type TelegramConfigInfo,
  type TelegramSaveResult,
  type TelegramCheck,
} from '@/lib/client'
import { cn } from '@/lib/utils'

type ChatMessage = {
  id: number
  role: 'bot' | 'user'
  text: string
  keyboard?: BotKeyboardButton[][]
}

let msgSeq = 1

export function TelegramSection() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ mode: string; checks: TelegramCheck[] } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<TelegramStatus>('/api/telegram/status')
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
        '/api/telegram/test',
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
        title="تلگرام و ربات"
        description="اتصال ربات و کانال، آزمایشگاه ربات و فعالیت اخیر"
      >
        <Button onClick={testConnection} disabled={testing} variant="outline">
          {testing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Activity className="size-4" aria-hidden />}
          تست اتصال
        </Button>
      </SectionHeader>

      {/* Connection wizard — connect bot & channel from the panel */}
      <TelegramConfigCard onSaved={load} />

      {/* Status cards */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        <StatusCard
          label="ربات"
          ok={status.botConfigured}
          okText="پیکربندی شده"
          badText="پیکربندی نشده"
          sub={status.botUsername ? <span dir="ltr">@{status.botUsername}</span> : undefined}
        />
        <StatusCard label="کانال" ok={status.channelConfigured} okText="متصل" badText="تنظیم نشده" />
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
                  ? 'اتصال از پنل — اتصال واقعی به Bot API'
                  : 'اتصال واقعی به Bot API'}
            </span>
          }
        />
      </div>

      {status.botUsername && (
        <div className="rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground">
          نمونه لینک سفارش محصول (deep link):
          <code dir="ltr" className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">
            https://t.me/{status.botUsername}?start=product_&lt;id&gt;
          </code>
        </div>
      )}

      <div className="grid gap-4 md:gap-6 xl:grid-cols-2">
        {/* Bot Lab */}
        <BotLab />

        {/* Recent activity feed */}
        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4 text-emerald-600" aria-hidden />
              فعالیت اخیر تلگرام
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
      </div>

      {/* Test-connection diagnostics dialog */}
      <Dialog open={testResult !== null} onOpenChange={(o) => !o && setTestResult(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>نتیجه تست اتصال</DialogTitle>
            <DialogDescription>
              {testResult?.mode === 'mock'
                ? 'حالت شبیه‌سازی فعال است — برای ارسال واقعی، ربات خود را وصل کنید'
                : 'نتیجه بررسی اجزای اتصال به تلگرام'}
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

const CONNECT_STEPS: Step[] = [
  {
    title: 'ساخت ربات',
    body: (
      <>
        در تلگرام به{' '}
        <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="font-medium text-emerald-700 underline underline-offset-2" dir="ltr">@BotFather</a>{' '}
        پیام بدهید و دستور <code dir="ltr" className="rounded bg-muted px-1">/newbot</code> را بفرستید. یک نام و
        یوزرنیم انتخاب کنید؛ توکن دریافتی (شکل{' '}
        <code dir="ltr" className="rounded bg-muted px-1">123456789:AAE…</code>) را در فیلد «توکن ربات» وارد کنید.
      </>
    ),
  },
  {
    title: 'مدیرکردن ربات در کانال',
    body: (
      <>
        در کانال خود بخش «مدیریت کانال → Administrators» را باز کنید و ربات را با دسترسی
        ارسال پیام (Post Messages) به‌عنوان مدیر اضافه کنید؛ وگرنه انتشار پست ممکن نیست.
      </>
    ),
  },
  {
    title: 'شناسه کانال',
    body: (
      <>
        یک پیام از کانال خود را به{' '}
        <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="font-medium text-emerald-700 underline underline-offset-2" dir="ltr">@userinfobot</a>{' '}
        فوروارد کنید؛ شناسه عددی (شکل{' '}
        <code dir="ltr" className="rounded bg-muted px-1">-1001234567890</code>) را کپی کنید.
        برای کانال عمومی می‌توانید یوزرنیم را هم وارد کنید (مثل <code dir="ltr" className="rounded bg-muted px-1">@mychannel</code>).
      </>
    ),
  },
  {
    title: 'شناسه چت شما (اعلان سفارش‌ها)',
    body: (
      <>
        در تلگرام به{' '}
        <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="font-medium text-emerald-700 underline underline-offset-2" dir="ltr">@userinfobot</a>{' '}
        هر پیامی بفرستید؛ عدد «Id» همان شناسه چت شماست. نکته: قبل از تست، یک‌بار در ربات خودتان
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

function TelegramConfigCard({ onSaved }: { onSaved: () => void }) {
  const [cfg, setCfg] = useState<TelegramConfigInfo | null>(null)
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
      const d = await api<TelegramConfigInfo>('/api/telegram/config')
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
      const d = await api<TelegramSaveResult>('/api/telegram/config', {
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
        toast.success('اتصال ذخیره و تأیید شد ✅ — ظرف چند ثانیه فعال می‌شود')
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
      await api('/api/telegram/config', { method: 'DELETE' })
      toast.success('اتصال از پنل حذف شد')
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
          اتصال ربات و کانال تلگرام
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
                  {CONNECT_STEPS.map((s, i) => (
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
                <Label htmlFor="tg-token">توکن ربات (Bot Token)</Label>
                <div className="relative">
                  <Input
                    id="tg-token"
                    dir="ltr"
                    className="pe-10 text-left font-mono text-xs"
                    type={showToken ? 'text' : 'password'}
                    autoComplete="off"
                    placeholder={cfg.botTokenMasked ?? '123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxx'}
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    aria-describedby="tg-token-hint"
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
                <p id="tg-token-hint" className="text-xs text-muted-foreground">
                  {cfg.botTokenMasked
                    ? <>توکن فعلی: <span dir="ltr" className="font-mono">{cfg.botTokenMasked}</span> — برای تغییر، توکن جدید را وارد کنید</>
                    : 'از @BotFather دریافت می‌شود (مرحله ۱)'}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tg-channel">شناسه کانال</Label>
                <Input
                  id="tg-channel"
                  dir="ltr"
                  className="text-left font-mono text-xs"
                  autoComplete="off"
                  placeholder="-1001234567890 یا @mychannel"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">فوروارد یک پست کانال به @userinfobot (مرحله ۳)</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tg-admin">شناسه چت مدیر (اعلان سفارش‌ها)</Label>
                <Input
                  id="tg-admin"
                  dir="ltr"
                  className="text-left font-mono text-xs"
                  autoComplete="off"
                  placeholder="123456789"
                  value={adminChatId}
                  onChange={(e) => setAdminChatId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">شناسه تلگرام خودتان از @userinfobot (مرحله ۴)</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tg-username">یوزرنیم ربات</Label>
                <Input
                  id="tg-username"
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
  if (type === 'telegram_error') return <AlertTriangle className={cn(cls, 'text-rose-500')} aria-hidden />
  if (type === 'telegram.publish') return <CloudUpload className={cn(cls, 'text-emerald-600')} aria-hidden />
  if (type === 'telegram.sync') return <RefreshCw className={cn(cls, 'text-amber-600')} aria-hidden />
  if (type === 'telegram.unpublish') return <CloudOff className={cn(cls, 'text-slate-500')} aria-hidden />
  if (type === 'telegram_in') return <Inbox className={cn(cls, 'text-teal-600')} aria-hidden />
  return <Send className={cn(cls, 'text-emerald-600')} aria-hidden />
}

// ---------------------------------------------------------------------------
// Bot Lab — chat simulator
// ---------------------------------------------------------------------------

const QUICK_ACTIONS: { label: string; body: { text?: string; callbackData?: string } }[] = [
  { label: '/start', body: { text: '/start' } },
  { label: 'منوی سفارش‌ها', body: { callbackData: 'menu:orders' } },
  { label: 'جستجو', body: { callbackData: 'menu:search' } },
]

function BotLab() {
  const [telegramUserId, setTelegramUserId] = useState('sim-user-1')
  const [userIdDraft, setUserIdDraft] = useState('sim-user-1')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [serviceOk, setServiceOk] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  const simulate = useCallback(
    async (body: { text?: string; callbackData?: string; action?: string }, userEcho?: string) => {
      setSending(true)
      if (userEcho) {
        setMessages((prev) => [...prev, { id: msgSeq++, role: 'user', text: userEcho }])
      }
      try {
        const d = await api<{ replies: BotReply[] }>('/api/bot/simulate', {
          method: 'POST',
          body: JSON.stringify({ telegramUserId, ...body }),
        })
        setServiceOk(true)
        const replies = d.replies ?? []
        if (replies.length === 0) {
          setMessages((prev) => [
            ...prev,
            { id: msgSeq++, role: 'bot', text: 'پاسخی دریافت نشد.' },
          ])
        } else {
          setMessages((prev) => [
            ...prev,
            ...replies.map((r) => ({
              id: msgSeq++,
              role: 'bot' as const,
              text: stripHtml(r.text ?? ''),
              keyboard: r.keyboard,
            })),
          ])
        }
      } catch (err) {
        setServiceOk(false)
        setMessages((prev) => [
          ...prev,
          {
            id: msgSeq++,
            role: 'bot',
            text: `⚠️ خطا در ارتباط با سرویس ربات:\n${(err as Error).message}`,
          },
        ])
      } finally {
        setSending(false)
        scrollToBottom()
      }
    },
    [telegramUserId, scrollToBottom],
  )

  // Health probe (once on mount)
  useEffect(() => {
    let alive = true
    api<{ ok: boolean }>('/api/bot/health')
      .then((d) => {
        if (alive) setServiceOk(Boolean(d.ok))
      })
      .catch(() => {
        if (alive) setServiceOk(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // Fresh /start whenever the simulated user changes (deferred to a microtask
  // so the latest telegramUserId closure is used)
  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => {
      if (alive) simulate({ text: '/start' })
    })
    return () => {
      alive = false
    }
  }, [simulate])

  function applyUserId() {
    const v = userIdDraft.trim() || 'sim-user-1'
    if (v === telegramUserId) {
      toast.info('این شناسه از قبل انتخاب شده است')
      return
    }
    setMessages([])
    setTelegramUserId(v)
    toast.info(`کاربر شبیه‌سازی به «${v}» تغییر کرد — گفتگوی تازه شروع می‌شود`)
  }

  async function sendText(e?: FormEvent | KeyboardEvent) {
    e?.preventDefault()
    const t = text.trim()
    if (!t || sending) return
    setText('')
    await simulate({ text: t }, t)
  }

  async function sendCallback(btn: BotKeyboardButton) {
    if (sending) return
    if (btn.callback_data) {
      await simulate({ callbackData: btn.callback_data }, btn.text)
    }
  }

  async function reset() {
    setMessages([])
    await simulate({ action: 'reset' })
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="size-4 text-emerald-600" aria-hidden />
          آزمایشگاه ربات
          <Badge
            variant="outline"
            className={cn(
              'text-xs',
              serviceOk === null
                ? 'bg-slate-100 text-slate-600 border-slate-200'
                : serviceOk
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-rose-50 text-rose-700 border-rose-200',
            )}
          >
            سرویس ربات: {serviceOk === null ? 'بررسی…' : serviceOk ? 'فعال' : 'غیرفعال'}
          </Badge>
        </CardTitle>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Input
              dir="ltr"
              className="h-8 w-36 text-left text-xs"
              value={userIdDraft}
              onChange={(e) => setUserIdDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyUserId()}
              placeholder="telegramUserId"
              aria-label="شناسه کاربر شبیه‌سازی"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={applyUserId}
              disabled={sending}
            >
              تغییر کاربر
            </Button>
          </div>
          <Button variant="ghost" size="icon" onClick={reset} disabled={sending} aria-label="بازنشانی گفتگو">
            <RotateCcw className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mx-auto flex max-w-md flex-col rounded-2xl border bg-muted/30 p-3">
          {/* Messages */}
          <div ref={scrollRef} className="flex h-96 flex-col gap-2.5 overflow-y-auto scroll-thin p-1" aria-live="polite">
            {messages.map((m) =>
              m.role === 'bot' ? (
                <div key={m.id} className="flex items-start gap-2">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <Send className="size-4" aria-hidden />
                  </span>
                  <div className="max-w-[85%]">
                    <div className="whitespace-pre-wrap break-words rounded-2xl rounded-ss-sm border bg-card px-3 py-2 text-sm leading-6 shadow-sm">
                      {m.text}
                    </div>
                    {m.keyboard && m.keyboard.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {m.keyboard.flat().map((btn, i) =>
                          btn.url ? (
                            <a
                              key={i}
                              href={btn.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex h-7 items-center gap-1 rounded-full border border-emerald-200 bg-card px-3 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50"
                            >
                              {btn.text}
                              <ExternalLink className="size-3" aria-hidden />
                            </a>
                          ) : (
                            <button
                              key={i}
                              type="button"
                              disabled={sending}
                              onClick={() => sendCallback(btn)}
                              className="inline-flex h-7 items-center rounded-full border border-emerald-200 bg-card px-3 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50"
                            >
                              {btn.text}
                            </button>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-ee-sm bg-slate-100 px-3 py-2 text-sm leading-6">
                    {m.text}
                  </div>
                </div>
              ),
            )}
            {sending && (
              <div className="flex items-center gap-2 ps-10 text-xs text-muted-foreground">
                <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-emerald-600" />
                ربات در حال نوشتن…
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((q) => (
              <button
                key={q.label}
                type="button"
                disabled={sending}
                onClick={() => simulate(q.body, q.label)}
                className="inline-flex h-7 items-center rounded-full border bg-card px-3 text-xs text-muted-foreground transition-colors hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"
              >
                {q.label}
              </button>
            ))}
          </div>

          {/* Input */}
          <form onSubmit={sendText} className="mt-2 flex items-center gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="پیامی به ربات بفرستید…"
              disabled={sending}
              aria-label="متن پیام به ربات"
            />
            <Button type="submit" size="icon" disabled={sending || !text.trim()} aria-label="ارسال پیام">
              <Send className="size-4" />
            </Button>
          </form>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            <Bot className="me-1 inline size-3" aria-hidden />
            این گفتگو روی ربات واقعی فروشگاه اجرا می‌شود (حالت شبیه‌سازی، بدون ارسال به تلگرام)
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
