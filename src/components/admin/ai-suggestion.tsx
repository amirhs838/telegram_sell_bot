'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Copy, Check, Sparkles, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import type { AiSuggestion } from '@/lib/client'

type FieldKey = 'title' | 'shortDescription' | 'description' | 'categorySuggestion' | 'tags' | 'telegramCaption'

const FIELDS: { key: FieldKey; label: string }[] = [
  { key: 'title', label: 'نام محصول' },
  { key: 'shortDescription', label: 'توضیح کوتاه' },
  { key: 'description', label: 'توضیح کامل' },
  { key: 'categorySuggestion', label: 'پیشنهاد دسته‌بندی' },
  { key: 'tags', label: 'برچسب‌ها' },
  { key: 'telegramCaption', label: 'کپشن تلگرام' },
]

function fieldValue(s: AiSuggestion, key: FieldKey): string {
  if (key === 'tags') return (s.tags ?? []).join('، ')
  return String(s[key] ?? '')
}

/**
 * Structured AI suggestion preview.
 * - onApply provided → per-field «اعمال» button + «اعمال همه» header button
 *   (telegramCaption is copy-only — it is not a product form field)
 * - onApply omitted → copy-only mode (AI tools page)
 */
export function AiSuggestionList({
  suggestion,
  onApply,
  onApplyAll,
}: {
  suggestion: AiSuggestion
  onApply?: (key: FieldKey, value: string) => void
  onApplyAll?: () => void
}) {
  const [copied, setCopied] = useState<string | null>(null)

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
    } catch {
      toast.error('کپی انجام نشد')
    }
  }

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-800">
          <Sparkles className="size-4" aria-hidden />
          محتوای پیشنهادی
        </p>
        {onApplyAll && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 border-emerald-300 text-emerald-700 hover:bg-emerald-100"
            onClick={onApplyAll}
          >
            <Wand2 className="size-3.5" aria-hidden />
            اعمال همه
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {FIELDS.map(({ key, label }) => {
          const value = fieldValue(suggestion, key)
          if (!value) return null
          return (
            <div key={key} className="rounded-lg border bg-card p-2.5">
              <p className="mb-1 text-xs text-muted-foreground">{label}</p>
              <p className="max-h-24 overflow-y-auto scroll-thin whitespace-pre-wrap break-words text-sm leading-6">
                {value}
              </p>
              <div className="mt-2 flex items-center gap-2">
                {onApply && key !== 'telegramCaption' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 border-emerald-300 text-emerald-700 hover:bg-emerald-100"
                    onClick={() => onApply(key, value)}
                  >
                    اعمال
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-muted-foreground"
                  onClick={() => copy(value, key)}
                >
                  {copied === key ? (
                    <Check className="size-3.5 text-emerald-600" aria-hidden />
                  ) : (
                    <Copy className="size-3.5" aria-hidden />
                  )}
                  کپی
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        هوش مصنوعی قیمت و موجودی را تغییر نمی‌دهد.
      </p>
    </div>
  )
}
