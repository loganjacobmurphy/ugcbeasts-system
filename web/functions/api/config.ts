// The shared half: formats, audiences and templates that everybody works from.
//
// Deliberately not per-user. When one person tunes a format or adds an audience,
// everyone gets it, which is the whole point of sharing an install. Each person's
// own campaigns and videos live in app_state instead (see state.ts).

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

const KEYS = ['formats', 'templates'] as const
type Key = (typeof KEYS)[number]

export async function onRequestGet({ request, env, data }: Ctx): Promise<Response> {
  if (!data.user?.email) return new Response('Unauthorized', { status: 401 })

  const want = new URL(request.url).searchParams.get('key')
  const keys: readonly Key[] = want && (KEYS as readonly string[]).includes(want) ? [want as Key] : KEYS

  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const row = await env.DB.prepare('SELECT data FROM shared_config WHERE id = ?')
      .bind(key)
      .first<{ data: string }>()
    try {
      out[key] = row?.data ? JSON.parse(row.data) : null
    } catch {
      out[key] = null
    }
  }
  return Response.json(out)
}

export async function onRequestPut({ request, env, data }: Ctx): Promise<Response> {
  if (!data.user?.email) return new Response('Unauthorized', { status: 401 })

  const key = new URL(request.url).searchParams.get('key') || ''
  if (!(KEYS as readonly string[]).includes(key)) {
    return Response.json({ error: `key must be one of ${KEYS.join(', ')}` }, { status: 400 })
  }

  const body = await request.text()
  // A truncated or half-written body would otherwise replace everyone's formats
  // at once, so it has to parse before it is allowed to land.
  try {
    JSON.parse(body)
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 })
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO shared_config (id, data, updated_at) VALUES (?, ?, ?)' +
      ' ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  )
    .bind(key, body, now)
    .run()
  return Response.json({ ok: true, key, updatedAt: now })
}
