import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useDB } from '../../lib/store'
import {
  GreenroomOffline,
  deleteFormat,
  getState,
  pullShared,
  putShared,
  saveFormat,
  type GrFormat,
} from '../../lib/greenroom'
import { Button, EmptyState, Field, Modal, PageHeader, SectionHeader } from '../../components/ui'
import { LIME_DEEP, cx, inputCls } from '../../lib/tokens'
import { Icon } from '../../components/icons'

/**
 * Formats are the video styles, named after their hook ("How many X can i crack").
 * Each owns which campaigns can use it, the app it promotes, and the hook lines
 * written on the first screen. Who the video is about is picked per video in the
 * flow, not here, so one format covers every audience.
 */
export default function Formats() {
  const { campaigns } = useDB()
  const [formats, setFormats] = useState<GrFormat[] | null>(null)
  const [collections, setCollections] = useState<string[]>([])
  const [offline, setOffline] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<GrFormat | null>(null)

  /** Keep the team's copy in step with whatever this machine now has. */
  async function publish() {
    try {
      const s = await getState()
      await putShared(s.formats, s.audiences)
    } catch {
      /* the local save already worked; sharing it can wait for the next edit */
    }
  }

  async function load() {
    try {
      let s = await getState()
      // a fresh install starts with no formats; take the team's copy rather than
      // making the person rebuild all of them by hand
      if (s.formats.length === 0 && (await pullShared(s)) > 0) s = await getState()
      setFormats(s.formats)
      setCollections(
        [...new Set(s.library.map((a) => a.collection).filter(Boolean) as string[])].sort(),
      )
    } catch (e) {
      // anything other than "the laptop is asleep" needs saying out loud, or the
      // page just sits on Loading with no explanation
      if (e instanceof GreenroomOffline) setOffline(true)
      else setLoadError((e as Error).message)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.brand ?? id

  if (offline) {
    return (
      <div className="animate-in">
        <PageHeader title="Formats" />
        <EmptyState icon="film" title="Content is offline">
          It runs on your laptop, so the machine needs to be awake with the tunnel running.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="animate-in">
      <PageHeader
        title="Formats"
        action={
          formats && formats.length > 0 ? (
            <Button onClick={() => setEditing(blankFormat())}>
              <Icon name="plus" className="size-4" />
              New format
            </Button>
          ) : undefined
        }
      />

      {!formats ? (
        loadError ? (
          <p className="text-base font-medium text-red-600">Could not load: {loadError}</p>
        ) : (
          <p className="text-base font-medium text-neutral-500">Loading</p>
        )
      ) : formats.length === 0 ? (
        <EmptyState icon="film" title="No formats yet">
          <p>A format is a video style, named after its hook.</p>
          <Button className="mt-5" onClick={() => setEditing(blankFormat())}>
            <Icon name="plus" className="size-4" />
            New format
          </Button>
        </EmptyState>
      ) : (
        <section className="mb-14">
          <SectionHeader title="Your formats" />
          {/* pulled out by the row padding so the titles line up with the hairline above */}
          <div className="-mx-3">
            {formats.map((f) => {
              const shows = [
                `Promotes ${f.app}`,
                f.collection ? `${f.collection} images` : null,
              ]
                .filter(Boolean)
                .join(', ')
              const runsOn =
                f.campaigns.length === 0
                  ? `Any campaign named ${f.app
                      .split(',')
                      .map((a) => a.trim())
                      .filter(Boolean)
                      .join(' or ')}`
                  : f.campaigns.map(campaignName).join(', ')
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setEditing(f)}
                  className="group flex w-full items-center gap-4 px-3 py-4 text-left"
                >
                  <span className="grid size-12 shrink-0 place-items-center rounded-full border border-neutral-200 text-neutral-800">
                    <Icon name="film" className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-bold text-neutral-900">
                      {f.name}
                    </span>
                    <span className="mt-0.5 block truncate text-base font-medium text-neutral-500">
                      {shows}
                    </span>
                    <span className="block truncate text-base font-medium text-neutral-500">
                      {runsOn}
                    </span>
                  </span>
                  <Icon
        name="chevronLeft"
        className="size-5 shrink-0 rotate-180 text-neutral-300 transition-colors group-hover:text-neutral-900"
      />
                </button>
              )
            })}
          </div>
        </section>
      )}

      {editing && (
        <FormatEditor
          format={editing}
          campaigns={campaigns.map((c) => ({ id: c.id, name: c.brand }))}
          collections={collections}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await load()
            void publish()
          }}
          onDeleted={async () => {
            setEditing(null)
            await load()
            void publish()
          }}
        />
      )}
    </div>
  )
}


function blankFormat(): GrFormat {
  return {
    id: '',
    name: '',
    app: 'regen',
    campaigns: [],
    collection: '',
    cta: '',
    hookCollage: 0,
    hookStyle: 'bg',
    reference: '',
    // real defaults, not placeholder text: these get burned into the video, and
    // "Day {day} of ..." was ending up on screen verbatim
    dayHooks: ['Day {day} of seeing how many {aud} i can crack'],
    spanHooks: ['How many {Aud} can i crack in {span}'],
  }
}

/** Bold black group heading inside the editor, the way the reference breaks a long form up. */
function FormGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-4">
      <h3 className="text-lg font-bold text-neutral-900">{title}</h3>
      {children}
    </div>
  )
}

