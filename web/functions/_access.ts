/**
 * Cloudflare Access token verification, shared by the API middleware and the
 * greenroom proxy.
 *
 * Access puts a signed JWT on every request that reaches an application behind
 * it. The signature is checked here rather than trusting the convenience header,
 * because the Pages origin is also reachable at <project>.pages.dev with no
 * Access in front of it. Anyone who knew that hostname could otherwise set
 * Cf-Access-Authenticated-User-Email by hand and be believed. A signature they
 * cannot forge closes that, whichever hostname the request arrives on.
 */

export interface AccessEnv {
  ACCESS_TEAM?: string
  ACCESS_AUD?: string
}

const b64url = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Cloudflare rotates these, so they are refetched hourly rather than pinned. */
let keyCache: { at: number; team: string; keys: Record<string, CryptoKey> } | null = null

async function signingKeys(team: string): Promise<Record<string, CryptoKey>> {
  if (keyCache && keyCache.team === team && Date.now() - keyCache.at < 3_600_000) {
    return keyCache.keys
  }
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`could not fetch Access keys (${res.status})`)
  const { keys } = (await res.json()) as { keys: JsonWebKey[] }

  const out: Record<string, CryptoKey> = {}
  for (const jwk of keys) {
    const kid = (jwk as { kid?: string }).kid
    if (!kid) continue
    out[kid] = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  }
  keyCache = { at: Date.now(), team, keys: out }
  return out
}

/** True when this deployment is gated by Access at all. */
export const accessConfigured = (env: AccessEnv): boolean =>
  Boolean(env.ACCESS_TEAM && env.ACCESS_AUD)

/**
 * The verified email, or null. Never throws on a bad token: a bad token is
 * simply "not signed in", and an exception here would read as a 500.
 */
export async function verifiedEmail(request: Request, env: AccessEnv): Promise<string | null> {
  if (!accessConfigured(env)) return null

  const token =
    request.headers.get('cf-access-jwt-assertion') ||
    (request.headers.get('cookie') || '').match(/CF_Authorization=([^;]+)/)?.[1]
  if (!token) return null

  const [h, p, s] = token.split('.')
  if (!h || !p || !s) return null

  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { kid?: string; alg?: string }
    if (header.alg !== 'RS256' || !header.kid) return null

    const key = (await signingKeys(env.ACCESS_TEAM as string))[header.kid]
    if (!key) return null

    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64url(s),
      new TextEncoder().encode(`${h}.${p}`),
    )
    if (!ok) return null

    const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as {
      email?: string
      aud?: string[] | string
      exp?: number
    }
    // expired, or minted for a different Access application, is not ours
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(env.ACCESS_AUD as string)) return null

    return (claims.email || '').trim().toLowerCase() || null
  } catch {
    return null
  }
}
