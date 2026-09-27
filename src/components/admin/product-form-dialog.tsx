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
  Upload,
  X,
  ImagePlus,
  Bot,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type AiSuggestion,
  type Category,
  type Product,
  type ProductStatus,
} from '@/lib/client'

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
  imageUrl: string
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
  imageUrl: '',
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
    imageUrl: p.imageUrl ?? '',
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

  async function uploadImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api<{ url: string; name: string; size: number }>('/api/uploads', {
        method: 'POST',
        body: fd,
      })
      set('imageUrl', res.url)
      toast.success('تصویر آپلود شد')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

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
      imageUrl: form.imageUrl.trim() || null,
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
                placeholder="مثلاً: هدفون بی‌سیم مدل X"
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
              <Label htmlFor="p-price">قیمت (تومان) *</Label>
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
                placeholder="هدفون، بی‌سیم، موسیقی"
              />
            </div>

            {/* Image upload */}
            <div className="space-y-1.5 md:col-span-2">
              <Label>تصویر محصول</Label>
              {form.imageUrl ? (
                <div className="flex items-center gap-3 rounded-lg border p-2">
                  <img
                    src={form.imageUrl}
                    alt="پیش‌نمایش تصویر محصول"
                    className="size-16 rounded-lg border object-cover"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="حذف تصویر"
                    onClick={() => set('imageUrl', '')}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ) : (
                <div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="sr-only"
                    onChange={uploadImage}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <ImagePlus className="size-4" aria-hidden />
                    )}
                    {uploading ? 'در حال آپلود…' : 'انتخاب و آپلود تصویر'}
                  </Button>
                  <p className="mt-1 text-xs text-muted-foreground">JPG، PNG، WebP یا GIF — حداکثر ۵ مگابایت</p>
                </div>
              )}
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
              placeholder="اطلاعات خام محصول… مثلاً: هدفون بلوتوثی، نویز کنسلینگ، ۳۰ ساعت باتری، مناسب ورزش و سفر"
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
