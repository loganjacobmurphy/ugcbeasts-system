/**
 * Who is calling, and are they allowed in. Runs in front of every /api/* route.
 *
 * Identity comes from a verified Cloudflare Access token (see _access.ts). The
 * email inside it is what every other route keys off, so two people sharing this
 * install never see each other's work.
 *
 * On installs with no Access in front (the original single-user logan-hq, and
 * `wrangler dev`) this falls back to the old shared passcode, so that deployment
 * keeps working untouched.
 */
import { accessConfigured, verifiedEmail, type AccessEnv } from '../_access'

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
  run(): Promise<unknown>
}
interface D1Database {
  prepare(query: string): D1PreparedStatement
}
export interface Env extends AccessEnv {
  DB: D1Database
  APP_PASSCODE?: string
  SOLO_EMAIL?: string
}

export interface AccessUser {
  email: string
  isAdmin: boolean
  status: 'pending' | 'approved'
}

interface Ctx {
  request: Request
  env: Env
  data: Record<string, unknown> & { user?: AccessUser }
  next: () => Promise<Response>
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export const onRequest = async (ctx: Ctx): Promise<Response> => {
  const { request, env } = ctx

  // No Access in front: one shared passcode, one workspace. This is the old
  // logan-hq behaviour, kept so that deployment is not broken by the move.
  if (!accessConfigured(env)) {
    const provided = request.headers.get('x-passcode') ?? ''
    if (!env.APP_PASSCODE || provided !== env.APP_PASSCODE) {
      return json({ error: 'Wrong passcode.', code: 'no_identity' }, 401)
    }
    ctx.data.user = { email: env.SOLO_EMAIL || 'singleton', isAdmin: true, status: 'approved' }
    return ctx.next()
  }

  const email = await verifiedEmail(request, env)
  if (!email) return json({ error: 'Not signed in.', code: 'no_identity' }, 401)

  const row = await env.DB.prepare('SELECT email, status, is_admin FROM users WHERE email = ?')
    .bind(email)
    .first<{ email: string; status: string; is_admin: number }>()

  if (!row) {
    // First sight of a verified person: record the request instead of bouncing
    // it, so there is something for the admin to approve.
    await env.DB.prepare(
      "INSERT INTO users (email, status, is_admin, created_at) VALUES (?, 'pending', 0, ?)" +
        ' ON CONFLICT(email) DO NOTHING',
    )
      .bind(email, Math.floor(Date.now() / 1000))
      .run()
    return json({ error: 'Waiting to be approved.', code: 'pending', email }, 403)
  }

  if (row.status !== 'approved') {
    return json({ error: 'Waiting to be approved.', code: 'pending', email }, 403)
  }

  ctx.data.user = {
    email: row.email,
    isAdmin: Boolean(row.is_admin),
    status: 'approved',
  }
  return ctx.next()
}
