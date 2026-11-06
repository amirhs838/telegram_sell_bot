'use client'

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { AiSuggestionList } from '@/components/admin/ai-suggestion'
import {
  Loader2,
  Sparkles,
  Upload,
  ImagePlus,
  Bot,
  Gem,
  Star,
  Trash2,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type AiSuggestion,
  type Category,
  type Product,
  type ProductImageInput,
  type ProductStatus,
} from '@/lib/client'
import { cn } from '@/lib/utils'

type FormState = {
  name: string
  categoryId: string
  price: string
  compareAtPrice: string
  stock: string
  status: ProductStatus
  shortDescription: string
  description: string
  tags: string
  // Silver spec (optional)
  productCode: string
  silverType: string
  fineness: string
  weightGrams: string
  size: string
  dimensions: string
  brand: string
  appearance: string
  careInstructions: string
  authenticityNote: string
}

const EMPTY_FORM: FormState = {
  name: '',
  categoryId: 'none',
  price: '',
  compareAtPrice: '',
  stock: '0',
  status: 'draft',
  shortDescription: '',
  description: '',
  tags: '',
  productCode: '',
  silverType: '',
  fineness: '',
  weightGrams: '',
  size: '',
  dimensions: '',
  brand: '',
  appearance: '',
  careInstructions: '',
  authenticityNote: '',
}

type GalleryImage = { url: string; isPrimary: boolean; sortOrder: number }

function seedImages(p: Product | null): GalleryImage[] {
  if (p?.images?.length) {
    return [...p.images]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((im) => ({ url: im.url, isPrimary: im.isPrimary, sortOrder: im.sortOrder }))
  }
  // Legacy single image becomes the first gallery entry
  if (p?.imageUrl) return [{ url: p.imageUrl, isPrimary: true, sortOrder: 0 }]
  return []
}

function toForm(p: Product | null): FormState {
  if (!p) return { ...EMPTY_FORM }
  return {
    name: p.name ?? '',
    categoryId: p.categoryId ?? 'none',
    price: String(p.price ?? 0),
    compareAtPrice: p.compareAtPrice != null ? String(p.compareAtPrice) : '',
    stock: String(p.stock ?? 0),
    status: p.status ?? 'draft',
    shortDescription: p.shortDescription ?? '',
    description: p.description ?? '',
    tags: (p.tags ?? []).join('، '),
    productCode: p.productCode ?? '',
    silverType: p.silverType ?? '',
    fineness: p.fineness != null ? String(p.fineness) : '',
    weightGrams: p.weightGrams != null ? String(p.weightGrams) : '',
    size: p.size ?? '',
    dimensions: p.dimensions ?? '',
    brand: p.brand ?? '',
    appearance: p.appearance ?? '',
    careInstructions: p.careInstructions ?? '',
    authenticityNote: p.authenticityNote ?? '',
  }
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,،]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

