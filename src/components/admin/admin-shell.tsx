'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AnimatePresence, motion } from 'framer-motion'
import {
  LayoutDashboard,
  Package,
  Tags,
  ShoppingCart,
  Users,
  Send,
  Sparkles,
  Settings,
  Menu,
  LogOut,
  KeyRound,
  Loader2,
  Bot,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, type TelegramInfo, type User } from '@/lib/client'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

// ---------------------------------------------------------------------------
// Section registry
// ---------------------------------------------------------------------------

export const SECTION_KEYS = [
  'dashboard',
  'products',
  'categories',
  'orders',
  'customers',
  'telegram',
  'ai',
  'settings',
] as const

export type SectionKey = (typeof SECTION_KEYS)[number]

export const SECTION_TITLES: Record<SectionKey, string> = {
  dashboard: 'داشبورد',
  products: 'مدیریت محصولات',
  categories: 'دسته‌بندی‌ها',
  orders: 'سفارش‌ها',
  customers: 'مشتریان',
  telegram: 'تلگرام و ربات',
  ai: 'ابزارهای هوش مصنوعی',
  settings: 'تنظیمات',
}

const NAV_ICONS: Record<SectionKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  products: Package,
  categories: Tags,
  orders: ShoppingCart,
  customers: Users,
  telegram: Send,
  ai: Sparkles,
  settings: Settings,
}

// ---------------------------------------------------------------------------
// AdminShell
// ---------------------------------------------------------------------------

export function AdminShell({
  user,
  section,
  onNavigate,
  onLogout,
  children,
}: {
  user: User
  section: SectionKey
  onNavigate: (s: SectionKey) => void
  onLogout: () => void
  children: ReactNode
}) {
  const [storeName, setStoreName] = useState('فروشگاه تلگرامی')
  const [mockMode, setMockMode] = useState<boolean | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)

  useEffect(() => {
    let alive = true
    api<{ settings: { storeName: string }; telegram: TelegramInfo }>('/api/settings')
      .then((d) => {
        if (!alive) return
        if (d.settings?.storeName) setStoreName(d.settings.storeName)
        setMockMode(Boolean(d.telegram?.mockMode))
      })
      .catch(() => {
        /* non-critical */
      })
    return () => {
      alive = false
    }
  }, [])

  function go(s: SectionKey) {
    onNavigate(s)
    setMobileOpen(false)
  }

  const navList = (
    <nav className="flex flex-col gap-1 p-3" aria-label="ناوبری اصلی">
      {SECTION_KEYS.map((key) => {
        const Icon = NAV_ICONS[key]
        const active = section === key
        return (
          <button
            key={key}
            type="button"
            onClick={() => go(key)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              active
                ? 'bg-emerald-50 font-medium text-emerald-700'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="size-4.5 shrink-0" aria-hidden />
            <span>{SECTION_TITLES[key]}</span>
          </button>
        )
      })}
    </nav>
  )

  const brand = (
    <div className="flex items-center gap-3 border-b px-4 py-4">
      <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Send className="size-5" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold">{storeName}</p>
        <p className="text-xs text-muted-foreground">پنل مدیریت</p>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen flex flex-col">
      <div className="flex flex-1">
        {/* Desktop sidebar (right side in RTL) */}
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-l bg-card/40 lg:flex">
          {brand}
          <div className="flex-1 overflow-y-auto scroll-thin">{navList}</div>
          <div className="border-t p-3">
            {mockMode !== null && (
              <Badge
                variant="outline"
                className={mockMode ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}
              >
                <Bot className="size-3" aria-hidden />
                {mockMode ? 'ربات: حالت شبیه‌سازی' : 'ربات: متصل به تلگرام'}
              </Badge>
            )}
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur md:px-6">
            {/* Mobile menu */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="باز کردن منو">
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72 p-0">
                <SheetHeader className="border-b p-0">
                  <SheetTitle className="sr-only">منوی ناوبری</SheetTitle>
                  {brand}
                </SheetHeader>
                {navList}
              </SheetContent>
            </Sheet>

            <span className="truncate text-sm font-semibold text-muted-foreground md:text-base">
              {SECTION_TITLES[section]}
            </span>

            <div className="ms-auto flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="gap-2 px-2"
                    aria-label="منوی کاربر"
                  >
                    <span className="flex size-8 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-700">
                      {(user.name || user.email || 'م').trim().charAt(0)}
                    </span>
                    <span className="hidden max-w-32 truncate text-sm md:inline">
                      {user.name || user.email}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <p className="text-sm font-medium">{user.name || 'مدیر فروشگاه'}</p>
                    <p dir="ltr" className="truncate text-xs font-normal text-muted-foreground">
                      {user.email}
                    </p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setPwOpen(true)}>
                    <KeyRound className="size-4" aria-hidden />
                    تغییر رمز عبور
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={onLogout}>
                    <LogOut className="size-4" aria-hidden />
                    خروج از حساب
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          <main className="flex-1 p-4 md:p-6">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={section}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </main>

          <footer className="mt-auto border-t py-4 text-center text-xs text-muted-foreground">
            پنل مدیریت فروشگاه تلگرامی — نسخه ۱.۰
          </footer>
        </div>
      </div>

      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Change password dialog (shared by header dropdown)
// ---------------------------------------------------------------------------

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
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
      onOpenChange(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>تغییر رمز عبور</DialogTitle>
          <DialogDescription>رمز جدید باید حداقل ۸ کاراکتر باشد.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pw-current">رمز عبور فعلی</Label>
            <Input
              id="pw-current"
              type="password"
              dir="ltr"
              className="text-left"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-next">رمز عبور جدید</Label>
            <Input
              id="pw-next"
              type="password"
              dir="ltr"
              className="text-left"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-confirm">تکرار رمز عبور جدید</Label>
            <Input
              id="pw-confirm"
              type="password"
              dir="ltr"
              className="text-left"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              انصراف
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              ذخیره
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
