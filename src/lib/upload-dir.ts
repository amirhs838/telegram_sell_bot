import path from 'node:path'

/**
 * Single source of truth for the runtime upload directory (product photos,
 * studio renders, payment receipts).
 *
 * CRITICAL: the Next standalone production server (`server.js`) chdirs into
 * `.next/standalone` at startup — and every `bun run build` deletes `.next`
 * wholesale. Anchoring uploads to `process.cwd()/upload` therefore placed
 * every uploaded file inside the build-wipe zone and silently DESTROYED all
 * user uploads on each deploy (product photos, studio renders, receipts).
 *
 * Resolution order:
 *   1. UPLOAD_DIR env var (absolute override — set in the server .env)
 *   2. project root, detected by stripping the `/.next/standalone` suffix
 *      from the cwd when running under the standalone server
 *   3. plain cwd (local dev: cwd already IS the project root)
 */
export function uploadDir(...segments: string[]): string {
  const override = process.env.UPLOAD_DIR?.trim()
  if (override) return path.join(path.resolve(override), ...segments)

  const cwd = process.cwd()
  const marker = `${path.sep}.next${path.sep}standalone`
  const idx = cwd.lastIndexOf(marker)
  const root = idx > 0 ? cwd.slice(0, idx) : cwd
  return path.join(root, 'upload', ...segments)
}
