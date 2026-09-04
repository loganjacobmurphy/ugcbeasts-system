// Where your own copy of greenroom lives.
//
// greenroom runs on the machine with the GPU, so each person registers their own
// address and shared key here and the proxy sends them to it (see _greenroom.ts).

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

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export async function onRequestGet({ env, data }: Ctx): Promise<Response> {
  const email = data.user?.email
  if (!email) return json({ error: 'Unauthorized' }, 401)

  const row = await env.DB.prepare(
    'SELECT greenroom_origin, greenroom_key FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ greenroom_origin: string | null; greenroom_key: string | null }>()

  // the key itself never goes back to the browser, only whether one is set
  return json({
    greenroomOrigin: row?.greenroom_origin || '',
    hasGreenroomKey: Boolean(row?.greenroom_key),
  })
}

export async function onRequestPut({ request, env, data }: Ctx): Promise<Response> {
  const email = data.user?.email
  if (!email) return json({ error: 'Unauthorized' }, 401)

  const body = (await request.json().catch(() => ({}))) as {
    greenroomOrigin?: string
    greenroomKey?: string
  }

  let origin = (body.greenroomOrigin || '').trim().replace(/\/+$/, '')
  if (origin) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return json({ error: 'That address is not a URL.' }, 400)
    }
    // the key rides on every proxied request, so it must not travel in clear text
    if (parsed.protocol !== 'https:') {
      return json({ error: 'The address has to start with https.' }, 400)
    }
    origin = parsed.origin
  }

  const key = (body.greenroomKey || '').trim()

  if (key) {
    await env.DB.prepare('UPDATE users SET greenroom_origin = ?, greenroom_key = ? WHERE email = ?')
      .bind(origin || null, key, email)
      .run()
  } else {
    // blank means "leave the key alone", so it can be re-saved without retyping
    await env.DB.prepare('UPDATE users SET greenroom_origin = ? WHERE email = ?')
      .bind(origin || null, email)
      .run()
  }

  return json({ ok: true, greenroomOrigin: origin })
}
