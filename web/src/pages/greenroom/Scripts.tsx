import { useEffect, useState, type ReactNode } from 'react'
import { useDB } from '../../lib/store'
import { getApiKey, getPasscode, setApiKey } from '../../lib/store'
import {
  GreenroomOffline,
  formatsForCampaign,
  getFunnel,
  getState,
  type GrAudience,
  type GrFormat,
  type GrFunnel,
} from '../../lib/greenroom'
import { Button, EmptyState, PageHeader } from '../../components/ui'
import { inputCls, tones } from '../../lib/tokens'
import { Icon } from '../../components/icons'

interface Script {
  hook: string
  script: string
}

/**
 * The reference's real section heading: bold black, no rule under it. The kit's
 * SectionHeader is the quieter grey-on-a-hairline variant, which the reference
 * keeps for date groups and minor sub-groups, not for the sections of a page.
 */
function Heading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <h2 className="text-xl font-bold text-neutral-900">{children}</h2>
      {action}
    </div>
  )
}

/**
 * Form label, bold and near-black above the input. The kit's Field renders the
 * grey list-style label instead, which reads as a caption rather than a question.
 */
function FormField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[15px] font-bold text-neutral-900">{label}</span>
      <div className="mt-2">{children}</div>
      {hint && <p className="mt-2 text-[15px] font-medium text-neutral-500">{hint}</p>}
    </label>
  )
}

/**
 * Writes the words Logan reads to camera. Grounded in the format's reference
 * transcript so the output is the next video in that series, not a new format.
 */
