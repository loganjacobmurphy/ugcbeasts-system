/**
 * Cloudflare Access token verification.
 *
 * The point of this file is the first block. If a genuine token were ever
 * rejected, signing in would fail for everyone with no way back in, and that is
 * not something to discover in production. The rest checks that forged, expired
 * and downgraded tokens stay refused.
 *
 * Run with:  npm test
 */
import { verifiedEmail, accessConfigured } from '../functions/_access.ts'

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
const enc = new TextEncoder()

const kp = await crypto.subtle.generateKey(
  { name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' },
  true, ['sign','verify'])
const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
const KID = 'testkid1'
Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' })

// stand in for Cloudflare's certs endpoint
globalThis.fetch = async (url) => {
  if (!String(url).includes('/cdn-cgi/access/certs')) throw new Error('unexpected fetch ' + url)
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })
}

const AUD = 'aud-for-ugcbeasts'
const env = { ACCESS_TEAM: 'example-team', ACCESS_AUD: AUD }

async function mint({ email='creator@example.com', aud=AUD, exp=Math.floor(Date.now()/1000)+3600,
                      alg='RS256', kid=KID, tamper=false } = {}) {
  const h = b64u(enc.encode(JSON.stringify({ alg, kid, typ:'JWT' })))
  const p = b64u(enc.encode(JSON.stringify({ email, aud:[aud], exp })))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, enc.encode(`${h}.${p}`))
  let s = b64u(sig)
  if (tamper) s = s.slice(0,-4) + (s.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA')
  return `${h}.${p}.${s}`
}
const reqWith = (tok, header='cf-access-jwt-assertion') =>
  new Request('https://ugcbeasts.com/api/me', { headers: { [header]: tok } })

let pass = 0, fail = 0
const check = (name, got, want) => {
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

console.log('\n  THE ONE THAT MATTERS: a real token is accepted')
check('valid token -> email', await verifiedEmail(reqWith(await mint()), env), 'creator@example.com')
check('email is lowercased', await verifiedEmail(reqWith(await mint({email:'Creator@Example.com'})), env), 'creator@example.com')
check('gmail address works', await verifiedEmail(reqWith(await mint({email:'viewer@example.net'})), env), 'viewer@example.net')
check('cookie instead of header', await verifiedEmail(
  new Request('https://ugcbeasts.com/', { headers:{ cookie:`CF_Authorization=${await mint()}; other=x` } }), env), 'creator@example.com')

console.log('\n  forged and broken tokens are refused')
check('tampered signature', await verifiedEmail(reqWith(await mint({tamper:true})), env), null)
check('expired', await verifiedEmail(reqWith(await mint({exp:Math.floor(Date.now()/1000)-10})), env), null)
check('aud for another app', await verifiedEmail(reqWith(await mint({aud:'someone-elses-app'})), env), null)
check('alg none downgrade', await verifiedEmail(reqWith(await mint({alg:'none'})), env), null)
check('unknown kid', await verifiedEmail(reqWith(await mint({kid:'not-a-real-kid'})), env), null)
check('garbage token', await verifiedEmail(reqWith('aaa.bbb.ccc'), env), null)
check('empty token', await verifiedEmail(reqWith(''), env), null)
check('spoofed email header only', await verifiedEmail(
  new Request('https://ugcbeasts.com/', { headers:{ 'cf-access-authenticated-user-email':'creator@example.com' } }), env), null)

console.log('\n  install detection')
check('access configured', accessConfigured(env), true)
check('no vars -> passcode install', accessConfigured({}), false)
check('unconfigured never authenticates', await verifiedEmail(reqWith(await mint()), {}), null)

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
