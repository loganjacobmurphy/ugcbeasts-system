import { useEffect, useState, type ReactNode } from 'react'
import { Button, Field, PageHeader, SectionHeading } from '../components/ui'
import { Icon, type IconName } from '../components/icons'
import { inputCls } from '../lib/tokens'
import { getApiKey, setApiKey } from '../lib/store'
import { getMe, logoutUrl } from '../lib/session'

/**
 * Your own machine and your own keys.
 *
 * Two things are deliberately per-person rather than shared: greenroom, which
 * runs on your own computer so the rendering and the library are yours, and the
 * Anthropic key, so writing scripts is billed to whoever pressed the button.
 */

/* ------------------------------------------------------- local presentation */

/**
 * The spine of a settings page is the kit's heavy SectionHeading (bold, near
 * black, no hairline), not the quiet grey-on-a-hairline SectionHeader, which the
 * reference saves for date groups and minor sub-groups. All this wrapper adds is
 * the page's vertical rhythm between sections.
 */
function Section({ title, blurb, children }: { title: string; blurb?: string; children: ReactNode }) {
  return (
    <section className="mb-14 last:mb-0">
      <SectionHeading title={title} blurb={blurb} />
      {children}
    </section>
  )
}

/**
 * A settings row's leading element: a white circle with a hairline ring and a
 * dark outline glyph, not the filled grey disc used by list rows elsewhere.
 */
function RowIcon({ name }: { name: IconName }) {
  return (
    <span className="grid size-12 shrink-0 place-items-center rounded-full border border-neutral-200 text-neutral-900">
      <Icon name={name} className="size-5" />
    </span>
  )
}

/** Sign out has to stay an anchor so the href does the navigating, so it cannot
 *  use <Button>. These are Button's soft classes, kept in step by hand. */
const softLinkCls =
  'inline-flex shrink-0 items-center justify-center rounded-full bg-neutral-100 px-5 py-2.5 text-[15px] font-semibold text-neutral-900 transition-colors hover:bg-neutral-200'

/* ------------------------------------------------------------------ page */

export default function Settings() {
  const me = getMe()

  const [origin, setOrigin] = useState('')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [saved, setSaved] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const [aiKey, setAiKey] = useState('')
  const [aiSaved, setAiSaved] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings')
        if (res.ok) {
          const body = (await res.json()) as { greenroomOrigin: string; hasGreenroomKey: boolean }
          setOrigin(body.greenroomOrigin)
          setHasKey(body.hasGreenroomKey)
        }
      } catch {
        /* the form still works, it just starts empty */
      }
      setLoaded(true)
    })()
    setAiKey(getApiKey())
  }, [])

  async function save() {
    setBusy(true)
    setErr('')
    setSaved('')
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ greenroomOrigin: origin, greenroomKey: key }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) setErr(body.error || 'That did not save.')
      else {
        setSaved('Saved')
        if (key) setHasKey(true)
        setKey('')
      }
    } catch {
      setErr('Could not reach the server.')
    }
    setBusy(false)
  }

  return (
    <>
      <PageHeader title="Settings" />

      {me && (
        <Section title="Your account">
          <div className="flex items-center gap-4 py-3">
            <RowIcon name="at" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-bold text-neutral-900">Signed in</p>
              <p className="mt-0.5 truncate text-base font-medium text-neutral-500">{me.email}</p>
            </div>
            <a href={logoutUrl} className={softLinkCls}>
              Sign out
            </a>
          </div>
        </Section>
      )}

      <Section
        title="Your greenroom"
        blurb="Greenroom runs on your own computer, so the rendering, the clips and the library all stay yours. Install it, start the tunnel, then paste what it prints here."
      >
        <div className="flex max-w-2xl flex-col gap-6">
          <Field
            label="Address"
            hint="The https address your tunnel prints, for example https://greenroom-yourname.trycloudflare.com"
          >
            <input
              className={inputCls}
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="https://…"
              spellCheck={false}
              disabled={!loaded}
            />
          </Field>

          <Field
            label="Shared key"
            hint={
              hasKey ? 'A key is saved. Leave this blank to keep it.' : 'The GREENROOM_KEY value from your install.'
            }
          >
            <input
              className={inputCls}
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={hasKey ? '••••••••' : 'Paste your key'}
              spellCheck={false}
              disabled={!loaded}
            />
          </Field>

          <div>
            {/* the one lime action on this page: the key below is a soft Save so a
                single primary reads as primary */}
            <Button className="w-full" onClick={save} disabled={busy || !loaded}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            {saved && <p className="mt-3 text-center text-[15px] font-bold text-neutral-900">{saved}</p>}
            {err && <p className="mt-3 text-center text-[15px] font-semibold text-red-600">{err}</p>}
          </div>
        </div>
      </Section>

      <Section
        title="Your Anthropic key"
        blurb="Used when you generate scripts, so it goes on your own bill and not anyone else's. It stays in this browser and is only ever sent to this site."
      >
        <div className="flex max-w-2xl flex-col gap-6">
          <Field label="API key">
            <input
              className={inputCls}
              type="password"
              value={aiKey}
              onChange={(e) => {
                setAiKey(e.target.value)
                setAiSaved(false)
              }}
              placeholder="sk-ant-…"
              spellCheck={false}
            />
          </Field>
          <div>
            <Button
              variant="soft"
              className="w-full"
              onClick={() => {
                setApiKey(aiKey)
                setAiSaved(true)
              }}
            >
              Save
            </Button>
            {aiSaved && <p className="mt-3 text-center text-[15px] font-bold text-neutral-900">Saved</p>}
          </div>
        </div>
      </Section>
    </>
  )
}