export default function Scripts() {
  const { campaigns } = useDB()
  const [formats, setFormats] = useState<GrFormat[] | null>(null)
  const [audiences, setAudiences] = useState<GrAudience[]>([])
  const [offline, setOffline] = useState(false)
  const [loadError, setLoadError] = useState('')

  const [campaignId, setCampaignId] = useState('')
  const [formatId, setFormatId] = useState('')
  const [audienceId, setAudienceId] = useState('')
  const [count, setCount] = useState(3)
  const [sent, setSent] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scripts, setScripts] = useState<Script[]>([])
  // kept alongside the scripts so he can see which set of stats belongs to which
  const [plan, setPlan] = useState<GrFunnel[]>([])
  const [copied, setCopied] = useState<number | null>(null)
  const [editingKey, setEditingKey] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [hasKey, setHasKey] = useState(() => Boolean(getApiKey()))

  useEffect(() => {
    getState()
      .then((s) => {
        setFormats(s.formats)
        setAudiences(s.audiences ?? [])
      })
      .catch((e) => (e instanceof GreenroomOffline ? setOffline(true) : setLoadError((e as Error).message)))
  }, [])

  const campaign = campaigns.find((c) => c.id === campaignId)
  const writableCampaigns = formats
    ? campaigns.filter((c) => formatsForCampaign(formats, c.id, c.brand).length > 0)
    : campaigns
  const available = formats ? formatsForCampaign(formats, campaignId, campaign?.brand) : []
  const format = formats?.find((f) => f.id === formatId)
  const audience = audiences.find((a) => a.id === audienceId)

  /**
   * How many profiles he says he swiped right on. Takes "50,000", "50k" or
   * "50000", because the
   * funnel is built from this number and the whole script is built from the funnel:
   * typing it into the notes box did nothing, since the numbers were already fixed
   * before the model ever saw them.
   */
  function parseSent(s: string): number | null {
    const t = s.trim().toLowerCase().replace(/[,\s]/g, '')
    if (!t) return null
    const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t)
    if (!m) return null
    const n = Number(m[1]) * (m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1)
    return Number.isFinite(n) && n >= 100 ? Math.round(n) : null
  }

  const sentN = parseSent(sent)
  const sentBad = sent.trim() !== '' && sentN === null

  /** One audience per script, shuffled, cycling if there are more scripts than audiences. */
  function randomAudiencePlan(): string[] {
    const words = audiences.map((a) => a.word).filter(Boolean)
    if (!words.length) return []
    // a comparator shuffle is not uniform; one audience was winning ~30% of slots
    const bag = [...words]
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    return Array.from({ length: count }, (_, i) => bag[i % bag.length])
  }

  async function generate() {
    if (!format) return
    setBusy(true)
    setError('')
    setScripts([])
    try {
      // One funnel PER SCRIPT. Each script is a different video with its own
      // stats, so a single set shared across the batch gave five videos claiming
      // identical numbers. The backgrounds are generated from these same figures,
      // so the voiceover has to match them or it contradicts what is on screen.
      const funnelPlan = format.statsFunnel
        ? await Promise.all(Array.from({ length: count }, () => getFunnel(sentN ?? 100000)))
        : undefined
      const res = await fetch('/api/script', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-passcode': getPasscode(),
          // your key, your bill; falls back to the project key when unset
          ...(getApiKey() ? { 'x-anthropic-key': getApiKey() } : {}),
        },
        body: JSON.stringify({
          formatName: format.name,
          reference: format.reference,
          cta: format.cta,
          hooks: [...format.dayHooks, ...format.spanHooks],
          // no day hooks means this is not a running challenge, so nothing in it
          // should open on "day 6 of". A how to has no day 6.
          countsDays: format.dayHooks.length > 0,
          // a format can run under two deals; tell it only the one this video is for
          app: campaign?.brand
            ? (format.app.split(',').map((a) => a.trim()).find((a) => campaign.brand.toLowerCase().includes(a.toLowerCase())) ?? format.app)
            : format.app,
          // a format with its own photos is not about a group, and a stale pick
          // here made the model write the whole script about that group
          audience: format.collection ? undefined : audience?.word,
          // "Random each script" spreads his real audiences across the batch, so the
          // model never invents its own (gym girls, nurses) to fill the gap
          audiencePlan: audience || format.collection ? undefined : randomAudiencePlan(),
          campaign: campaign?.brand,
          funnelPlan,
          count,
          notes: notes.trim() || undefined,
        }),
      })
      // a 401 or a Cloudflare error page is HTML, and blindly parsing it as JSON
      // surfaced a javascript parser message instead of what actually went wrong
      const raw = await res.text()
      let data: { scripts?: Script[]; error?: string } = {}
      try {
        data = JSON.parse(raw) as typeof data
      } catch {
        /* not json */
      }
      if (!res.ok || data.error) {
        throw new Error(
          data.error || (res.status === 401 ? 'Wrong passcode, sign in again.' : `Failed (${res.status})`),
        )
      }
      setScripts(data.scripts ?? [])
      setPlan(funnelPlan ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (offline) {
    return (
      <div className="animate-in">
        <PageHeader title="Scripts" />
        <EmptyState icon="film" title="Content is offline">
          It runs on your laptop, so the machine needs to be awake with the tunnel running.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="animate-in">
      <PageHeader title="Scripts" />

      {loadError && <p className="mb-6 text-base font-semibold text-red-600">Could not load: {loadError}</p>}

      {/* The reference keeps a form narrower than the content column it sits in,
          so a two column grid of fields never stretches into a wall. */}
      <section className="mb-14 max-w-3xl">
        <Heading>What to write</Heading>

        <div className="grid gap-6 sm:grid-cols-2">
          <FormField label="Campaign">
            <select
              className={inputCls}
              value={campaignId}
              onChange={(e) => {
                setCampaignId(e.target.value)
                setFormatId('')
              }}
            >
              <option value="">Pick a campaign</option>
              {writableCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.brand}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Format">
            <select
              className={inputCls}
              value={formatId}
              onChange={(e) => {
                setFormatId(e.target.value)
                setAudienceId('')
              }}
              disabled={!campaignId}
            >
              <option value="">{campaignId ? 'Pick a format' : 'Pick a campaign first'}</option>
              {available.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </FormField>

          <FormField
            label="Who it is about"
            hint={
              format?.collection
                ? 'This format is not about a group, so this is ignored'
                : 'Random gives each script a different one of yours'
            }
          >
            <select
              className={inputCls}
              value={audienceId}
              onChange={(e) => setAudienceId(e.target.value)}
              disabled={!!format?.collection}
            >
              <option value="">Random each script</option>
              {audiences.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </FormField>

          {format?.statsFunnel && (
            <FormField
              label="How many profiles you swiped right on"
              hint={sentBad ? 'Give it a number, like 50,000 or 50k' : 'Blank uses 100,000'}
            >
              <input
                className={inputCls}
                value={sent}
                onChange={(e) => setSent(e.target.value)}
                placeholder="100,000"
                inputMode="numeric"
              />
            </FormField>
          )}

          <div className="sm:col-span-2">
            {/* Was four preset pills, so any other number was impossible. The API
                caps a batch at 8, which is why the input stops there. */}
            <FormField label="How many scripts" hint="Up to 8 in one batch.">
              <input
                type="number"
                min={1}
                max={8}
                value={count}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  setCount(Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : 1)
                }}
                className={inputCls}
                style={{ maxWidth: '9rem' }}
              />
            </FormField>
          </div>

          <div className="sm:col-span-2">
            <FormField label="Anything specific for this batch" hint="Optional">
              <input
                className={inputCls}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Lean harder on the chain reveal"
              />
            </FormField>
          </div>
        </div>

        {format && !format.reference && (
          <p
            className="mt-6 rounded-2xl px-5 py-4 text-[15px] font-medium"
            style={{ background: tones.yellow.bg, color: tones.yellow.fg }}
          >
            This format has no reference script, so the output will be looser. Paste a transcript on the Formats
            page.
          </p>
        )}

        {error && <p className="mt-4 text-base font-semibold text-red-600">{error}</p>}

        <div className="mt-6">
          <Button className="w-full" disabled={!format || busy || sentBad} onClick={generate}>
            {busy ? 'Writing…' : 'Write scripts'}
          </Button>
        </div>
      </section>

      {/* Writing scripts costs money on an Anthropic key. Whose key that is
          should be obvious from this screen, because this is the button that
          spends it. */}
      <section className="mb-14 max-w-3xl">
        <Heading>Billing</Heading>

        {!editingKey ? (
          <div className="flex items-center gap-4 py-2">
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-600">
              <Icon name="dollar" className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-bold text-neutral-900">Anthropic API key</span>
              <span className="mt-0.5 block text-base font-medium text-neutral-500">
                {hasKey ? 'Billed to your own key.' : "Billed to the account owner's key."}
              </span>
            </span>
            <Button
              variant="soft"
              onClick={() => {
                setKeyDraft(getApiKey())
                setEditingKey(true)
              }}
            >
              {hasKey ? 'Change' : 'Use your own'}
            </Button>
          </div>
        ) : (
          <FormField
            label="Your Anthropic API key"
            hint="Stays in this browser and is only ever sent to this app. Leave empty to go back to the shared key."
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                className={inputCls}
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="sk-ant-..."
                autoComplete="off"
              />
              <Button
                variant="soft"
                className="shrink-0"
                onClick={() => {
                  setApiKey(keyDraft)
                  setHasKey(Boolean(keyDraft.trim()))
                  setEditingKey(false)
                }}
              >
                Save
              </Button>
            </div>
          </FormField>
        )}
      </section>

      {scripts.length > 0 && (
        <section className="mb-14">
          <Heading
            action={
              <span className="text-base font-medium text-neutral-500">
                {scripts.length} {scripts.length === 1 ? 'script' : 'scripts'}
              </span>
            }
          >
            What it wrote
          </Heading>

          <div className="divide-y divide-neutral-200 border-t border-neutral-200">
            {scripts.map((s, i) => (
              <article key={i} className="flex items-start gap-4 py-6">
                <span className="grid size-12 shrink-0 place-items-center rounded-full bg-neutral-100 text-[15px] font-bold text-neutral-600">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-bold text-neutral-900">{s.hook}</p>
                  <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-neutral-700">{s.script}</p>
                  {plan[i] && (
                    <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[15px] font-medium text-neutral-500">
                      <span>swiped right {plan[i].sent.toLocaleString()}</span>
                      <span>matched {plan[i].opened.toLocaleString()}</span>
                      <span>did not match {plan[i].notOpened.toLocaleString()}</span>
                      <span>replied {plan[i].responded.toLocaleString()}</span>
                      <span>said no {plan[i].saidNo.toLocaleString()}</span>
                      <span>said yes {plan[i].saidYes.toLocaleString()}</span>
                      <span className="font-bold text-neutral-900">cracked {plan[i].cracked.toLocaleString()}</span>
                    </p>
                  )}
                </div>
                <Button
                  variant="soft"
                  className="shrink-0"
                  onClick={() => {
                    void navigator.clipboard.writeText(s.script)
                    setCopied(i)
                    setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500)
                  }}
                >
                  {copied === i && <Icon name="check" className="size-4" />}
                  {copied === i ? 'Copied' : 'Copy'}
                </Button>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
