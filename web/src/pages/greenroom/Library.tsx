import { useEffect, useRef, useState } from 'react'
import { useDB } from '../../lib/store'
import {
  GreenroomOffline,
  assetThumb,
  assetUrl,
  deleteAsset,
  getState,
  setAssetCampaign,
  setAssetCollection,
  setAssetKind,
  uploadAsset,
  type GrAsset,
  type GrAudience,
} from '../../lib/greenroom'
import { Button, EmptyState, Modal, PageHeader, SectionHeader } from '../../components/ui'
import { LIME, LIME_DEEP, cx } from '../../lib/tokens'
import { Icon } from '../../components/icons'

type Tab = 'campaign' | 'images'

/**
 * Two libraries in one page, because they are used at different moments:
 *
 *  - Campaign assets: app screenshots, store cards, demo clips. Tagged to a campaign
 *    and dropped into videos for that deal.
 *  - Images: the green screen backgrounds, tagged by audience so a Femboys video
 *    only ever pulls from the femboy pile.
 */
export default function Library() {
  const { campaigns } = useDB()
  const [assets, setAssets] = useState<GrAsset[] | null>(null)
  const [audiences, setAudiences] = useState<GrAudience[]>([])
  const [formatCollections, setFormatCollections] = useState<string[]>([])
  const [servedShotTypes, setServedShotTypes] = useState<string[]>([])
  const [offline, setOffline] = useState(false)
  const [loadError, setLoadError] = useState('')
  // Images first: the green screen photos are what the videos are actually
  // built from, campaign assets are the occasional extra.
  const [tab, setTab] = useState<Tab>('images')
  const [filter, setFilter] = useState('')
  // second-level filter: which shot type, within the chosen collection
  const [kind, setKind] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  // the file waiting on the delete confirmation sheet, so the page asks in its
  // own voice instead of throwing an OS confirm() dialog
  const [pendingDelete, setPendingDelete] = useState<GrAsset | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function load() {
    try {
      const s = await getState()
      setAssets(s.library)
      setAudiences(s.audiences ?? [])
      // formats can own a collection of their own, which needs a chip too
      setServedShotTypes(s.shotTypes ?? [])
      setFormatCollections(
        [...new Set((s.formats ?? []).map((f) => f.collection).filter(Boolean) as string[])].sort(),
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

  // campaign assets are the app folder; images are everything scenes pull from
  const IMAGE_FOLDERS = ['people', 'backgrounds', 'extra', 'hinge']
  const pool = (assets ?? []).filter((a) =>
    tab === 'campaign' ? a.folder === 'app' || a.folder === 'inserts' : IMAGE_FOLDERS.includes(a.folder),
  )
  const inCollection = pool.filter((a) =>
    !filter ? true : tab === 'campaign' ? a.campaign === filter : a.collection === filter,
  )
  const shown = kind
    ? inCollection.filter((a) => (kind === '__untagged' ? !a.kind : a.kind === kind))
    : inCollection

  // shot types offered: the ones the scripts call for, plus anything already used
  const shotTypes = [...new Set([...servedShotTypes, ...(pool.map((a) => a.kind).filter(Boolean) as string[])])]

  // Shot types describe how a photo is framed (face shot, on a boat, night out),
  // which only means anything for a fixed pile like "good photos". An audience
  // collection is a group of people, so the whole row is noise there. Format
  // collections are exactly the ones no audience claims, so this needs no list
  // of hardcoded names and picks up any new pile on its own.
  const isFixedPile = !!filter && !audiences.some((a) => a.collection === filter)

  // Only the deals actually running. Every campaign he has ever had made this a
  // row of seven chips, five of them finished and none of them anything he would
  // file a new asset against. An ended campaign that still holds assets keeps its
  // chip, so nothing already tagged becomes unreachable.
  const liveCampaigns = campaigns.filter(
    (c) =>
      c.status === 'active' ||
      c.status === 'upcoming' ||
      pool.some((a) => a.campaign === c.id),
  )

  const chips =
    tab === 'campaign'
      ? liveCampaigns.map((c) => ({
          value: c.id,
          label: c.brand,
          count: pool.filter((a) => a.campaign === c.id).length,
        }))
      : [
          ...audiences.map((a) => ({ value: a.collection, label: a.label })),
          ...formatCollections
            .filter((c) => !audiences.some((a) => a.collection === c))
            .map((c) => ({ value: c, label: c })),
        ].map((c) => ({ ...c, count: pool.filter((x) => x.collection === c.value).length }))

  async function onFiles(list: FileList | null) {
    if (!list?.length) return
    setBusy(true)
    setActionError('')
    try {
      for (const f of [...list]) {
        await uploadAsset(f, {
          // `app` is for a specific deal's own material, its screens and store
          // cards. Something dropped in with no campaign picked is not that: it is
          // general footage that any video can use, so it goes to `inserts`, which
          // greenroom already treats the same way when it fills a scene.
          folder: tab === 'campaign' ? (filter ? 'app' : 'inserts') : 'people',
          campaign: tab === 'campaign' ? filter : undefined,
          collection: tab === 'images' ? filter : undefined,
          kind: tab === 'images' && kind && kind !== '__untagged' ? kind : undefined,
        })
      }
      await load()
    } catch (e) {
      // these used to fail in total silence: the file simply never appeared
      setActionError((e as Error).message || 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function retag(a: GrAsset, value: string) {
    try {
      if (tab === 'campaign') await setAssetCampaign(a.id, value)
      else await setAssetCollection(a.id, value)
      await load()
    } catch (e) {
      setActionError((e as Error).message || 'Could not retag that')
    }
  }

  async function confirmDelete() {
    const a = pendingDelete
    if (!a) return
    setPendingDelete(null)
    try {
      await deleteAsset(a.id)
      await load()
    } catch (e) {
      setActionError((e as Error).message || 'Could not delete that')
    }
  }

  async function retagKind(a: GrAsset, value: string) {
    try {
      await setAssetKind(a.id, value)
      await load()
    } catch (e) {
      setActionError((e as Error).message || 'Could not set the shot type')
    }
  }

  if (offline) {
    return (
      <div className="animate-in">
        <PageHeader title="Library" />
        <EmptyState icon="film" title="Content is offline">
          It runs on your laptop, so the machine needs to be awake with the tunnel running.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="animate-in">
      <PageHeader
        title="Library"
        action={
          <Button disabled={busy} onClick={() => inputRef.current?.click()}>
            <Icon name="plus" className="size-4" />
            {busy ? 'Uploading' : 'Add files'}
          </Button>
        }
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          void onFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {/* Segmented switch, the reference's own two-way toggle: a sand track with
          the live half lifted out in white. */}
      <div className="mb-12 flex rounded-full bg-[#f0efeb] p-1">
        {(
          [
            ['images', 'Images'],
            ['campaign', 'Campaign assets'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key)
              setFilter('')
              setKind('')
            }}
            className={cx(
              'flex-1 rounded-full px-5 py-2.5 text-base font-semibold transition-colors',
              tab === key ? 'bg-white' : 'hover:bg-white/50',
            )}
            style={{ color: LIME_DEEP }}
          >
            {label}
          </button>
        ))}
      </div>

      {actionError && (
        <div className="mb-6">
          <ErrorNote>{actionError}</ErrorNote>
        </div>
      )}

      <section className="mb-12">
        <SectionHeader title={tab === 'campaign' ? 'Campaign' : 'Collection'} />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Chip on={!filter} count={pool.length} onClick={() => { setFilter(''); setKind('') }}>
            Everything
          </Chip>
          {chips.map((c) => (
            <Chip
              key={c.value}
              on={filter === c.value}
              count={c.count}
              onClick={() => { setFilter(c.value); setKind('') }}
            >
              {c.label}
            </Chip>
          ))}
        </div>
      </section>

      {tab === 'images' && isFixedPile && (
        <section className="mb-12">
          <SectionHeader title="Shot type" />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Chip on={!kind} count={inCollection.length} onClick={() => setKind('')}>
              All shots
            </Chip>
            {shotTypes.map((k) => (
              <Chip
                key={k}
                on={kind === k}
                count={inCollection.filter((a) => a.kind === k).length}
                onClick={() => setKind(k)}
              >
                {k}
              </Chip>
            ))}
            <Chip
              on={kind === '__untagged'}
              count={inCollection.filter((a) => !a.kind).length}
              onClick={() => setKind('__untagged')}
            >
              Untagged
            </Chip>
          </div>
        </section>
      )}

      {!assets ? (
        loadError ? (
          <ErrorNote>Could not load: {loadError}</ErrorNote>
        ) : (
          <Loading />
        )
      ) : shown.length === 0 ? (
        <EmptyState icon="image" title="Nothing here yet">
          {tab === 'campaign'
            ? 'App screenshots and store cards for a campaign live here.'
            : 'Green screen images live here, tagged by who the video is about.'}
        </EmptyState>
      ) : (
        <section>
          <SectionHeader title={`${shown.length} ${shown.length === 1 ? 'file' : 'files'}`} />
          <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {shown.map((a) => (
              <AssetCard
                key={a.id}
                asset={a}
                tagValue={tab === 'campaign' ? (a.campaign ?? '') : (a.collection ?? '')}
                options={chips.map((c) => ({ value: c.value, label: c.label }))}
                onRetag={(v) => retag(a, v)}
                kindValue={tab === 'images' ? (a.kind ?? '') : undefined}
                kindOptions={shotTypes}
                onRetagKind={(v) => retagKind(a, v)}
                onDelete={() => setPendingDelete(a)}
              />
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this file?"
        body={`${pendingDelete?.name ?? 'This file'} will be removed for good. You cannot undo this.`}
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  )
}

/* --------------------------------------------------------- shared-in-waiting
 * Loading, ErrorNote and ConfirmDialog belong in components/ui.tsx so all six
 * greenroom pages say the same thing at the same weight, and so no page falls
 * back to a browser confirm() with no brand on it. They live here for now only
 * because this pass owns Library.tsx alone; lift them into the kit and swap
 * these three for imports when the kit is next edited.
 */

/** One loading line for the app: same string, same weight, everywhere. */
function Loading() {
  return <p className="text-base font-medium text-neutral-500">Loading…</p>
}

/** One failure line for the app. Red is only ever used for this and destruction. */
function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p className="text-base font-semibold text-red-600">{children}</p>
}

/**
 * The destructive confirmation, lifted from the video delete sheet in Edit.tsx.
 * The reference stacks a confirm over its way out, both full width, never side
 * by side.
 */
function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  body: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="w-full space-y-2.5">
          <Button variant="destructive" className="w-full" onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button variant="soft" className="w-full" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <p className="text-base font-medium text-neutral-500">{body}</p>
    </Modal>
  )
}

/**
 * The one filter chip shape the whole app uses, matching Videos: a grey fill
 * when off, the lime of the primary button when on, and the count carried
 * inside the same pill rather than beside it. This page used to draw a white
 * pill with a grey outline instead, so the app shipped two chip styles.
 * aria-pressed is what announces the on state, so no cross glyph is needed.
 */
function Chip({
  on,
  count,
  onClick,
  children,
}: {
  on: boolean
  count: number
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cx(
        'inline-flex items-center gap-2 rounded-full px-4 py-2 text-[15px] font-semibold transition-colors',
        on ? '' : 'bg-neutral-100 text-neutral-900 hover:bg-neutral-200',
      )}
      style={on ? { background: LIME, color: LIME_DEEP } : undefined}
    >
      <span className="truncate">{children}</span>
      <span className={cx('font-medium', on ? 'text-[#163300]/55' : 'text-neutral-500')}>{count}</span>
    </button>
  )
}

function AssetCard({
  asset,
  tagValue,
  options,
  onRetag,
  kindValue,
  kindOptions,
  onRetagKind,
  onDelete,
}: {
  asset: GrAsset
  tagValue: string
  options: { value: string; label: string }[]
  onRetag: (v: string) => void
  kindValue?: string
  kindOptions?: string[]
  onRetagKind?: (v: string) => void
  onDelete: () => void
}) {
  // Not a card: the photo is the object, the two lines under it read like a
  // list row's title and grey secondary line. The selects are those grey lines,
  // stripped of their boxes so a wall of them stays quiet.
  return (
    <div className="group">
      <div className="relative">
        <a
          href={assetUrl(asset)}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-2xl bg-neutral-100"
        >
          {asset.type === 'video' ? (
            <div className="grid aspect-[3/4] place-items-center text-neutral-500">
              <Icon name="film" className="size-8" />
            </div>
          ) : (
            <img
              src={assetThumb(asset)}
              alt={asset.name}
              loading="lazy"
              className="aspect-[3/4] w-full object-cover"
            />
          )}
        </a>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${asset.name}`}
          className="absolute right-2 top-2 grid size-9 place-items-center rounded-full bg-white/90 text-neutral-500 backdrop-blur transition-colors hover:text-red-600 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          <Icon name="trash" className="size-4" />
        </button>
      </div>

      <p className="mt-3 truncate text-base font-bold text-neutral-900" title={asset.name}>
        {asset.name}
      </p>

      <QuietSelect value={tagValue} onChange={onRetag} label={`Collection for ${asset.name}`}>
        <option value="">Untagged</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </QuietSelect>

      {kindValue !== undefined && onRetagKind && (
        <QuietSelect value={kindValue} onChange={onRetagKind} label={`Shot type for ${asset.name}`}>
          <option value="">No shot type</option>
          {(kindOptions ?? []).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </QuietSelect>
      )}
    </div>
  )
}

/** A borderless select that reads as the grey secondary line of a list row.
 *  Local to this page: the shared kit only has boxed inputs, which turn a grid
 *  of tiles into a grid of forms. */
function QuietSelect({
  value,
  onChange,
  label,
  children,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="relative mt-1 -ml-1.5">
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="w-full cursor-pointer appearance-none truncate rounded-lg bg-transparent py-1 pl-1.5 pr-7 text-base font-medium text-neutral-500 outline-none transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus:bg-neutral-100 focus:text-neutral-900"
      >
        {children}
      </select>
      <Icon
        name="down"
        className="pointer-events-none absolute right-1.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400"
      />
    </div>
  )
}
