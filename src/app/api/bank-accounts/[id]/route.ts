import type { NextRequest } from 'next/server'
import { ApiError, ok, readJson, requireAdmin, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { bankAccountSchema } from '../route'

type Ctx = { params: Promise<{ id: string }> }

// PATCH /api/bank-accounts/[id] — admin only
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const admin = await requireAdmin()
  const { id } = await params
  const existing = await db.bankAccount.findUnique({ where: { id } })
  if (!existing) throw new ApiError(404, 'مقصد پرداخت یافت نشد')

  const body = bankAccountSchema.partial().parse(await readJson(req))
  const account = await db.bankAccount.update({ where: { id }, data: body })

  await logEvent('bank_account.updated', `مقصد پرداخت «${account.bankName}» ویرایش شد`, {
    id: account.id,
    by: admin.email,
  })
  return ok({ account })
})

// DELETE /api/bank-accounts/[id] — admin only
export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const admin = await requireAdmin()
  const { id } = await params
  const existing = await db.bankAccount.findUnique({ where: { id } })
  if (!existing) throw new ApiError(404, 'مقصد پرداخت یافت نشد')

  await db.bankAccount.delete({ where: { id } })
  await logEvent('bank_account.deleted', `مقصد پرداخت «${existing.bankName}» حذف شد`, {
    id,
    by: admin.email,
  })
  return ok({ ok: true })
})
