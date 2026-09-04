/**
 * Who is signed in, decided once at startup.
 *
 * There are two kinds of install and the app works out which one it is on rather
 * than being told:
 *
 *   ugcbeasts.com  sits behind Cloudflare Access, so signing in with Google has
 *                  already happened by the time any of this runs. /api/me comes
 *                  back with a verified email.
 *   logan-hq       has no Access in front, so /api/me answers 401 and the old
 *                  shared passcode screen is the way in.
 *
 * A person who has signed in but has not been approved yet gets 403 with
 * code "pending", which is a waiting screen and not an error.
 */

export interface Me {
  email: string
  isAdmin: boolean
  status: 'approved'
}

export type Session =
  | { kind: 'ready'; me: Me }
  | { kind: 'pending'; email: string }
  | { kind: 'passcode' }
  | { kind: 'offline' }

export async function loadSession(): Promise<Session> {
  let res: Response
  try {
    res = await fetch('/api/me', { headers: { accept: 'application/json' } })
  } catch {
    return { kind: 'offline' }
  }

  if (res.ok) {
    const me = (await res.json()) as Me
    return { kind: 'ready', me }
  }

  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; email?: string }
    if (body.code === 'pending') return { kind: 'pending', email: body.email || '' }
  }

  // 401 means no verified identity. On an Access install that should not happen
  // (Access would have redirected first), so treat it as the passcode install.
  if (res.status === 401) return { kind: 'passcode' }

  return { kind: 'offline' }
}

/** Sign out of Cloudflare Access. Only meaningful on the Access install. */
export const logoutUrl = '/cdn-cgi/access/logout'

/* Settled before <App/> ever renders, so a plain getter is enough and saves
   threading a context through every page. */
let current: Me | null = null
export const setMe = (me: Me | null) => {
  current = me
}
export const getMe = (): Me | null => current