function FormatEditor({
  format,
  campaigns,
  collections,
  onClose,
  onSaved,
  onDeleted,
}: {
  format: GrFormat
  campaigns: { id: string; name: string }[]
  collections: string[]
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const [draft, setDraft] = useState<GrFormat>({ ...format })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = <K extends keyof GrFormat>(k: K, v: GrFormat[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const toggleCampaign = (id: string) =>
    set('campaigns', draft.campaigns.includes(id) ? draft.campaigns.filter((c) => c !== id) : [...draft.campaigns, id])

  async function save() {
    if (!draft.name.trim()) return setErr('Give it a name.')
    setBusy(true)
    setErr('')
    try {
      await saveFormat(draft)
      onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await deleteFormat(draft.id)
      onDeleted()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={format.id ? 'Edit format' : 'New format'}
      footer={
        // the one modal footer every editor in the app uses: stacked full width
        // pills matching the sheet shape, primary on top, then the way out, then
        // the quiet red delete last. Never side by side.
        <div className="flex w-full flex-col gap-2.5">
          <Button className="w-full" disabled={busy} onClick={save}>
            Save
          </Button>
          <Button variant="secondary" className="w-full" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {format.id && (
            <Button
              variant="danger"
              className="w-full"
              disabled={busy}
              onClick={() => {
                if (confirm(`Delete "${draft.name}"? Its hooks and reference script go with it.`)) void remove()
              }}
            >
              <Icon name="trash" className="size-4" />
              Delete
            </Button>
          )}
        </div>
      }
    >
      <div className="grid gap-8 pb-2">
        <FormGroup title="The format">
          <Field label="Name">
            <input
              className={inputCls}
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="How many X can i crack"
            />
          </Field>

          <Field
            label="Promotes"
            hint="Also matches this format to a campaign of the same name. Comma separate to run it under more than one, first is the tag."
          >
            <input
              className={inputCls}
              list="known-apps"
              value={draft.app}
              onChange={(e) => set('app', e.target.value)}
              placeholder="regen"
            />
            <datalist id="known-apps">
              <option value="regen" />
              <option value="halo" />
              <option value="roast" />
            </datalist>
          </Field>

          <Field label="Campaigns" hint="Also matched automatically to any campaign whose name contains the app it promotes">
            <div className="grid gap-1 sm:grid-cols-2">
              {campaigns.map((c) => {
                const on = draft.campaigns.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleCampaign(c.id)}
                    className="flex items-center gap-3 rounded-xl px-1 py-2 text-left text-base font-medium text-neutral-900"
                  >
                    <span
                      className={cx(
                        'grid size-5 shrink-0 place-items-center rounded-md',
                        !on && 'border border-neutral-400',
                      )}
                      style={on ? { background: LIME_DEEP, color: '#ffffff' } : undefined}
                    >
                      {on && <Icon name="check" className="size-3.5" />}
                    </span>
                    <span className="truncate">{c.name}</span>
                  </button>
                )
              })}
            </div>
          </Field>
        </FormGroup>

        <FormGroup title="What it shows">
          <Field
            label="Images"
            hint="Leave blank if the video is about a group, and the flow will ask who. Set it when the format shows a fixed pile of photos."
          >
            <input
              className={inputCls}
              list="known-collections"
              value={draft.collection ?? ''}
              onChange={(e) => set('collection', e.target.value)}
              placeholder="Ask per video"
            />
            <datalist id="known-collections">
              {collections.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>

          <Field
            label="Hook shows"
            hint="The 10/10 style opens on a grid of good photos rather than one image"
          >
            <select
              className={inputCls}
              value={draft.hookCollage ?? 0}
              onChange={(e) => set('hookCollage', Number(e.target.value))}
            >
              <option value={0}>One image</option>
              {[2, 3, 4, 6].map((n) => (
                <option key={n} value={n}>
                  A grid of {n} photos
                </option>
              ))}
            </select>
          </Field>

          <Field label="Hook look" hint="A red block covers a photo grid, so grid formats want the outline">
            <select
              className={inputCls}
              value={draft.hookStyle ?? 'bg'}
              onChange={(e) => set('hookStyle', e.target.value as 'bg' | 'outline')}
            >
              <option value="bg">White on red</option>
              <option value="outline">Outlined text, no box</option>
            </select>
          </Field>
        </FormGroup>

        <FormGroup title="The words">
          <Field label="CTA" hint="How the app gets worked in near the end">
            <textarea
              className={`${inputCls} min-h-20`}
              value={draft.cta ?? ''}
              onChange={(e) => set('cta', e.target.value)}
              placeholder="Take a photo of a guy women simp over and swap your face with his"
            />
          </Field>

          <Field
            label="Reference script"
            hint="Paste the spoken transcript of a real video in this format. Script generation copies its voice and structure."
          >
            <textarea
              className={`${inputCls} min-h-32`}
              value={draft.reference ?? ''}
              onChange={(e) => set('reference', e.target.value)}
              placeholder="Paste a transcript"
            />
          </Field>

          <HookList
            label="Hook lines when you say a day number"
            hint="One per line. {day} is the day you say, {aud} and {Aud} become whoever the video is about. Leave this empty when the format is a how to rather than a running challenge, and nothing in it will ever count days."
            value={draft.dayHooks}
            onChange={(v) => set('dayHooks', v)}
          />
          <HookList
            label="Hook lines otherwise"
            hint="One per line. {span} becomes the challenge length, for example a week or 30 days."
            value={draft.spanHooks}
            onChange={(v) => set('spanHooks', v)}
          />
        </FormGroup>

        {err && <p className="text-base font-medium text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}

function HookList({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: string[]
  onChange: (v: string[]) => void
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        className={`${inputCls} min-h-24 font-mono text-[15px]`}
        value={value.join('\n')}
        onChange={(e) => onChange(e.target.value.split('\n'))}
        spellCheck={false}
      />
    </Field>
  )
}
