import { NextResponse, type NextRequest } from 'next/server'
import { ZodError } from 'zod'
import { getSessionUser } from '@/lib/auth'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function ok(data: unknown, status = 200) {
  return NextResponse.json(data, { status })
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

/** Throws 401 ApiError when there is no valid session. Returns the user. */
export async function requireAuth() {
  const user = await getSessionUser()
  if (!user) throw new ApiError(401, 'unauthorized')
  return user
}

export function handleError(e: unknown): NextResponse {
  if (e instanceof ApiError) return fail(e.message, e.status)
  if (e instanceof ZodError) {
    const first = e.issues[0]
    const msg = first ? `${first.path.join('.')}: ${first.message}` : 'invalid input'
    return fail(`ورودی نامعتبر است (${msg})`, 422)
  }
  console.error('[api:error]', e)
  return fail('خطای داخلی سرور', 500)
}

/** Wrap a route handler with uniform error handling. */
export function route<Ctx = unknown>(
  handler: (req: NextRequest, ctx: Ctx) => Promise<Response>,
) {
  return async (req: NextRequest, ctx: Ctx): Promise<Response> => {
    try {
      return await handler(req, ctx)
    } catch (e) {
      return handleError(e)
    }
  }
}

export async function readJson<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new ApiError(400, 'بدنه درخواست JSON معتبر نیست')
  }
}
