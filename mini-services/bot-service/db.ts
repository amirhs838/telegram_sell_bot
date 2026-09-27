/**
 * bot-service — Prisma client singleton.
 * Shares the SAME SQLite database as the Next.js app (single source of truth).
 * WAL + busy_timeout keep concurrent writes (admin API ↔ bot orders) safe.
 */
import { PrismaClient } from '@prisma/client'

const globalAny = globalThis as unknown as { __botPrisma?: PrismaClient }

export const db: PrismaClient = globalAny.__botPrisma ?? new PrismaClient()

if (!globalAny.__botPrisma) {
  globalAny.__botPrisma = db
  // SQLite concurrency guards — ignore failures (e.g. non-sqlite datasource).
  db.$queryRawUnsafe('PRAGMA busy_timeout=5000').catch(() => {})
  db.$queryRawUnsafe('PRAGMA journal_mode=WAL').catch(() => {})
}
