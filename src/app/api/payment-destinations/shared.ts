import type { PaymentDestination } from '@prisma/client'

/** Shared serialization for PaymentDestination rows (contract for the panel UI). */
export function serializeDestination(d: PaymentDestination) {
  return {
    id: d.id,
    bankName: d.bankName,
    accountHolder: d.accountHolder,
    cardNumber: d.cardNumber,
    sheba: d.sheba,
    accountNumber: d.accountNumber,
    note: d.note,
    active: d.active,
    sortOrder: d.sortOrder,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}
