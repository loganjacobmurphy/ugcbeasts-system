// Admin only: see who has asked for access, and let them in.
//
// Signing in with Google proves an email, not that the person behind it is
// welcome. The middleware records first-time arrivals as pending; this is where
// they get approved.

interface D1Result<T> {
  results: T[]
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<D1Result<T>>
  run(): Promise<unknown>
}
interface D1Database {
  prepare(query: string): D1PreparedStatement
}
interface Env {
  DB: D1Database
}
interface Ctx {
  request: Request
  env: Env
  data: { user?: { email: string; isAdmin: boolean } }
}

interface Row {
  email: string
  status: string
  is_admin: number
  created_at: number | null
  approved_at: number | null
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export async function onRequestGet({ env, data }: Ctx): Promise<Response> {
  if (!data.user?.isAdmin) return json({ error: 'Admins only.' }, 403)

  const { results } = await env.DB.prepare(
    'SELECT email, status, is_admin, created_at, approved_at FROM users' +
      " ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC",
  ).all<Row>()

  return json({
    users: results.map((r) => ({
      email: r.email,
      status: r.status,
      isAdmin: Boolean(r.is_admin),
      createdAt: r.created_at,
      approvedAt: r.approved_at,
    })),
  })
}

export async function onRequestPost({ request, env, data }: Ctx): Promise<Response> {
  const me = data.user
  if (!me?.isAdmin) return json({ error: 'Admins only.' }, 403)

  const body = (await request.json().catch(() => ({}))) as { email?: string; action?: string }
  const email = (body.email || '').trim().toLowerCase()
  const action = body.action || ''
  if (!email) return json({ error: 'Which email?' }, 400)

  // Locking yourself out is not undoable from inside the app, so it is refused
  // here rather than left as a trap.
  const selfHarm = email === me.email && action !== 'approve' && action !== 'promote'
  if (selfHarm) return json({ error: 'You cannot remove your own access.' }, 400)

  const now = Math.floor(Date.now() / 1000)
  switch (action) {
    case 'approve':
      await env.DB.prepare("UPDATE users SET status = 'approved', approved_at = ? WHERE email = ?")
        .bind(now, email)
        .run()
      break
    case 'revoke':
      await env.DB.prepare("UPDATE users SET status = 'pending', approved_at = NULL WHERE email = ?")
        .bind(email)
        .run()
      break
    case 'promote':
      await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').bind(email).run()
      break
    case 'demote':
      await env.DB.prepare('UPDATE users SET is_admin = 0 WHERE email = ?').bind(email).run()
      break
    case 'remove':
      // their workspace goes with them, otherwise it lingers unreachable
      await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run()
      await env.DB.prepare('DELETE FROM app_state WHERE id = ?').bind(email).run()
      break
    default:
      return json({ error: `Unknown action "${action}".` }, 400)
  }

  return json({ ok: true, email, action })
}
