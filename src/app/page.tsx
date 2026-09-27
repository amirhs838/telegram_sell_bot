'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, type User } from '@/lib/client'
import { LoginView } from '@/components/admin/login-view'
import {
  AdminShell,
  SECTION_KEYS,
  type SectionKey,
} from '@/components/admin/admin-shell'
import { DashboardSection } from '@/components/admin/dashboard-section'
import { ProductsSection } from '@/components/admin/products-section'
import { CategoriesSection } from '@/components/admin/categories-section'
import { OrdersSection } from '@/components/admin/orders-section'
import { CustomersSection } from '@/components/admin/customers-section'
import { TelegramSection } from '@/components/admin/telegram-section'
import { AiSection } from '@/components/admin/ai-section'
import { SettingsSection } from '@/components/admin/settings-section'

function sectionFromHash(): SectionKey {
  if (typeof window === 'undefined') return 'dashboard'
  const h = window.location.hash.replace(/^#\/?/, '')
  return (SECTION_KEYS as readonly string[]).includes(h) ? (h as SectionKey) : 'dashboard'
}

export default function Home() {
  const [status, setStatus] = useState<'loading' | 'authed' | 'anon'>('loading')
  const [user, setUser] = useState<User | null>(null)
  // Lazy init from hash — before auth resolves only a splash is rendered, so no
  // hydration mismatch is possible (section is not in the DOM yet).
  const [section, setSection] = useState<SectionKey>(() => sectionFromHash())
  const unauthToasted = useRef(false)

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash())
    const onUnauthorized = () => {
      setUser(null)
      setStatus('anon')
      if (!unauthToasted.current) {
        unauthToasted.current = true
        toast.error('نشست شما منقضی شده است — دوباره وارد شوید')
        setTimeout(() => {
          unauthToasted.current = false
        }, 4000)
      }
    }

    window.addEventListener('hashchange', onHash)
    window.addEventListener('tcb:unauthorized', onUnauthorized)

    let alive = true
    api<{ user: User }>('/api/auth/me', undefined, { silent401: true })
      .then((d) => {
        if (!alive) return
        setUser(d.user)
        setStatus('authed')
      })
      .catch(() => {
        if (!alive) return
        setUser(null)
        setStatus('anon')
      })

    return () => {
      alive = false
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('tcb:unauthorized', onUnauthorized)
    }
  }, [])

  const navigate = useCallback((s: SectionKey) => {
    if (window.location.hash !== `#/${s}`) {
      window.location.hash = `#/${s}`
    } else {
      setSection(s)
    }
  }, [])

  function handleLoginSuccess(u: User) {
    setUser(u)
    setStatus('authed')
    if (!window.location.hash || window.location.hash !== '#/dashboard') {
      window.location.hash = '#/dashboard'
    }
    setSection('dashboard')
  }

  async function handleLogout() {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch {
      /* session may already be gone */
    }
    setUser(null)
    setStatus('anon')
    window.location.hash = '#/dashboard'
    toast.success('از حساب خارج شدید')
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground" role="status" aria-live="polite">
          <Loader2 className="size-8 animate-spin text-emerald-600" aria-hidden />
          <p className="text-sm">در حال بررسی نشست…</p>
        </div>
      </div>
    )
  }

  if (status === 'anon' || !user) {
    return <LoginView onSuccess={handleLoginSuccess} />
  }

  return (
    <AdminShell user={user} section={section} onNavigate={navigate} onLogout={handleLogout}>
      {section === 'dashboard' && <DashboardSection onNavigate={navigate} />}
      {section === 'products' && <ProductsSection />}
      {section === 'categories' && <CategoriesSection />}
      {section === 'orders' && <OrdersSection />}
      {section === 'customers' && <CustomersSection />}
      {section === 'telegram' && <TelegramSection />}
      {section === 'ai' && <AiSection />}
      {section === 'settings' && <SettingsSection />}
    </AdminShell>
  )
}
