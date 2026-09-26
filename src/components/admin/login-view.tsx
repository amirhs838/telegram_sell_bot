'use client'

import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Loader2, Send, Info } from 'lucide-react'
import { toast } from 'sonner'
import { api, type User } from '@/lib/client'

export function LoginView({ onSuccess }: { onSuccess: (user: User) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) {
      toast.error('ایمیل و رمز عبور را وارد کنید')
      return
    }
    setSubmitting(true)
    try {
      // silent401: a failed login attempt is NOT an expired session — show the
      // server's own Persian message («ایمیل یا رمز عبور اشتباه است») instead.
      const res = await api<{ user: User }>(
        '/api/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({ email: email.trim(), password }),
        },
        { silent401: true },
      )
      toast.success(`خوش آمدید، ${res.user.name || 'مدیر'} 👋`)
      onSuccess(res.user)
    } catch (err) {
      toast.error((err as Error).message || 'ورود ناموفق بود')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-emerald-50 via-white to-teal-50 p-4">
      <Card className="w-full max-w-sm rounded-xl border shadow-sm">
        <CardContent className="p-6">
          <div className="flex flex-col items-center text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <Send className="size-7" aria-hidden />
            </span>
            <h1 className="mt-4 text-xl font-bold">فروشگاه تلگرامی</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              برای ورود به پنل مدیریت، اطلاعات حساب خود را وارد کنید
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="email">ایمیل</Label>
              <Input
                id="email"
                type="email"
                dir="ltr"
                className="text-left"
                placeholder="admin@shop.local"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">رمز عبور</Label>
              <Input
                id="password"
                type="password"
                dir="ltr"
                className="text-left"
                placeholder="••••••••"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  در حال ورود…
                </>
              ) : (
                'ورود به پنل مدیریت'
              )}
            </Button>
          </form>

          <div className="mt-5 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-800">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <p>
              حساب پیش‌فرض: <span dir="ltr" className="font-medium">admin@shop.local</span> /{' '}
              <span dir="ltr" className="font-medium">admin1234</span>
            </p>
          </div>
        </CardContent>
      </Card>

      <p className="mt-6 text-xs text-muted-foreground">
        پنل مدیریت فروشگاه تلگرامی — نسخه ۱.۰
      </p>
    </div>
  )
}
