import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ok, readJson, requireAdmin, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'

export const bankAccountSchema = z.object({
  bankName: z.string().trim().min(2, 'نام بانک الزامی است').max(80),
  holderName: z.string().trim().min(2, 'نام صاحب حساب الزامی است').max(80),
  cardNumber: z
    .string()
    .trim()
    .min(12, 'شماره کارت معتبر نیست')
    .max(30, 'شماره کارت معتبر نیست')
    .regex(/^[0-9\-*\s]+$/, 'شماره کارت فقط شامل رقم و خط تیره است'),
  sheba: z
    .string()
    .trim()
    .max(34)
    .regex(/^IR[0-9]{0,26}$/i, 'شبا معتبر نیست (مثال: IR1200000000000000000000)')
    .nullish(),
  accountNumber: z.string().trim().max(30).nullish(),
  note: z.string().trim().max(500).nullish(),
  active: z.boolean().optional().default(true),
})

// GET /api/bank-accounts — payment destinations (customers see only active ones)
export const GET = route(async () => {
  await requireAuth()
  const accounts = await db.bankAccount.findMany({
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
  })
  return ok({ accounts })
})

// POST /api/bank-accounts — admin only
export const POST = route(async (req: NextRequest) => {
  const admin = await requireAdmin()
  const body = bankAccountSchema.parse(await readJson(req))
  const account = await db.bankAccount.create({
    data: {
      bankName: body.bankName,
      holderName: body.holderName,
      cardNumber: body.cardNumber,
      sheba: body.sheba ?? null,
      accountNumber: body.accountNumber ?? null,
      note: body.note ?? null,
      active: body.active,
    },
  })
  await logEvent('bank_account.created', `مقصد پرداخت «${account.bankName}» ثبت شد`, {
    id: account.id,
    by: admin.email,
  })
  return ok({ account }, 201)
})
