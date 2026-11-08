'use client'

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  FolderTree,
  FolderOpen,
  ChevronDown,
  CornerDownLeft,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, fmtDay, type Category } from '@/lib/client'

// ─── Tree helpers (work at ANY depth) ────────────────────────────────────────

type CatNode = { cat: Category; children: CatNode[] }

/** Build a nested tree from the flat API list (orphaned subs are promoted). */
function buildTree(categories: Category[]): CatNode[] {
  const byParent = new Map<string, Category[]>()
  for (const c of categories) {
    const key = c.parentId && categories.some((p) => p.id === c.parentId) ? c.parentId : ''
    const list = byParent.get(key) ?? []
    list.push(c)
    byParent.set(key, list)
  }
  const nodeFor = (cat: Category): CatNode => ({
    cat,
    children: (byParent.get(cat.id) ?? []).map(nodeFor),
  })
  return (byParent.get('') ?? []).map(nodeFor)
}

/** Full path label like «سرمایه‌گذاری ← شمش نقره ← لیر» (RTL chain). */
function fullPathOf(categories: Category[], id: string): string {
  const parts: string[] = []
  let cursor = categories.find((c) => c.id === id)
  const guard = new Set<string>()
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id)
    parts.unshift(cursor.name)
    cursor = cursor.parentId ? categories.find((c) => c.id === cursor.parentId) : undefined
  }
  return parts.join(' ← ')
}

// ─── Recursive node row (shown inside each root card) ────────────────────────

