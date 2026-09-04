import { useEffect, useState } from 'react'
import {
  GreenroomOffline,
  cardUrl,
  cardsPreview,
  cardsZipUrl,
  getState,
  type GrAudience,
  type GrCardExport,
} from '../../lib/greenroom'
import { Button, EmptyState, Field, PageHeader } from '../../components/ui'
import { inputCls } from '../../lib/tokens'

/**
 * Backgrounds for a script, with no video behind them.
 *
 * Some videos get cut by hand elsewhere, but their backgrounds are still generated
 * here: the Hinge swipe screen and the four funnel graphics are drawn from the numbers in the
 * script. Getting them used to mean making a throwaway video and binning it after.
 */
export default function Backgrounds() {
  const [audiences, setAudiences] = useState<GrAudience[]>([])
  const [text, setText] = useState('')
  const [audience, setAudience] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [offline, setOffline] = useState(false)
  const [out, setOut] = useState<GrCardExport | null>(null)

  useEffect(() => {
    getState()
      .then((s) => {
        setAudiences(s.audiences)
        setAudience((a) => a || s.audiences[0]?.id || '')
      })
      .catch((e) => setOffline(e instanceof GreenroomOffline))
  }, [])

  async function run() {
    if (!text.trim()) {
      setError('Paste the script first')
      return
    }
    setBusy(true)
    setError('')
    try {
      setOut(await cardsPreview(text, audience))
    } catch (e) {
      // The 422 is the useful one: it means the numbers could not be read, and that
      // message names what is missing, so it is worth showing in full.
      setOut(null)
      setError(e instanceof GreenroomOffline ? 'Greenroom is not reachable' : (e as Error).message)
    }
    setBusy(false)
  }

  if (offline) {
    return (
      <>
        <PageHeader title="Backgrounds" />
        <EmptyState title="Greenroom is offline">
          It runs on your laptop, so it needs the machine awake with the tunnel running.
        </EmptyState>
      </>
    )
  }

  const f = out?.funnel
  const nums: [string, number][] = f
    ? [
        ['swiped right', f.sent],
        ['matched', f.opened],
        ['did not match', f.notOpened],
        ['replied', f.responded],
        ['said no', f.saidNo],
        ['said yes', f.saidYes],
        ['got', f.cracked],
      ]
    : []

  return (
    <>
      <PageHeader title="Backgrounds" />
      <p className="mb-6 text-[15px] font-medium text-neutral-500">
        Paste a script and take the backgrounds, no video needed. Same images a video
        built in greenroom would get.
      </p>

      <div className="max-w-2xl space-y-5">
        <Field label="The script">
          <textarea
            rows={8}
            className={inputCls}
            placeholder="I'm going on a mission to see how many..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>

        <Field label="Whose profile appears on the Hinge swipe card">
          <select className={inputCls} value={audience} onChange={(e) => setAudience(e.target.value)}>
            {audiences.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>

        {error && (
          <p className="text-[15px] font-semibold text-red-600">{error}</p>
        )}

        <Button onClick={run} disabled={busy}>
          {busy ? 'Drawing...' : out ? 'Draw again' : 'Make the backgrounds'}
        </Button>
      </div>

      {out && (
        <div className="mt-10">
          {/* The numbers sit next to the pictures on purpose. Reading them back wrong
              is the failure that keeps recurring, and catching it here against the
              script is far cheaper than after the video is cut together. */}
          <h2 className="text-xl font-bold text-neutral-900">What it read out of that script</h2>
          <div className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
            {nums.map(([k, v]) => (
              <div key={k}>
                <div className="text-[13px] font-medium text-neutral-500">{k}</div>
                <div className="text-xl font-bold text-neutral-900">{v.toLocaleString()}</div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[15px] font-medium text-neutral-500">
            Match rate {((f!.opened / f!.sent) * 100).toFixed(1)}%. Check these against the
            script before you use them.
          </p>
          {out.note && (
            <p className="mt-2 text-[15px] font-semibold text-red-600">{out.note}</p>
          )}

          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {out.cards.map((c) => (
              <a
                key={c.file}
                href={cardUrl(c.url)}
                download={c.file}
                className="group block"
                title={`Download ${c.name}`}
              >
                <img
                  src={cardUrl(c.thumb || c.url)}
                  alt=""
                  className="aspect-[9/16] w-full rounded-xl border-2 border-neutral-200 object-cover transition-colors group-hover:border-neutral-400"
                />
                <span className="mt-2 block text-center text-[13px] font-medium text-neutral-500">
                  {c.name}
                </span>
              </a>
            ))}
          </div>

          <a href={cardsZipUrl(out.token)} className="mt-6 inline-block">
            <Button>Download all 5</Button>
          </a>
        </div>
      )}
    </>
  )
}
