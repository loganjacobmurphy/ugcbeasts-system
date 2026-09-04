// Each person's own workspace, stored as one JSON document per email in D1.
//
// The row id is the signed-in email (see _middleware.ts), so two people on the
// same install never see each other's campaigns. Formats and templates are the
// shared part and live in shared_config instead (see config.ts).

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
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
  data: { user?: { email: string } }
}

export async function onRequestGet({ env, data }: Ctx): Promise<Response> {
  const email = data.user?.email
  if (!email) return new Response('Unauthorized', { status: 401 })

  const row = await env.DB.prepare('SELECT data FROM app_state WHERE id = ?')
    .bind(email)
    .first<{ data: string }>()

  let parsed: unknown = null
  if (row?.data) {
    try {
      parsed = JSON.parse(row.data)
    } catch {
      parsed = null
    }
  }
  return Response.json({ data: parsed })
}

export async function onRequestPut({ request, env, data }: Ctx): Promise<Response> {
  const email = data.user?.email
  if (!email) return new Response('Unauthorized', { status: 401 })

  const body = await request.text()
  const now = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO app_state (id, data, updated_at) VALUES (?, ?, ?)' +
      ' ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  )
    .bind(email, body, now)
    .run()
  return Response.json({ ok: true, updatedAt: now })
}