function SubtreeRow({
  node,
  depth,
  expanded,
  toggleExpanded,
  onEdit,
  onAddSub,
  onDelete,
}: {
  node: CatNode
  depth: number
  expanded: Set<string>
  toggleExpanded: (id: string) => void
  onEdit: (c: Category) => void
  onAddSub: (c: Category) => void
  onDelete: (c: Category) => void
}) {
  const c = node.cat
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(c.id)
  return (
    <li>
      <div
        className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-background"
        style={{ paddingInlineStart: `${0.5 + depth * 1.1}rem` }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggleExpanded(c.id)}
              aria-expanded={isOpen}
              aria-label={isOpen ? `بستن زیر‌مجموعه‌های ${c.name}` : `نمایش زیر‌مجموعه‌های ${c.name}`}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronDown
                className={`size-3.5 transition-transform ${isOpen ? '' : 'rotate-90 rtl:rotate-[-90deg]'}`}
                aria-hidden
              />
            </button>
          ) : (
            <CornerDownLeft className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
          )}
          <span className="truncate text-sm">{c.name}</span>
          <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px]">
            <Package className="size-2.5" aria-hidden />
            {fmtNumberSafe(c.productCount)}
          </Badge>
        </span>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`افزودن زیر‌مجموعه به ${c.name}`}
            onClick={() => onAddSub(c)}
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`ویرایش ${c.name}`}
            onClick={() => onEdit(c)}
          >
            <Pencil className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-destructive hover:text-destructive"
            aria-label={`حذف ${c.name}`}
            onClick={() => onDelete(c)}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </span>
      </div>
      {hasChildren && isOpen && (
        <ul className="space-y-0.5">
          {node.children.map((child) => (
            <SubtreeRow
              key={child.cat.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
              onEdit={onEdit}
              onAddSub={onAddSub}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

// ─── Section ─────────────────────────────────────────────────────────────────

export function CategoriesSection() {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [parentId, setParentId] = useState<string>('root')
  const [saving, setSaving] = useState(false)

  const [deleting, setDeleting] = useState<Category | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  /** Expanded subtree nodes (per node id, shared across root cards). */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

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

  const tree = useMemo(() => buildTree(categories), [categories])

  /** Self + all descendants — excluded from the parent picker (cycle guard). */
  const selfAndDescendants = useCallback(
    (id: string): Set<string> => {
      const blocked = new Set<string>([id])
      let grew = true
      while (grew) {
        grew = false
        for (const c of categories) {
          if (c.parentId && blocked.has(c.parentId) && !blocked.has(c.id)) {
            blocked.add(c.id)
            grew = true
          }
        }
      }
      return blocked
    },
    [categories],
  )

  /** Expand every ancestor chain of `id` so a saved node stays visible. */
  const expandAncestorsOf = useCallback(
    (id: string) => {
      const toExpand = new Set<string>()
      let cursor = categories.find((c) => c.id === id)
      const guard = new Set<string>()
      while (cursor?.parentId && !guard.has(cursor.parentId)) {
        guard.add(cursor.parentId)
        toExpand.add(cursor.parentId)
        cursor = categories.find((c) => c.id === cursor.parentId)
      }
      if (toExpand.size > 0) {
        setExpanded((prev) => new Set([...prev, ...toExpand]))
      }
    },
    [categories],
  )

  function openCreate(parent: Category | null = null) {
    setEditing(null)
    setName('')
    setDescription('')
    setParentId(parent ? parent.id : 'root')
    setDialogOpen(true)
  }

  function openEdit(c: Category) {
    setEditing(c)
    setName(c.name)
    setDescription(c.description ?? '')
    setParentId(c.parentId ?? 'root')
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
        parentId: parentId === 'root' ? null : parentId,
      })
      if (editing) {
        await api(`/api/categories/${editing.id}`, { method: 'PATCH', body })
        toast.success('دسته‌بندی به‌روزرسانی شد')
      } else {
        await api('/api/categories', { method: 'POST', body })
        toast.success(
          parentId === 'root' ? 'دسته‌بندی اصلی ساخته شد' : 'زیر‌مجموعه ساخته شد',
        )
      }
      setDialogOpen(false)
      expandAncestorsOf(parentId === 'root' ? '' : parentId)
      await load()
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

  // Parent choices exclude the category itself + its descendants (cycle guard).
  const dialogParentChoices = useMemo(
    () =>
      (editing
        ? categories.filter((c) => !selfAndDescendants(c.id).has(c.id))
        : categories
      ).slice(),
    [categories, editing, selfAndDescendants],
  )

  return (
    <div className="space-y-4">
      <SectionHeader
        title="دسته‌بندی‌ها"
        description="سازماندهی محصولات برای نمایش در ربات — هر دسته در هر سطحی می‌تواند زیر‌مجموعهٔ خودش را داشته باشد (بدون محدودیت تعداد لایه)"
      >
        <Button onClick={() => openCreate()}>
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
            hint="دسته‌بندی‌ها به مشتریان ربات کمک می‌کنند محصولات را راحت‌تر پیدا کنند. مثلاً «سرمایه‌گذاری» بسازید و برایش زیر‌مجموعه اضافه کنید؛ مشتری در ربات پله‌پله وارد زیر‌مجموعه‌ها می‌شود تا به محصولات برسد."
            action={
              <Button size="sm" onClick={() => openCreate()}>
                <Plus className="size-4" aria-hidden />
                دسته‌بندی جدید
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {tree.map((root) => {
            const c = root.cat
            const countAll = (n: CatNode): number =>
              n.children.reduce((s, ch) => s + countAll(ch), n.children.length)
            const subCount = countAll(root)
            return (
              <Card key={c.id} className="flex flex-col rounded-xl shadow-sm">
                <CardContent className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="flex items-center gap-1.5 truncate font-semibold">
                        <FolderOpen className="size-4 shrink-0 text-amber-600" aria-hidden />
                        {c.name}
                      </h3>
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
                        <DropdownMenuItem onSelect={() => openCreate(c)}>
                          <FolderTree className="size-4" aria-hidden />
                          افزودن زیر‌مجموعه
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(c)}>
                          <Trash2 className="size-4" aria-hidden />
                          حذف
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {c.description && (
                    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{c.description}</p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                      <Package className="size-3" aria-hidden />
                      {fmtNumberSafe(c.productCount)} محصول
                    </Badge>
                    {subCount > 0 && (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                        <FolderTree className="size-3" aria-hidden />
                        {fmtNumberSafe(subCount)} زیر‌مجموعه
                      </Badge>
                    )}
                  </div>

                  {/* FULL recursive subtree — any depth, collapsible */}
                  <div className="mt-3 rounded-lg border bg-muted/40 p-2">
                    <p className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">
                      زیر‌مجموعه‌ها (تمام سطوح)
                    </p>
                    <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                      {root.children.map((child) => (
                        <SubtreeRow
                          key={child.cat.id}
                          node={child}
                          depth={0}
                          expanded={expanded}
                          toggleExpanded={toggleExpanded}
                          onEdit={openEdit}
                          onAddSub={openCreate}
                          onDelete={setDeleting}
                        />
                      ))}
                    </ul>
                  </div>

                  <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                    <p className="text-xs text-muted-foreground">ساخته شده: {fmtDay(c.createdAt)}</p>
                    <Button variant="outline" size="sm" onClick={() => openCreate(c)}>
                      <Plus className="size-3.5" aria-hidden />
                      زیر‌مجموعه
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? 'ویرایش دسته‌بندی'
                : parentId === 'root'
                  ? 'دسته‌بندی جدید'
                  : 'زیر‌مجموعهٔ جدید'}
            </DialogTitle>
            <DialogDescription>
              نام دسته باید کوتاه و گویا باشد؛ مثلاً «شمش نقره». می‌توانید این دسته را زیر هر دستهٔ
              دیگری (در هر سطحی) قرار دهید.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="c-name">نام *</Label>
              <Input
                id="c-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً: شمش نقره"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>دستهٔ والد</Label>
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="انتخاب کنید" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  <SelectItem value="root">— دستهٔ اصلی (بدون والد) —</SelectItem>
                  {dialogParentChoices.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {fullPathOf(categories, c.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                اگر دستهٔ والد انتخاب شود، این دسته به‌عنوان زیر‌مجموعه در صفحهٔ همان دسته در ربات
                نمایش داده می‌شود؛ مشتری با لمس آن وارد این بخش می‌شود.
              </p>
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
                {editing ? 'ذخیره تغییرات' : parentId === 'root' ? 'ایجاد دسته' : 'ایجاد زیر‌مجموعه'}
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
            ? `آیا از حذف «${deleting.name}» مطمئن هستید؟ محصولات این دسته حذف نمی‌شوند اما بدون دسته می‌شوند؛ زیر‌مجموعه‌های این دسته به سطح اصلی منتقل می‌شوند.`
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
