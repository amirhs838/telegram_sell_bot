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

/**
 * POST a file to /api/uploads with REAL upload progress (fetch() exposes no
 * upload events, XHR does — on slow links the seller must see movement or
 * they abort). Auth mirrors api(): Bearer token beats cookie-restricted
 * preview iframes; on 401 the same global unauthorized event fires.
 */
export function uploadImageWithProgress(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/uploads')
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)))
      }
    }
    xhr.onload = () => {
      let data: { url?: string; name?: string; size?: number; error?: string } | null = null
      try {
        data = JSON.parse(xhr.responseText) as typeof data
      } catch {
        /* empty / non-JSON body */
      }
      if (xhr.status === 401) {
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('tcb:unauthorized'))
        reject(new ApiError('نشست شما منقضی شده است — دوباره وارد شوید', 401))
        return
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.url) {
        resolve({ url: data.url, name: data.name ?? '', size: data.size ?? file.size })
      } else {
        reject(new ApiError(data?.error ?? 'آپلود ناموفق بود — لطفاً دوباره تلاش کنید', xhr.status || 0))
      }
    }
    xhr.onerror = () =>
      reject(
        new ApiError(
          'ارتباط با سرور حین آپلود قطع شد — لطفاً دوباره تلاش کنید (عکس‌های بزرگ خودکار کوچک می‌شوند)',
          0,
        ),
      )
    xhr.ontimeout = () => reject(new ApiError('آپلود بیش از حد طول کشید — دوباره تلاش کنید', 0))

    const fd = new FormData()
    fd.append('file', file)
    xhr.send(fd)
  })
}