export function ProductFormDialog({
  open,
  onOpenChange,
  product,
  categories,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  product: Product | null
  categories: Category[]
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [images, setImages] = useState<GalleryImage[]>([])
  const [specsOpen, setSpecsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [roughInfo, setRoughInfo] = useState('')
  const [generating, setGenerating] = useState(false)
  const [suggestion, setSuggestion] = useState<AiSuggestion | null>(null)
  const [uploading, setUploading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const isEdit = Boolean(product)

  useEffect(() => {
    if (open) {
      setForm(toForm(product))
      setImages(seedImages(product))
      setSuggestion(null)
      setRoughInfo('')
      setSpecsOpen(false)
      setPreviewUrl(null)
    }
  }, [open, product])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  // ---------------------------------------------------------------------------
  // Gallery manager helpers
  // ---------------------------------------------------------------------------

  async function uploadImages(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    setUploading(true)
    let ok = 0
    try {
      for (let i = 0; i < files.length; i++) {
        const fd = new FormData()
        fd.append('file', files[i])
        try {
          const res = await api<{ url: string; name: string; size: number }>('/api/uploads', {
            method: 'POST',
            body: fd,
          })
          setImages((prev) => {
            const next = [...prev, { url: res.url, isPrimary: prev.length === 0, sortOrder: prev.length }]
            return next
          })
          ok++
        } catch (err) {
          toast.error(`آپلود فایل ${i + 1} ناموفق بود: ${(err as Error).message}`)
        }
      }
      if (ok > 0) toast.success(`${ok} تصویر آپلود شد`)
    } finally {
      setUploading(false)
    }
  }

  function makePrimary(index: number) {
    setImages((prev) => prev.map((im, i) => ({ ...im, isPrimary: i === index })))
  }

  function moveImage(index: number, dir: -1 | 1) {
    setImages((prev) => {
      const target = index + dir
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next.map((im, i) => ({ ...im, sortOrder: i }))
    })
  }

  function removeImage(index: number) {
    setImages((prev) => {
      const next = prev.filter((_, i) => i !== index)
      // keep exactly one primary when possible
      if (!next.some((im) => im.isPrimary) && next.length > 0) next[0] = { ...next[0], isPrimary: true }
      return next.map((im, i) => ({ ...im, sortOrder: i }))
    })
  }

  // ---------------------------------------------------------------------------
  // AI content generation (untouched panel)
  // ---------------------------------------------------------------------------

  async function generate() {
    if (roughInfo.trim().length < 10) {
      toast.error('اطلاعات خام را بیشتر توضیح دهید (حداقل ۱۰ کاراکتر)')
      return
    }
    setGenerating(true)
    try {
      const res = await api<{ suggestion: AiSuggestion }>('/api/ai/generate-content', {
        method: 'POST',
        body: JSON.stringify({ roughInfo: roughInfo.trim() }),
      })
      setSuggestion(res.suggestion)
      toast.success('محتوا تولید شد — آن را بررسی و اعمال کنید')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  function applyField(key: string, value: string) {
    switch (key) {
      case 'title':
        set('name', value)
        break
      case 'shortDescription':
        set('shortDescription', value)
        break
      case 'description':
        set('description', value)
        break
      case 'tags':
        set('tags', value)
        break
      case 'categorySuggestion': {
        const cat = categories.find((c) => c.name.trim() === value.trim())
        if (cat) {
          set('categoryId', cat.id)
          toast.success(`دسته «${cat.name}» اعمال شد`)
        } else {
          toast.info(`دسته‌ای با نام «${value}» یافت نشد — آن را دستی انتخاب کنید`)
        }
        break
      }
      default:
        break
    }
  }

  function applyAll() {
    if (!suggestion) return
    applyField('title', suggestion.title)
    applyField('shortDescription', suggestion.shortDescription)
    applyField('description', suggestion.description)
    if ((suggestion.tags ?? []).length) set('tags', suggestion.tags.join('، '))
    const cat = categories.find(
      (c) => c.name.trim() === (suggestion.categorySuggestion ?? '').trim(),
    )
    if (cat) set('categoryId', cat.id)
    toast.success('پیشنهادها روی فرم اعمال شد (قیمت و موجودی دست‌نخورده ماند)')
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  async function save() {
    const name = form.name.trim()
    if (!name) {
      toast.error('نام محصول الزامی است')
      return
    }
    const price = Number(form.price)
    if (!Number.isFinite(price) || price < 0) {
      toast.error('قیمت معتبر وارد کنید')
      return
    }
    const stock = Math.max(0, Math.floor(Number(form.stock) || 0))
    const compareAtPrice = form.compareAtPrice.trim() ? Number(form.compareAtPrice) : null
    if (compareAtPrice !== null && (!Number.isFinite(compareAtPrice) || compareAtPrice < 0)) {
      toast.error('قیمت قبل از تخفیف معتبر نیست')
      return
    }
    const fineness = form.fineness.trim() ? Number(form.fineness) : null
    if (fineness !== null && !Number.isFinite(fineness)) {
      toast.error('عیار معتبر وارد کنید')
      return
    }
    const weightGrams = form.weightGrams.trim() ? Number(form.weightGrams) : null
    if (weightGrams !== null && !Number.isFinite(weightGrams)) {
      toast.error('وزن معتبر وارد کنید')
      return
    }

    const payload = {
      name,
      categoryId: form.categoryId && form.categoryId !== 'none' ? form.categoryId : null,
      price,
      compareAtPrice,
      stock,
      status: form.status,
      shortDescription: form.shortDescription.trim() || null,
      description: form.description.trim() || null,
      tags: parseTags(form.tags),
      // gallery wins — legacy imageUrl is intentionally not sent
      images: images.map<ProductImageInput>((im, i) => ({
        url: im.url,
        isPrimary: im.isPrimary,
        sortOrder: i,
      })),
      // silver specs (null when empty)
      productCode: form.productCode.trim() || null,
      silverType: form.silverType.trim() || null,
      fineness,
      weightGrams,
      size: form.size.trim() || null,
      dimensions: form.dimensions.trim() || null,
      brand: form.brand.trim() || null,
      appearance: form.appearance.trim() || null,
      careInstructions: form.careInstructions.trim() || null,
      authenticityNote: form.authenticityNote.trim() || null,
    }

    setSaving(true)
    try {
      if (isEdit && product) {
        await api(`/api/products/${product.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        })
        toast.success('محصول به‌روزرسانی شد')
      } else {
        await api('/api/products', { method: 'POST', body: JSON.stringify(payload) })
        toast.success('محصول ساخته شد')
      }
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const statusOptions: { value: ProductStatus; label: string }[] = [
    { value: 'draft', label: 'پیش‌نویس' },
    { value: 'active', label: 'فعال' },
    { value: 'inactive', label: 'غیرفعال' },
  ]
  if (product?.status === 'out_of_stock') {
    statusOptions.push({ value: 'out_of_stock', label: 'ناموجود' })
  }
  if (form.status === 'out_of_stock' && !statusOptions.some((o) => o.value === 'out_of_stock')) {
    statusOptions.push({ value: 'out_of_stock', label: 'ناموجود' })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'ویرایش محصول' : 'محصول جدید'}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'اطلاعات محصول را ویرایش کنید.' : 'اطلاعات محصول جدید را وارد کنید.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Basic fields */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="p-name">نام محصول *</Label>
              <Input
                id="p-name"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="مثلاً: گردنبند نقره زنانه قلب"
              />
            </div>
            <div className="space-y-1.5">
              <Label>دسته‌بندی</Label>
              <Select value={form.categoryId} onValueChange={(v) => set('categoryId', v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="انتخاب دسته" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">بدون دسته</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-price">قیمت نهایی (تومان) *</Label>
              <Input
                id="p-price"
                dir="ltr"
                className="text-left"
                type="number"
                min={0}
                value={form.price}
                onChange={(e) => set('price', e.target.value)}
                placeholder="1500000"
              />
              <p className="text-xs text-muted-foreground">
                قیمت را دستی وارد کنید — سیستم هیچ محاسبه‌ای انجام نمی‌دهد
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-compare">قیمت قبل از تخفیف (تومان)</Label>
              <Input
                id="p-compare"
                dir="ltr"
                className="text-left"
                type="number"
                min={0}
                value={form.compareAtPrice}
                onChange={(e) => set('compareAtPrice', e.target.value)}
                placeholder="1800000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-stock">موجودی</Label>
              <Input
                id="p-stock"
                dir="ltr"
                className="text-left"
                type="number"
                min={0}
                value={form.stock}
                onChange={(e) => set('stock', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>وضعیت</Label>
              <Select
                value={form.status}
                onValueChange={(v) => set('status', v as ProductStatus)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="p-short">توضیح کوتاه</Label>
              <Textarea
                id="p-short"
                rows={2}
                value={form.shortDescription}
                onChange={(e) => set('shortDescription', e.target.value)}
                placeholder="یک یا دو جمله معرفی محصول…"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="p-desc">توضیح کامل</Label>
              <Textarea
                id="p-desc"
                rows={5}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="p-tags">برچسب‌ها (با ویرگول جدا کنید)</Label>
              <Input
                id="p-tags"
                value={form.tags}
                onChange={(e) => set('tags', e.target.value)}
                placeholder="نقره، گردنبند، هدیه"
              />
            </div>

            {/* Gallery manager */}
            <div className="space-y-2 md:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>تصاویر محصول</Label>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="sr-only"
                  onChange={uploadImages}
                  aria-label="انتخاب چند تصویر برای آپلود"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <ImagePlus className="size-4" aria-hidden />
                  )}
                  {uploading ? 'در حال آپلود…' : 'افزودن تصاویر'}
                </Button>
              </div>

              {images.length === 0 ? (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="flex min-h-24 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:border-emerald-300 hover:bg-emerald-50/40 focus-visible:ring-2 focus-visible:ring-ring/50 outline-none disabled:opacity-60"
                >
                  {uploading ? (
                    <Loader2 className="size-5 animate-spin text-emerald-600" aria-hidden />
                  ) : (
                    <Upload className="size-5" aria-hidden />
                  )}
                  {uploading ? 'در حال آپلود تصاویر…' : 'برای افزودن تصویر کلیک کنید (چندتایی پشتیبانی می‌شود)'}
                  <span className="text-xs">JPG، PNG، WebP یا GIF — حداکثر ۵ مگابایت</span>
                </button>
              ) : (
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                  {images.map((im, i) => (
                    <li
                      key={`${im.url}-${i}`}
                      className="group relative aspect-square overflow-hidden rounded-lg border bg-muted/40"
                    >
                      <img
                        src={im.url}
                        alt={`تصویر ${i + 1} محصول`}
                        className="size-full cursor-zoom-in object-cover"
                        onClick={() => setPreviewUrl(im.url)}
                      />
                      {im.isPrimary && (
                        <Badge className="absolute start-1 top-1 gap-1 bg-emerald-600 px-1.5 py-0 text-[10px] text-white hover:bg-emerald-600">
                          <Star className="size-2.5" aria-hidden />
                          تصویر اصلی
                        </Badge>
                      )}
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-black/55 p-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => makePrimary(i)}
                          className={cn(
                            'flex size-7 items-center justify-center rounded text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 outline-none',
                            im.isPrimary && 'text-amber-300',
                          )}
                          aria-label={im.isPrimary ? 'تصویر اصلی' : 'تنظیم به‌عنوان تصویر اصلی'}
                        >
                          <Star className="size-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveImage(i, -1)}
                          disabled={i === 0}
                          className="flex size-7 items-center justify-center rounded text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 outline-none disabled:opacity-40"
                          aria-label="جابجایی به سمت راست"
                        >
                          <ChevronRight className="size-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveImage(i, 1)}
                          disabled={i === images.length - 1}
                          className="flex size-7 items-center justify-center rounded text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 outline-none disabled:opacity-40"
                          aria-label="جابجایی به سمت چپ"
                        >
                          <ChevronLeft className="size-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeImage(i)}
                          className="flex size-7 items-center justify-center rounded text-white transition-colors hover:bg-rose-600/80 focus-visible:ring-2 focus-visible:ring-white/60 outline-none"
                          aria-label="حذف تصویر"
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                با ستاره، تصویر اصلی را انتخاب کنید؛ با فلش‌ها ترتیب را تغییر دهید. ذخیره نهایی با دکمه پایین فرم انجام می‌شود.
              </p>
            </div>
          </div>

          {/* Silver specs (optional) */}
          <Collapsible open={specsOpen} onOpenChange={setSpecsOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="w-full justify-between"
                aria-expanded={specsOpen}
              >
                <span className="flex items-center gap-2">
                  <Gem className="size-4 text-emerald-600" aria-hidden />
                  مشخصات نقره (اختیاری)
                </span>
                <ChevronDown
                  className={cn('size-4 transition-transform', specsOpen && 'rotate-180')}
                  aria-hidden
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-3 grid grid-cols-1 gap-4 rounded-xl border p-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="p-code">کد محصول</Label>
                  <Input
                    id="p-code"
                    dir="ltr"
                    className="text-left"
                    value={form.productCode}
                    onChange={(e) => set('productCode', e.target.value)}
                    placeholder="SL-1024"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-silver-type">نوع نقره</Label>
                  <Input
                    id="p-silver-type"
                    value={form.silverType}
                    onChange={(e) => set('silverType', e.target.value)}
                    placeholder="مثلاً: نقره استرلینگ"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-fineness">عیار</Label>
                  <Input
                    id="p-fineness"
                    dir="ltr"
                    className="text-left"
                    type="number"
                    min={0}
                    max={1000}
                    value={form.fineness}
                    onChange={(e) => set('fineness', e.target.value)}
                    placeholder="925"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-weight">وزن (گرم)</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="p-weight"
                      dir="ltr"
                      className="text-left"
                      type="number"
                      min={0}
                      step={0.1}
                      value={form.weightGrams}
                      onChange={(e) => set('weightGrams', e.target.value)}
                      placeholder="12.5"
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">گرم</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-size">سایز</Label>
                  <Input
                    id="p-size"
                    value={form.size}
                    onChange={(e) => set('size', e.target.value)}
                    placeholder="مثلاً: ۵۴"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-dimensions">ابعاد</Label>
                  <Input
                    id="p-dimensions"
                    value={form.dimensions}
                    onChange={(e) => set('dimensions', e.target.value)}
                    placeholder="مثلاً: ۲×۳ سانتی‌متر"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-brand">برند</Label>
                  <Input
                    id="p-brand"
                    value={form.brand}
                    onChange={(e) => set('brand', e.target.value)}
                    placeholder="Silver Love"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-appearance">ظاهر و طراحی</Label>
                  <Input
                    id="p-appearance"
                    value={form.appearance}
                    onChange={(e) => set('appearance', e.target.value)}
                    placeholder="مثلاً: مات، با آبکاری رودیوم"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="p-care">دستور نگهداری</Label>
                  <Textarea
                    id="p-care"
                    rows={2}
                    value={form.careInstructions}
                    onChange={(e) => set('careInstructions', e.target.value)}
                    placeholder="مثلاً: پس از استفاده با دستمال نرم تمیز و در بسته‌بندی نگهداری کنید"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="p-authenticity">یادداشت اصالت</Label>
                  <Textarea
                    id="p-authenticity"
                    rows={2}
                    value={form.authenticityNote}
                    onChange={(e) => set('authenticityNote', e.target.value)}
                    placeholder="مثلاً: دارای مهر عیار و کارت اصالت"
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* AI panel */}
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-emerald-800">
              <Bot className="size-4" aria-hidden />
              تولید محتوا با هوش مصنوعی
            </p>
            <Textarea
              rows={3}
              value={roughInfo}
              onChange={(e) => setRoughInfo(e.target.value)}
              placeholder="اطلاعات خام محصول… مثلاً: گردنبند نقره ۹۲۵، طرح قلب، وزن ۱۲ گرم، مناسب هدیه ولنتاین"
              className="bg-card"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={generate}
                disabled={generating}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {generating ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="size-4" aria-hidden />
                )}
                {generating ? 'در حال تولید…' : 'تولید با هوش مصنوعی'}
              </Button>
              <span className="text-xs text-muted-foreground">
                هوش مصنوعی قیمت و موجودی را تغییر نمی‌دهد
              </span>
            </div>
            {suggestion && (
              <div className="mt-3">
                <AiSuggestionList
                  suggestion={suggestion}
                  onApply={applyField}
                  onApplyAll={applyAll}
                />
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            انصراف
          </Button>
          <Button onClick={save} disabled={saving} className="bg-emerald-600 text-white hover:bg-emerald-700">
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {isEdit ? 'ذخیره تغییرات' : 'ایجاد محصول'}
          </Button>
        </DialogFooter>

        {/* Image preview dialog */}
        <Dialog open={Boolean(previewUrl)} onOpenChange={(o) => !o && setPreviewUrl(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="sr-only">پیش‌نمایش تصویر</DialogTitle>
            </DialogHeader>
            {previewUrl && (
              <div className="relative">
                <img
                  src={previewUrl}
                  alt="پیش‌نمایش تصویر محصول"
                  className="max-h-[70vh] w-full rounded-lg object-contain"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="absolute end-2 top-2"
                  onClick={() => setPreviewUrl(null)}
                  aria-label="بستن پیش‌نمایش"
                >
                  <X className="size-4" />
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
