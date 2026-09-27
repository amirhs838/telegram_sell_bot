'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SectionHeader,
  EmptyState,
  ErrorRetry,
  ConfirmDeleteDialog,
} from '@/components/admin/bits'
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Tags,
  Package,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, fmtDay, type Category } from '@/lib/client'

export function CategoriesSection() {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  const [deleting, setDeleting] = useState<Category | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api<{ categories: Category[] }>('/api/categories')
      setCategories(d.categories ?? [])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function openCreate() {
    setEditing(null)
    setName('')
    setDescription('')
    setDialogOpen(true)
  }

  function openEdit(c: Category) {
    setEditing(c)
    setName(c.name)
    setDescription(c.description ?? '')
    setDialogOpen(true)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      toast.error('نام دسته‌بندی را وارد کنید')
      return
    }
    setSaving(true)
    try {
      const body = JSON.stringify({
        name: name.trim(),
        description: description.trim() || undefined,
      })
      if (editing) {
        await api(`/api/categories/${editing.id}`, { method: 'PATCH', body })
        toast.success('دسته‌بندی به‌روزرسانی شد')
      } else {
        await api('/api/categories', { method: 'POST', body })
        toast.success('دسته‌بندی ساخته شد')
      }
      setDialogOpen(false)
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await api(`/api/categories/${deleting.id}`, { method: 'DELETE' })
      toast.success('دسته‌بندی حذف شد')
      setDeleting(null)
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setDeleteLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="دسته‌بندی‌ها"
        description="سازماندهی محصولات برای نمایش در ربات و کانال"
      >
        <Button onClick={openCreate}>
          <Plus className="size-4" aria-hidden />
          دسته‌بندی جدید
        </Button>
      </SectionHeader>

      {error ? (
        <Card className="rounded-xl shadow-sm">
          <ErrorRetry message={error} onRetry={load} />
        </Card>
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="h-5 w-28 animate-pulse rounded bg-muted" />
                <div className="h-5 w-10 animate-pulse rounded bg-muted" />
              </div>
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              <div className="mt-3 h-3 w-full animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : categories.length === 0 ? (
        <Card className="rounded-xl shadow-sm">
          <EmptyState
            icon={Tags}
            title="هنوز دسته‌بندی‌ای ساخته نشده"
            hint="دسته‌بندی‌ها به مشتریان ربات کمک می‌کنند محصولات را راحت‌تر پیدا کنند."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" aria-hidden />
                دسته‌بندی جدید
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {categories.map((c) => (
            <Card key={c.id} className="rounded-xl shadow-sm">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-semibold">{c.name}</h3>
                      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                        <Package className="size-3" aria-hidden />
                        {fmtNumberSafe(c.productCount)} محصول
                      </Badge>
                    </div>
                    <p dir="ltr" className="mt-1 text-start text-xs text-muted-foreground">
                      {c.slug}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`عملیات دسته ${c.name}`}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => openEdit(c)}>
                        <Pencil className="size-4" aria-hidden />
                        ویرایش
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(c)}>
                        <Trash2 className="size-4" aria-hidden />
                        حذف
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {c.description && (
                  <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{c.description}</p>
                )}
                <p className="mt-3 text-xs text-muted-foreground">ساخته شده: {fmtDay(c.createdAt)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'ویرایش دسته‌بندی' : 'دسته‌بندی جدید'}</DialogTitle>
            <DialogDescription>
              نام دسته باید کوتاه و گویا باشد؛ مثلاً «لوازم جانبی موبایل».
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="c-name">نام *</Label>
              <Input
                id="c-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً: پوشاک"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-desc">توضیحات</Label>
              <Textarea
                id="c-desc"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="اختیاری — توضیح کوتاه درباره این دسته"
              />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                انصراف
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {editing ? 'ذخیره تغییرات' : 'ایجاد دسته'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="حذف دسته‌بندی"
        description={
          deleting
            ? `آیا از حذف «${deleting.name}» مطمئن هستید؟ محصولات این دسته حذف نمی‌شوند اما بدون دسته می‌شوند.`
            : ''
        }
        loading={deleteLoading}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

function fmtNumberSafe(n: number): string {
  return new Intl.NumberFormat('fa-IR').format(n ?? 0)
}
