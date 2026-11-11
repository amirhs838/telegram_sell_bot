'use client'

/**
 * Browser-side image preparation for /api/uploads.
 *
 * Why: the seller (and the image studio) often uploads full-resolution phone
 * photos (4–10 MB) over a slow, unstable mobile link. Those uploads die
 * mid-transfer after a minute or two (connection reset — nothing the server
 * can do). Downsizing + JPEG-recompressing IN THE BROWSER before the request
 * turns them into ~200–400 KB files that survive the trip, with no visible
 * quality loss for product cards or the studio's AI input.
 */

import { ApiError, getToken } from '@/lib/client'

export type UploadResult = { url: string; name: string; size: number }

const MAX_DIM = 1600 // long-edge cap in px — plenty for product cards & studio input
const JPEG_QUALITY = 0.82
const SKIP_BELOW = 400 * 1024 // already light — upload untouched
const GIVE_UP_ABOVE = 30 * 1024 * 1024 // absurd input — don't decode, let the server judge

/**
 * Shrink a photo in the browser BEFORE upload: max 1600px long edge,
 * re-encoded as JPEG q0.82. Returns the ORIGINAL file untouched when
 * compression is unnecessary (small files), impossible (GIF animation,
 * undecodable formats like HEIC on Windows Chrome), or useless
 * (re-encode came out bigger).
 */
export async function compressImageFile(file: File): Promise<File> {
  try {
    if (file.type === 'image/gif') return file // re-encoding loses animation
    if (file.size <= SKIP_BELOW) return file
    if (file.size > GIVE_UP_ABOVE) return file
    if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') return file

    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return file
    }
    // Flatten any transparency onto white so JPEG never renders it black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY),
    )
    canvas.width = 0
    canvas.height = 0
    if (!blob || blob.size >= file.size) return file // compression didn't help
    const base = file.name.replace(/\.[^.]+$/, '') || 'image'
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
  } catch {
    // Undecodable in this browser — send the original and let the server
    // reject with its precise Persian message if the format is unsupported.
    return file
  }
}

const CHUNK_SIZE = 64 * 1024
const MAX_CHUNK_ATTEMPTS = 5
const CHUNK_TIMEOUT_MS = 120_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function newUploadId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 24)
    }
  } catch {
    /* non-secure context without randomUUID — fall through */
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`
}

/** One XHR request; resolves with parsed JSON or rejects with ApiError. */
function xhrJson(
  url: string,
  init: {
    body?: Blob | string
    contentType?: string
    timeoutMs?: number
    onProgress?: (loaded: number, total: number) => void
  },
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    if (init.contentType) xhr.setRequestHeader('Content-Type', init.contentType)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    if (init.timeoutMs) xhr.timeout = init.timeoutMs

    xhr.onload = () => {
      let data: Record<string, unknown> | null = null
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>
      } catch {
        /* empty / non-JSON body */
      }
      if (xhr.status === 401) {
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('tcb:unauthorized'))
        reject(new ApiError('نشست شما منقضی شده است — دوباره وارد شوید', 401))
        return
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        resolve(data)
      } else {
        reject(
          new ApiError(
            typeof data?.error === 'string' ? data.error : 'درخواست آپلود ناموفق بود',
            xhr.status || 0,
          ),
        )
      }
    }
    xhr.onerror = () => reject(new ApiError('ارتباط با سرور قطع شد', 0))
    xhr.ontimeout = () => reject(new ApiError('زمان ارسال بخش به پایان رسید', 0))
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) init.onProgress?.(e.loaded, e.total)
    }
    xhr.send(init.body ?? null)
  })
}

/**
 * POST a file to /api/uploads in SMALL RESUMABLE CHUNKS with real progress
 * (fetch() exposes no upload events, XHR does).
 *
 * Why chunked: the seller's link to the server is a slow, reset-prone mobile
 * route — a 253KB single POST died mid-transfer after 1–3 minutes (verified
 * in the access log) and restarted from zero on every retry. 64KB pieces
 * finish before the carrier kills the flow, each piece retries independently
 * (progress never goes backwards), and /api/uploads/complete stitches the
 * file together server-side once every piece has landed.
 *
 * Auth mirrors api(): Bearer token beats cookie-restricted preview iframes;
 * on 401 the same global unauthorized event fires.
 */
export function uploadImageWithProgress(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const id = newUploadId()
        const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))
        let completedBytes = 0
        let intraLoaded = 0

        const report = () => {
          const pct = Math.min(99, Math.round(((completedBytes + intraLoaded) / Math.max(file.size, 1)) * 100))
          onProgress?.(pct)
        }

        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE
          const chunk = file.slice(start, Math.min(file.size, start + CHUNK_SIZE))
          intraLoaded = 0

          let sent = false
          let lastErr: unknown = null
          for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS && !sent; attempt++) {
            if (attempt > 1) {
              intraLoaded = 0
              report() // honest dip inside the retried chunk
              await sleep(Math.min(500 * attempt, 2500))
            }
            try {
              await xhrJson(`/api/uploads/chunk?id=${id}&i=${i}`, {
                body: chunk,
                contentType: 'application/octet-stream',
                timeoutMs: CHUNK_TIMEOUT_MS,
                onProgress: (loaded) => {
                  intraLoaded = loaded
                  report()
                },
              })
              sent = true
            } catch (e) {
              lastErr = e
              if (e instanceof ApiError && e.status === 401) throw e // session dead — stop early
            }
          }
          if (!sent) {
            const status = lastErr instanceof ApiError ? lastErr.status : 0
            throw new ApiError(
              `بخش ${(i + 1).toLocaleString('fa-IR')} از ${totalChunks.toLocaleString('fa-IR')} بعد از چند تلاش ارسال نشد — اینترنت این لحظه ناپایدار است؛ کمی بعد یا با اینترنت دیگری امتحان کنید`,
              status,
            )
          }
          completedBytes += chunk.size
          intraLoaded = 0
          report()
        }

        const res = await xhrJson('/api/uploads/complete', {
          body: JSON.stringify({ id, mime: file.type, total: totalChunks }),
          contentType: 'application/json',
          timeoutMs: CHUNK_TIMEOUT_MS,
        })
        if (typeof res.url !== 'string') throw new ApiError('پاسخ سرور نامعتبر بود', 0)
        onProgress?.(100)
        resolve({
          url: res.url,
          name: typeof res.name === 'string' ? res.name : '',
          size: typeof res.size === 'number' ? res.size : file.size,
        })
      } catch (e) {
        reject(e)
      }
    })()
  })
}
