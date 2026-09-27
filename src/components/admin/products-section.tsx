'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
  ProductStatusBadge,
  MoneyText,
  EmptyState,
  ErrorRetry,
  TableSkeleton,
  ConfirmDeleteDialog,
  useDebounced,
} from '@/components/admin/bits'
import { ProductFormDialog } from '@/components/admin/product-form-dialog'
import {
  Plus,
  Search,
  MoreHorizontal,
  Pencil,
  Send,
  SendHorizontal,
  Power,
  Trash2,
  Package,
  PackageOpen,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  qs,
  fmtDate,
  fmtNumber,
  type Category,
  type Product,
  type ProductStatus,
} from '@/lib/client'

const PAGE_SIZE = 20

const SORT_OPTIONS = [
  { value: 'createdAt:desc', label: 'جدیدترین' },
  { value: 'createdAt:asc', label: 'قدیمی‌ترین' },
  { value: 'price:desc', label: 'گران‌ترین' },
  { value: 'price:asc', label: 'ارزان‌ترین' },
  { value: 'stock:asc', label: 'کم‌موجودترین' },
  { value: 'stock:desc', label: 'پرموجودترین' },
  { value: 'name:asc', label: 'نام (الفبا)' },
]

export function ProductsSection() {
  const [products, setProducts] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [categories, setCategories] = useState<Category[]>([])

  const [searchInput, setSearchInput] = useState('')
  const search = useDebounced(searchInput, 300)
  const [status, setStatus] = useState<string>('all')
  const [categoryId, setCategoryId] = useState<string>('all')
  const [sort, setSort] = useState('createdAt:desc')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState<Product | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sortKey, sortDir] = sort.split(':')
      const d = await api<{ items: Product[]; total: number }>(
        `/api/products${qs({
          search,
          status: status === 'all' ? '' : status,
          categoryId: categoryId === 'all' ? '' : categoryId,
          sort: sortKey,
          order: sortDir,
          page,
          pageSize: PAGE_SIZE,
        })}`,
      )
      setProducts(d.items ?? [])
      setTotal(d.total ?? 0)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [search, status, categoryId, sort, page])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    api<{ categories: Category[] }>('/api/categories')
      .then((d) => setCategories(d.categories ?? []))
      .catch(() => {
        /* filter list is non-critical */
      })
  }, [])

  function resetToFirst() {
    setPage(1)
  }

  async function toggleStatus(p: Product) {
    const next: ProductStatus = p.status === 'active' ? 'inactive' : 'active'
    setBusyId(p.id)
    try {
      await api(`/api/products/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      })
      toast.success(next === 'active' ? 'محصول فعال شد' : 'محصول غیرفعال شد')
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function publish(p: Product) {
    setBusyId(p.id)
    try {
      await api(`/api/products/${p.id}/publish`, { method: 'POST' })
      toast.success('محصول در کانال منتشر شد')
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function unpublish(p: Product) {
    setBusyId(p.id)
    try {
      await api(`/api/products/${p.id}/unpublish`, { method: 'POST' })
      toast.success('انتشار محصول در کانال حذف شد')
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await api(`/api/products/${deleting.id}`, { method: 'DELETE' })
      toast.success('محصول حذف شد')
      setDeleting(null)
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setDeleteLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-4">
      <SectionHeader title="مدیریت محصولات" description="ایجاد، ویرایش و انتشار محصولات در کانال تلگرام">
        <Button
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
        >
          <Plus className="size-4" aria-hidden />
          محصول جدید
        </Button>
      </SectionHeader>

      {/* Toolbar */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative flex-1 md:max-w-xs">
          <Search className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value)
              resetToFirst()
            }}
            placeholder="جستجوی محصول…"
            className="ps-8"
            aria-label="جستجوی محصول"
          />
        </div>
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v)
            resetToFirst()
          }}
        >
          <SelectTrigger className="w-full md:w-36" aria-label="فیلتر وضعیت">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">همه وضعیت‌ها</SelectItem>
            <SelectItem value="active">فعال</SelectItem>
            <SelectItem value="draft">پیش‌نویس</SelectItem>
            <SelectItem value="inactive">غیرفعال</SelectItem>
            <SelectItem value="out_of_stock">ناموجود</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={categoryId}
          onValueChange={(v) => {
            setCategoryId(v)
            resetToFirst()
          }}
        >
          <SelectTrigger className="w-full md:w-40" aria-label="فیلتر دسته‌بندی">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">همه دسته‌ها</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sort}
          onValueChange={(v) => {
            setSort(v)
            resetToFirst()
          }}
        >
          <SelectTrigger className="w-full md:w-36" aria-label="ترتیب نمایش">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card className="overflow-hidden rounded-xl shadow-sm">
        {error ? (
          <ErrorRetry message={error} onRetry={load} />
        ) : loading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : products.length === 0 ? (
          <EmptyState
            icon={search || status !== 'all' || categoryId !== 'all' ? Search : PackageOpen}
            title="محصولی یافت نشد"
            hint={
              search || status !== 'all' || categoryId !== 'all'
                ? 'فیلترها را تغییر دهید یا عبارت دیگری جستجو کنید.'
                : 'اولین محصول خود را بسازید تا در کانال تلگرام منتشر شود.'
            }
            action={
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null)
                  setFormOpen(true)
                }}
              >
                <Plus className="size-4" aria-hidden />
                محصول جدید
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>محصول</TableHead>
                  <TableHead>دسته</TableHead>
                  <TableHead>قیمت</TableHead>
                  <TableHead>موجودی</TableHead>
                  <TableHead>وضعیت</TableHead>
                  <TableHead className="text-center">تلگرام</TableHead>
                  <TableHead>تاریخ</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {p.imageUrl ? (
                          <img
                            src={p.imageUrl}
                            alt={p.name}
                            className="size-10 shrink-0 rounded-lg border object-cover"
                          />
                        ) : (
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <Package className="size-4 text-muted-foreground" aria-hidden />
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="max-w-56 truncate text-sm font-medium">{p.name}</p>
                          <p dir="ltr" className="max-w-56 truncate text-start text-xs text-muted-foreground">
                            {p.slug}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {p.category ? (
                        <Badge variant="secondary">{p.category.name}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <MoneyText value={p.price} className="text-sm" />
                    </TableCell>
                    <TableCell>
                      <StockBadge stock={p.stock} />
                    </TableCell>
                    <TableCell>
                      <ProductStatusBadge status={p.status} />
                    </TableCell>
                    <TableCell className="text-center">
                      {p.telegramPost ? (
                        <Send className="mx-auto size-4 text-emerald-600" aria-label="منتشر شده در کانال" />
                      ) : (
                        <Send className="mx-auto size-4 text-muted-foreground/40" aria-label="منتشر نشده" />
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {fmtDate(p.createdAt)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busyId === p.id}
                            aria-label={`عملیات محصول ${p.name}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onSelect={() => {
                              setEditing(p)
                              setFormOpen(true)
                            }}
                          >
                            <Pencil className="size-4" aria-hidden />
                            ویرایش
                          </DropdownMenuItem>
                          {p.telegramPost ? (
                            <DropdownMenuItem onSelect={() => unpublish(p)}>
                              <SendHorizontal className="size-4" aria-hidden />
                              حذف انتشار
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onSelect={() => publish(p)}>
                              <Send className="size-4" aria-hidden />
                              انتشار در کانال
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => toggleStatus(p)}>
                            <Power className="size-4" aria-hidden />
                            {p.status === 'active' ? 'غیرفعال کردن' : 'فعال کردن'}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setDeleting(p)}
                          >
                            <Trash2 className="size-4" aria-hidden />
                            حذف
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Pagination */}
      {!loading && !error && total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            صفحه {fmtNumber(page)} از {fmtNumber(totalPages)} — مجموع {fmtNumber(total)} محصول
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              aria-label="صفحه بعد"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              aria-label="صفحه قبل"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <ProductFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        product={editing}
        categories={categories}
        onSaved={load}
      />

      {/* Delete confirm is rendered by parent via ConfirmDeleteDialog */}
      <DeleteConfirm
        open={Boolean(deleting)}
        productName={deleting?.name ?? ''}
        loading={deleteLoading}
        onOpenChange={(o) => !o && setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

function StockBadge({ stock }: { stock: number }) {
  if (stock <= 0)
    return <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">ناموجود</Badge>
  if (stock <= 5)
    return (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
        {fmtNumber(stock)} عدد
      </Badge>
    )
  return (
    <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200">
      {fmtNumber(stock)} عدد
    </Badge>
  )
}

// Local thin wrapper around ConfirmDeleteDialog
function DeleteConfirm({
  open,
  productName,
  loading,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  productName: string
  loading: boolean
  onOpenChange: (o: boolean) => void
  onConfirm: () => void
}) {
  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      title="حذف محصول"
      description={`آیا از حذف «${productName}» مطمئن هستید؟ این عمل قابل بازگشت نیست و پست مرتبط در کانال نیز حذف می‌شود.`}
      loading={loading}
      onConfirm={onConfirm}
    />
  )
}
