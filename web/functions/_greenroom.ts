// greenroom is the green screen UGC editor that runs on Logan's laptop (:5710).
// Logan HQ proxies it over the ljm-studios Cloudflare tunnel and serves it here,
// same-origin, so the HQ unlock carries over and no second passcode is needed.
//
// This handler owns /greenroom/embed/*, NOT /greenroom. /greenroom is a normal
// React page (src/pages/Greenroom.tsx) that keeps the sidebar and frames this.
//
// (functions/ is bundled by Pages, not by the client tsc build, so minimal
// local types are fine here.)

import { accessConfigured, verifiedEmail, type AccessEnv } from './_access'

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
}
interface D1Database {
  prepare(query: string): D1PreparedStatement
}

export interface Env extends AccessEnv {
  DB?: D1Database
  APP_PASSCODE?: string
  GREENROOM_KEY?: string
  GREENROOM_ORIGIN?: string
}
export interface Ctx {
  request: Request
  env: Env
}

const PREFIX = '/greenroom/embed'
const COOKIE = 'gr_pass'

/** Cookie value: unguessable without the passcode, and no session store needed. */
async function tokenFor(passcode: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`greenroom|${passcode}`))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function readCookie(request: Request, name: string): string {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return ''
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:24px; background:#fff; color:#171717;
         font-family:"Plus Jakarta Sans",system-ui,-apple-system,sans-serif }
  .card { width:100%; max-width:24rem; border:2px solid #e5e5e5; border-radius:1rem;
          padding:1.75rem; text-align:center }
  h1 { margin:0; font-size:1.5rem; font-weight:700 }
  p { margin:.25rem 0 0; font-size:1rem; color:#737373 }
  input { margin-top:1.25rem; width:100%; box-sizing:border-box; border:2px solid #e5e5e5;
          border-radius:.75rem; padding:.625rem .75rem; text-align:center; font:inherit;
          font-size:1rem; font-weight:500; outline:none }
  input:focus { border-color:#a3a3a3 }
  button { margin-top:1rem; width:100%; border:0; border-radius:9999px; background:#171717;
           color:#fff; padding:.625rem 1rem; font:inherit; font-size:.875rem; font-weight:600;
           cursor:pointer }
  button:hover { background:#262626 }
  .err { margin-top:.5rem; font-size:.875rem; font-weight:500; color:#ef4444 }
  a { color:#171717; font-weight:600 }
</style></head><body><div class="card">${body}</div></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

function offlinePage(): Response {
  return page(
    'Greenroom is offline',
    `<h1>Greenroom is offline</h1>
     <p>Greenroom runs on your laptop, so it needs the machine awake with the tunnel running.
        Start it again and reload this page.</p>
     <p style="margin-top:1rem"><a href="/" target="_top">Back to Logan HQ</a></p>`,
    503,
  )
}

export async function handle({ request, env }: Ctx): Promise<Response> {
  const url = new URL(request.url)
  // filled in by the Access branch; the passcode install keeps using the env vars
  let mine: { origin: string; key: string } | null = null

  // Behind Access, signing in with Google is the unlock, so there is no second
  // gate to pass. Without Access this falls back to the shared-passcode cookie
  // that Logan HQ has always used.
  if (accessConfigured(env)) {
    const email = await verifiedEmail(request, env)
    if (!email) {
      return page(
        'Greenroom',
        `<h1>Locked</h1>
         <p>Sign in and this opens with it.</p>
         <p style="margin-top:1rem"><a href="/" target="_top">Go to UGC Beasts</a></p>`,
        401,
      )
    }
    // Access only proves the email is theirs. Anyone can get that far, so being
    // approved is checked separately here: this route reaches a real machine,
    // and it must not open for someone still sitting in the pending list.
    const row = await env.DB?.prepare(
      "SELECT greenroom_origin, greenroom_key FROM users WHERE email = ? AND status = 'approved'",
    )
      .bind(email)
      .first<{ greenroom_origin: string | null; greenroom_key: string | null }>()

    if (!row) {
      return page(
        'Greenroom',
        `<h1>Not yet</h1>
         <p>Your account is still waiting to be approved.</p>
         <p style="margin-top:1rem"><a href="/" target="_top">Go to UGC Beasts</a></p>`,
        403,
      )
    }

    // Everyone runs their own copy on their own machine, so the videos, the
    // library and the GPU time are all theirs. Pointing everyone at one origin
    // would put the whole team inside one person's laptop.
    if (!row.greenroom_origin || !row.greenroom_key) {
      return page(
        'Greenroom',
        `<h1>Not connected yet</h1>
         <p>Greenroom runs on your own machine. Install it, then paste its address
            and key into Settings and this page opens onto your own library.</p>
         <p style="margin-top:1rem"><a href="/settings" target="_top">Open Settings</a></p>`,
        503,
      )
    }
    mine = { origin: row.greenroom_origin, key: row.greenroom_key }
  } else {
    if (!env.APP_PASSCODE) {
      return page('Greenroom', '<h1>Not configured</h1><p>APP_PASSCODE is not set.</p>', 500)
    }
    // Unlocking Logan HQ sets this cookie (see store.ts grantGreenroom). We
    // render a link rather than redirecting because this is usually loaded in a
    // frame, where a redirect would just draw HQ inside it.
    if (readCookie(request, COOKIE) !== (await tokenFor(env.APP_PASSCODE))) {
      return page(
        'Greenroom',
        `<h1>Locked</h1>
         <p>Unlock Logan HQ and this opens with it.</p>
         <p style="margin-top:1rem"><a href="/" target="_top">Go to Logan HQ</a></p>`,
        401,
      )
    }
  }

  // proxy through to the machine that belongs to whoever is asking
  const origin = mine?.origin || env.GREENROOM_ORIGIN
  if (!origin) {
    return page('Greenroom', '<h1>Not connected</h1><p>Set your own GREENROOM_ORIGIN first.</p>', 503)
  }
  const rest = url.pathname.slice(PREFIX.length) || '/'
  const target = new URL(rest + url.search, origin)

  const headers = new Headers(request.headers)
  headers.delete('cookie')
  headers.delete('host')
  headers.set('x-gr-key', mine?.key || env.GREENROOM_KEY || '')
  headers.set('x-forwarded-prefix', PREFIX)

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  let res: Response
  try {
    res = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    })
  } catch {
    return offlinePage()
  }
  // the tunnel answers with a gateway code when the laptop is asleep, and passing
  // that straight through meant Cloudflare's own error page instead of ours.
  // greenroom never produces these itself, so they can only mean the hop is down.
  if (res.status === 502 || res.status === 503 || res.status === 504 || res.status >= 520) {
    return offlinePage()
  }
  if (res.status === 404 && res.headers.get('content-type')?.startsWith('text/plain')) {
    // greenroom's own gate rejected us, which means the shared key is wrong
    return page('Greenroom', '<h1>Not connected</h1><p>The shared key does not match. Reset GREENROOM_KEY.</p>', 502)
  }

  const out = new Headers(res.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  out.delete('transfer-encoding')
  const loc = out.get('location')
  if (loc && loc.startsWith('/')) out.set('location', PREFIX + loc)

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}
