'use client'

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { AiSuggestionList } from '@/components/admin/ai-suggestion'
import {
  Loader2,
  Sparkles,
  X,
  ImagePlus,
  Bot,
  Star,
  ChevronUp,
  ChevronDown,
  Gem,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type AiSuggestion,
  type Category,
  type Product,
  type ProductStatus,
} from '@/lib/client'
import { cn } from '@/lib/utils'

type GalleryItem = { url: string; isPrimary: boolean }

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
  // gallery
  images: GalleryItem[]
  // Silver specs (optional)
  sku: string
  silverType: string
  purity: string
  weightGrams: string
  size: string
  dimensions: string
  brand: string
  appearance: string
  careInstructions: string
  authenticity: string
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
  images: [],
  sku: '',
  silverType: '',
  purity: '',
  weightGrams: '',
  size: '',
  dimensions: '',
  brand: '',
  appearance: '',
  careInstructions: '',
  authenticity: '',
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
    images: (p.images ?? []).map((i) => ({ url: i.url, isPrimary: i.isPrimary })),
    sku: p.sku ?? '',
    silverType: p.silverType ?? '',
    purity: p.purity ?? '',
    weightGrams: p.weightGrams != null ? String(p.weightGrams) : '',
    size: p.size ?? '',
    dimensions: p.dimensions ?? '',
    brand: p.brand ?? '',
    appearance: p.appearance ?? '',
    careInstructions: p.careInstructions ?? '',
    authenticity: p.authenticity ?? '',
  }
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,،]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Optional string field → null when empty. */
const opt = (v: string) => (v.trim() ? v.trim() : null)

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
  const [saving, setSaving] = useState(false)
  const [roughInfo, setRoughInfo] = useState('')
  const [generating, setGenerating] = useState(false)
  const [suggestion, setSuggestion] = useState<AiSuggestion | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const isEdit = Boolean(product)

  useEffect(() => {
    if (open) {
      setForm(toForm(product))
      setSuggestion(null)
      setRoughInfo('')
    }
  }, [open, product])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  // ─── Gallery management ────────────────────────────────────────────────────

  async function uploadImages(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    if (form.images.length + files.length > 12) {
      toast.error('حداکثر ۱۲ تصویر برای هر محصول مجاز است')
      return
    }
    setUploading(true)
    try {
      const uploaded: GalleryItem[] = []
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await api<{ url: string; name: string; size: number }>('/api/uploads', {
          method: 'POST',
          body: fd,
        })
        uploaded.push({ url: res.url, isPrimary: false })
      }
      setForm((f) => {
        const images = [...f.images, ...uploaded]
        if (!images.some((i) => i.isPrimary) && images.length > 0) images[0].isPrimary = true
        return { ...f, images }
      })
      toast.success(`${uploaded.length} تصویر آپلود شد`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  function removeImage(idx: number) {
    setForm((f) => {
      const images = f.images.filter((_, i) => i !== idx)
      if (!images.some((i) => i.isPrimary) && images.length > 0) images[0].isPrimary = true
      return { ...f, images }
    })
  }

  function setPrimary(idx: number) {
    setForm((f) => ({
      ...f,
      images: f.images.map((im, i) => ({ ...im, isPrimary: i === idx })),
    }))
  }

  function moveImage(idx: number, dir: -1 | 1) {
    setForm((f) => {
      const images = [...f.images]
      const j = idx + dir
      if (j < 0 || j >= images.length) return f
      const a = images[idx]
      images[idx] = images[j]
      images[j] = a
      return { ...f, images }
    })
  }

  // ─── AI content (unchanged behavior — never touches price/stock) ───────────

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

  // ─── Save ──────────────────────────────────────────────────────────────────

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
    const weight = form.weightGrams.trim() ? Number(form.weightGrams) : null
    if (weight !== null && (!Number.isFinite(weight) || weight < 0)) {
      toast.error('وزن معتبر نیست')
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
      // gallery (primary is mirrored server-side into imageUrl)
      images: form.images.map((i) => ({ url: i.url, isPrimary: i.isPrimary })),
      // Silver specs — the seller decides everything; the system never prices products
      sku: opt(form.sku),
      silverType: opt(form.silverType),
      purity: opt(form.purity),
      weightGrams: weight,
      size: opt(form.size),
      dimensions: opt(form.dimensions),
      brand: opt(form.brand),
      appearance: opt(form.appearance),
      careInstructions: opt(form.careInstructions),
      authenticity: opt(form.authenticity),
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

  const specField = (
    id: string,
    label: string,
    key: keyof FormState,
    placeholder?: string,
    type: 'text' | 'number' = 'text',
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        dir={type === 'number' ? 'ltr' : undefined}
        className={type === 'number' ? 'text-left' : undefined}
        type={type}
        min={type === 'number' ? 0 : undefined}
        step={type === 'number' ? '0.1' : undefined}
        value={form[key] as string}
        onChange={(e) => set(key, e.target.value as FormState[typeof key])}
        placeholder={placeholder}
      />
    </div>
  )

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
                placeholder="مثلاً: انگشتر نقره مردانه مدل اژدها"
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
              <Label htmlFor="p-price">قیمت نهایی فروش (تومان) *</Label>
              <Input
                id="p-price"
                dir="ltr"
                className="text-left"
                type="number"
                min={0}
                value={form.price}
                onChange={(e) => set('price', e.target.value)}
                placeholder="2450000"
              />
              <p className="text-xs text-muted-foreground">
                قیمت نهایی را خودتان تعیین می‌کنید — سیستم هیچ محاسبه‌ای انجام نمی‌دهد
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
                placeholder="2800000"
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
                placeholder="انگشتر، دست‌ساز، نقره ۹۲۵"
              />
            </div>
          </div>

          {/* ── Gallery (multi-image) ── */}
          <div className="space-y-2 rounded-xl border p-3">
            <div className="flex items-center justify-between">
              <Label>تصاویر محصول</Label>
              <span className="text-xs text-muted-foreground">
                {form.images.length} / ۱۲
              </span>
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              onChange={uploadImages}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || form.images.length >= 12}
            >
              {uploading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ImagePlus className="size-4" aria-hidden />
              )}
              {uploading ? 'در حال آپلود…' : 'افزودن تصویر (چندتایی)'}
            </Button>
            <p className="text-xs text-muted-foreground">
              JPG، PNG، WebP یا GIF — حداکثر ۵ مگابایت برای هر فایل. اولین تصویر به‌صورت
              پیش‌فرض «تصویر اصلی» است؛ با ستاره آن را عوض کنید.
            </p>
            {form.images.length > 0 && (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {form.images.map((im, idx) => (
                  <li
                    key={`${im.url}-${idx}`}
                    className={cn(
                      'group relative overflow-hidden rounded-lg border bg-muted/30',
                      im.isPrimary && 'border-emerald-500 ring-1 ring-emerald-500',
                    )}
                  >
                    <img
                      src={im.url}
                      alt={`تصویر ${idx + 1} محصول`}
                      className="aspect-square w-full object-cover"
                    />
                    {im.isPrimary && (
                      <span className="absolute right-1 top-1 flex items-center gap-1 rounded-md bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        <Star className="size-3" aria-hidden /> اصلی
                      </span>
                    )}
                    <div className="flex items-center justify-between border-t bg-card p-1">
                      <div className="flex items-center gap-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="انتقال به عقب"
                          disabled={idx === 0}
                          onClick={() => moveImage(idx, -1)}
                        >
                          <ChevronUp className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="انتقال به جلو"
                          disabled={idx === form.images.length - 1}
                          onClick={() => moveImage(idx, 1)}
                        >
                          <ChevronDown className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                      <div className="flex items-center gap-0.5">
                        {!im.isPrimary && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label="انتخاب به‌عنوان تصویر اصلی"
                            onClick={() => setPrimary(idx)}
                          >
                            <Star className="size-3.5 text-amber-500" aria-hidden />
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 text-rose-500"
                          aria-label="حذف تصویر"
                          onClick={() => removeImage(idx)}
                        >
                          <X className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Silver specs (optional) ── */}
          <div className="rounded-xl border p-3">
            <p className="mb-3 flex items-center gap-1.5 text-sm font-medium">
              <Gem className="size-4 text-slate-500" aria-hidden />
              مشخصات نقره (اختیاری — مطابق نوع کالا پر کنید)
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {specField('p-sku', 'کد محصول', 'sku', 'SL-RG-101')}
              {specField('p-silver-type', 'نوع نقره', 'silverType', 'دست‌ساز / ماشین‌ساز / شمش')}
              {specField('p-purity', 'عیار', 'purity', '925')}
              {specField('p-weight', 'وزن (گرم)', 'weightGrams', '12.5', 'number')}
              {specField('p-size', 'سایز', 'size', '۵۴ تا ۵۸')}
              {specField('p-dimensions', 'ابعاد', 'dimensions', '۵۰×۲۹×۵ میلی‌متر')}
              {specField('p-brand', 'برند یا سازنده', 'brand', 'Silver Love')}
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="p-appearance">مشخصات ظاهری</Label>
                <Textarea
                  id="p-appearance"
                  rows={2}
                  value={form.appearance}
                  onChange={(e) => set('appearance', e.target.value)}
                  placeholder="نقش برجسته، پرداخت مات و براق…"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="p-care">شرایط نگهداری</Label>
                <Textarea
                  id="p-care"
                  rows={2}
                  value={form.careInstructions}
                  onChange={(e) => set('careInstructions', e.target.value)}
                  placeholder="دور از عطر و مواد شیمیایی…"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="p-authenticity">اصالت و ضمانت</Label>
                <Textarea
                  id="p-authenticity"
                  rows={2}
                  value={form.authenticity}
                  onChange={(e) => set('authenticity', e.target.value)}
                  placeholder="دارای مهر عیار ۹۲۵ و گواهی اصالت…"
                />
              </div>
            </div>
          </div>

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
              placeholder="اطلاعات خام محصول… مثلاً: انگشتر نقره ۹۲۵ دست‌ساز، وزن ۱۲ گرم، نقش اژدها، مناسب هدیه"
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
      </DialogContent>
    </Dialog>
  )
}
