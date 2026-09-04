import { useEffect, useState, type FormEvent } from 'react'
import App from './App'
import { checkPasscode, enableCloud, getPasscode, grantGreenroom, setPasscode, syncFromCloud } from './lib/store'
import { loadSession, logoutUrl, setMe, type Session } from './lib/session'
import { BRAND } from './lib/brand'

type Phase = { kind: 'checking' } | { kind: 'locked' } | { kind: 'pending'; email: string } | { kind: 'ready' }

export default function Root() {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Local previews have no Pages Functions to verify a login against. This is
      // removed from production by Vite, so deployed builds still require Access
      // or the shared passcode.
      if (import.meta.env.DEV) {
        setPhase({ kind: 'ready' })
        return
      }
      const session: Session = await loadSession()
      if (cancelled) return

      if (session.kind === 'ready') {
        // signed in with Google and approved: nothing else to ask for
        setMe(session.me)
        enableCloud()
        await syncFromCloud()
        if (!cancelled) setPhase({ kind: 'ready' })
        return
      }

      if (session.kind === 'pending') {
        setPhase({ kind: 'pending', email: session.email })
        return
      }

      // no Access in front (or unreachable): the shared passcode is the way in
      const p = getPasscode()
      if (!p) {
        setPhase({ kind: 'locked' })
        return
      }
      const res = await checkPasscode(p)
      if (cancelled) return
      if (res === 'ok') {
        enableCloud()
        await grantGreenroom(p)
        await syncFromCloud()
        if (!cancelled) setPhase({ kind: 'ready' })
      } else if (res === 'offline') {
        setPhase({ kind: 'ready' }) // fall back to the local cache
      } else {
        setPhase({ kind: 'locked' }) // stored passcode no longer valid
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (phase.kind === 'checking') return <Splash />
  if (phase.kind === 'pending') return <Pending email={phase.email} />
  if (phase.kind === 'locked') return <Unlock onUnlock={() => setPhase({ kind: 'ready' })} />
  return <App />
}

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-base font-medium text-neutral-400">Loading…</p>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-2xl border-2 border-neutral-200 bg-white p-7 text-center">{children}</div>
    </div>
  )
}

/** Signed in, but nobody has let them in yet. */
function Pending({ email }: { email: string }) {
  return (
    <Card>
      <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-neutral-100 text-2xl">👋</div>
      <h1 className="mt-4 text-2xl font-bold text-neutral-900">You're on the list</h1>
      <p className="mt-1 text-base text-neutral-500">
        {email ? <>Signed in as {email}. </> : null}
        Your workspace administrator has to approve you before this opens. Reload once approved.
      </p>
      <button
        type="button"
        onClick={() => location.reload()}
        className="mt-5 w-full rounded-full bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800"
      >
        Check again
      </button>
      <a
        href={logoutUrl}
        className="mt-3 inline-block text-sm font-medium text-neutral-500 transition-colors hover:text-neutral-900"
      >
        Sign in with a different account
      </a>
    </Card>
  )
}

function Unlock({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const code = value.trim()
    if (!code || busy) return
    setBusy(true)
    setErr('')
    const res = await checkPasscode(code)
    setBusy(false)
    if (res === 'ok') {
      setPasscode(code)
      enableCloud()
      await grantGreenroom(code)
      await syncFromCloud()
      onUnlock()
    } else if (res === 'offline') {
      setErr('Can’t reach the server, check your connection and try again.')
    } else {
      setErr('Wrong passcode.')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border-2 border-neutral-200 bg-white p-7 text-center">
        <img
          src="/profile.svg"
          alt="Creator studio"
          className="mx-auto size-14 rounded-2xl object-cover"
          style={{ objectPosition: '50% 28%' }}
        />
        <h1 className="mt-4 text-2xl font-bold text-neutral-900">{BRAND}</h1>
        <p className="mt-1 text-base text-neutral-500">Enter your passcode to unlock</p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Passcode"
          autoFocus
          autoComplete="current-password"
          className="mt-5 w-full rounded-xl border-2 border-neutral-200 bg-white px-3 py-2.5 text-center text-base font-medium text-neutral-900 outline-none transition-colors focus:border-neutral-400"
        />
        {err && <p className="mt-2 text-sm font-medium text-red-500">{err}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded-full bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-40"
        >
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
