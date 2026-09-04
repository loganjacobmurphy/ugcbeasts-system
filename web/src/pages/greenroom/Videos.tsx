import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  GreenroomOffline,
  STATUS_LABEL,
  getState,
  renderUrl,
  setPosted,
  type GrFormat,
  type GrProject,
} from '../../lib/greenroom'
import { LIME, LIME_DEEP, cx, searchCls } from '../../lib/tokens'
import { BrandBadge, Button, EmptyState, PageHeader, SearchIcon, SectionHeader } from '../../components/ui'
import { Icon } from '../../components/icons'
import { store } from '../../lib/store'
import { vietnamDateKey } from '../../lib/format'

/**
 * Videos, rebuilt against the Wise web reference.
 *
 * The patterns copied, and where they come from in the reference set:
 *   Transactions #136 #149 #156 #302   flat list, grey group label over a hairline,
 *                                      no card, no divider between rows in a group
 *   Transactions #156 #302             right column is an amount: one bold line,
 *                                      an optional grey line under it, no chevron
 *   Transactions #136 #156             a finished row greys as a whole, glyph,
 *                                      title and amount together
 *   Filters drawer #139 #142           right panel, grey label on a hairline,
 *                                      outline chips that fill deep green when on,
 *                                      Clear all beside Apply
 *   Transactions #156                  the floating Back to top pill is lime
 *
 * Only the shared kit's primitives are used for the page frame; the row itself
 * stays local because nothing else in the app has this shape yet.
 */

/* -------------------------------------------------------------- the buckets */

type Bucket = { key: string; label: string; match: (p: GrProject) => boolean }

const BUCKETS: Bucket[] = [
  { key: 'working', label: 'Working on it', match: (p) => ['queued', 'processing', 'rendering'].includes(p.status) },
  { key: 'ready', label: 'Ready to edit', match: (p) => p.status === 'ready' },
  { key: 'grab', label: 'Rendered, grab these', match: (p) => p.status === 'done' && !p.downloaded && !p.posted },
  { key: 'downloaded', label: 'Downloaded', match: (p) => p.status === 'done' && !!p.downloaded && !p.posted },
  { key: 'posted', label: 'Posted', match: (p) => !!p.posted },
  { key: 'failed', label: 'Failed', match: (p) => p.status === 'error' },
]

/** Anything whose status is not one of the six above, so a video can never become
 *  invisible and therefore impossible to delete from here. */
const isKnown = (p: GrProject) => BUCKETS.some((b) => b.match(p))

const STUCK: Bucket = { key: 'stuck', label: 'Stuck', match: (p) => !isKnown(p) }
const ALL_BUCKETS = [...BUCKETS, STUCK]

/* ---------------------------------------------------------------- the page */

/** Everything that already exists, kept off the generate page. */
export default function Videos() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<GrProject[] | null>(null)
  const [formats, setFormats] = useState<GrFormat[]>([])
  const [offline, setOffline] = useState(false)
  const [loadError, setLoadError] = useState('')

  const [query, setQuery] = useState('')
  const [statuses, setStatuses] = useState<string[]>([])
  const [pickedFormats, setPickedFormats] = useState<string[]>([])
  const [drawer, setDrawer] = useState(false)

  async function load() {
    try {
      const s = await getState()
      setProjects(s.projects)
      setFormats(s.formats)
      // one blip used to latch this page on "offline" for good, because nothing
      // ever cleared the flag again
      setOffline(false)
      setLoadError('')
    } catch (e) {
      // anything other than "the laptop is asleep" needs saying out loud, or the
      // page just sits on Loading with no explanation
      if (e instanceof GreenroomOffline) setOffline(true)
      else setLoadError((e as Error).message)
    }
  }
  useEffect(() => {
    void load()
    // things in flight change on their own, so keep it fresh while the tab is open
    const t = setInterval(() => void load(), 4000)
    return () => clearInterval(t)
  }, [])

  const formatName = useCallback((id?: string) => formats.find((f) => f.id === id)?.name, [formats])

  const filtered = useMemo(() => {
    if (!projects) return []
    const q = query.trim().toLowerCase()
    let out = projects
    if (q) {
      out = out.filter((p) =>
        [p.name, formatName(p.format), p.campaign?.name, STATUS_LABEL[p.status] ?? p.status]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      )
    }
    if (statuses.length) {
      out = out.filter((p) => ALL_BUCKETS.some((b) => statuses.includes(b.key) && b.match(p)))
    }
    if (pickedFormats.length) out = out.filter((p) => p.format && pickedFormats.includes(p.format))

    // newest first, which is the only order that ever made sense here
    return [...out].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
  }, [projects, query, statuses, pickedFormats, formatName])

  const groups = useMemo(
    () =>
      ALL_BUCKETS.map((b) => ({ bucket: b, items: filtered.filter(b.match) })).filter((g) => g.items.length > 0),
    [filtered],
  )

  const activeFilters = statuses.length + pickedFormats.length
  const showTools = !!projects && projects.length > 0

  const head = (
    <PageHeader
      title="Videos"
      action={
        showTools ? (
          <div className="flex items-center gap-2.5">
            <div className="relative flex-1 sm:w-72">
              <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-neutral-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search videos"
                className={searchCls}
              />
            </div>
            <Button onClick={() => setDrawer(true)} className="shrink-0">
              <Sliders className="size-4" />
              Filters{activeFilters ? ` (${activeFilters})` : ''}
            </Button>
          </div>
        ) : undefined
      }
    />
  )

  if (offline) {
    return (
      <div className="animate-in">
        {head}
        <EmptyState icon="film" title="Content is offline">
          It runs on your laptop, so the machine needs to be awake with the tunnel running.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="animate-in">
      {head}

      {!projects ? (
        loadError ? (
          <p className="text-base font-semibold text-red-600">Could not load: {loadError}</p>
        ) : (
          <p className="text-base font-medium text-neutral-500">Loading…</p>
        )
      ) : projects.length === 0 ? (
        <EmptyState title="No videos yet">Start one from the Content page.</EmptyState>
      ) : groups.length === 0 ? (
        <EmptyState title="Nothing matches those filters">
          Widen the status or format you picked and they will come back.
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section key={g.bucket.key} className="mb-14">
            <SectionHeader title={g.bucket.label} />
            <div className="pt-2">
              {g.items.map((p) => (
                <Row
                  key={p.id}
                  p={p}
                  formatName={formatName(p.format)}
                  onOpen={() => navigate(`/content/edit/${p.id}`)}
                  onChanged={() => void load()}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <BackToTop />

      {drawer && (
      <Filters
        onClose={() => setDrawer(false)}
        formats={formats}
        projects={projects ?? []}
        statuses={statuses}
        pickedFormats={pickedFormats}
        onApply={(s, f) => {
          setStatuses(s)
          setPickedFormats(f)
          setDrawer(false)
        }}
      />
      )}

    </div>
  )
}

/* --------------------------------------------------------------------- row */

/**
 * What kind of video this is, read off the format name (and the video's own name
 * as a fallback, since a project can exist before a format is attached).
 * A rendered frame was tried here first and looked like mud at 64px: the hook is
 * a wall of small text, so shrunk to a circle it is noise.
 */
const FORMAT_RULES: { test: RegExp; draw: (cls: string) => React.ReactElement }[] = [
  { test: /\b(dm'?d?|dms|messag\w*|inbox|text\w*|repl\w+|slid\w*)\b/i, draw: (c) => <BubbleIcon className={c} /> },
  { test: /(challeng\w*|dare|streak|attempt|\bday \d|24 ?h)/i, draw: (c) => <FlagIcon className={c} /> },
  { test: /(rate|rating|review|score|judge|rank)/i, draw: (c) => <StarIcon className={c} /> },
  { test: /(stat\w*|funnel|number|result|convert|%)/i, draw: (c) => <BarsIcon className={c} /> },
  { test: /(story|storytime|pov|confess|rant)/i, draw: (c) => <QuoteIcon className={c} /> },
]

function drawFormat(p: GrProject, formatName: string | undefined, cls: string) {
  const hay = `${formatName ?? ''} ${p.name}`
  const rule = FORMAT_RULES.find((r) => r.test.test(hay))
  return rule ? rule.draw(cls) : <FilmIcon className={cls} />
}

/**
 * The leading element. A real photo when the library has one, otherwise the
 * reference's plain neutral circle with a dark outline glyph. The circle is never
 * tinted by status: the reference only ever tints a leading circle by category.
 */
function Thumb({
  p,
  formatName,
  muted,
  problem,
}: {
  p: GrProject
  formatName?: string
  muted: boolean
  problem?: string
}) {
  // Which deal a video belongs to is the thing worth recognising down a long list,
  // and it reads far faster as a mark than as the word buried in the grey line. A
  // frame from the video was never distinguishing: every 10/10 video is the same
  // person against the same wall.
  const brand = p.campaign?.name || p.app || ''

  return (
    <span className="relative shrink-0">
      {brand ? (
        <span className={cx('block', muted && 'opacity-45')}>
          <BrandBadge brand={brand} />
        </span>
      ) : (
        // no campaign on this one, so fall back to what kind of video it is
        <span
          className={cx(
            'grid size-12 place-items-center rounded-full bg-neutral-100 text-neutral-600',
            muted && 'opacity-45',
          )}
        >
          {drawFormat(p, formatName, 'size-5')}
        </span>
      )}

      {/* A problem is a small badge on the circle, the way the reference flags a
          setting that needs attention. The full text is on hover and in the editor. */}
      {problem && (
        <span
          role="img"
          title={problem}
          aria-label={problem}
          className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full ring-2 ring-white"
          style={{ background: '#ffb020' }}
        />
      )}
    </span>
  )
}

function Row({
  p,
  formatName,
  onOpen,
  onChanged,
}: {
  p: GrProject
  formatName?: string
  onOpen: () => void
  /** Re-read the list, so a row that changes bucket moves there straight away. */
  onChanged: () => void
}) {
  const inFlight = ['queued', 'processing', 'rendering'].includes(p.status)
  const pct = Math.round((p.progress ?? 0) * 100)
  const muted = !!p.posted
  const problem = p.appendError || p.warning

  const bits = [
    formatName,
    p.campaign?.name,
    p.duration ? `${Math.round(p.duration)}s raw` : '',
    p.outDuration ? `${Math.round(p.outDuration)}s final` : '',
  ].filter(Boolean)

  return (
    // A row, not a single button any more: the overflow menu is a button of its own
    // and one cannot sit inside another. The open area is still everything except
    // the dots, so the row behaves the same to click.
    <div className="group relative -mx-3 flex w-[calc(100%+1.5rem)] items-center gap-4 px-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-4 py-4 text-left"
      >
      <Thumb
        p={p}
        formatName={formatName}
        muted={muted}
        problem={problem}
      />

      <span className="min-w-0 flex-1">
        <span className={cx('block truncate text-base font-bold', muted ? 'text-neutral-400' : 'text-neutral-900')}>
          {p.name}
        </span>

        {bits.length > 0 && (
          <span
            className={cx(
              'mt-0.5 block truncate text-base font-medium',
              muted ? 'text-neutral-400' : 'text-neutral-500',
            )}
          >
            {bits.join(', ')}
          </span>
        )}

        {inFlight && (
          <span className="mt-2.5 block h-1 w-full max-w-56 overflow-hidden rounded-full bg-neutral-200">
            <span
              className="block h-full rounded-full transition-[width] duration-500"
              style={{ width: `${pct}%`, background: LIME_DEEP }}
            />
          </span>
        )}
      </span>

      {/* Only the percentage earns a spot on the right, because it is the one
          thing the group heading cannot tell you. The state itself is already the
          heading this row sits under, and a warning is the dot on the thumbnail. */}
      {inFlight && (
        <span className="shrink-0 pl-3 text-right text-base font-medium tabular-nums text-neutral-500">
          {pct}%
        </span>
      )}

      </button>

      {/* Dots first, then the chevron, so the chevron stays the last thing on the
          row where it has always been. Both sit outside the open button: one
          button cannot contain another. */}
      <RowMenu p={p} onChanged={onChanged} />

      {/* Still opens the row, so the chevron does not become the one dead spot on
          it. Hidden from screen readers because the open button above already
          names this row, and a second control saying the same thing is noise. */}
      <button
        type="button"
        onClick={onOpen}
        tabIndex={-1}
        aria-hidden
        className="grid shrink-0 place-items-center py-4"
      >
        <Icon
          name="chevronLeft"
          className="size-5 rotate-180 text-neutral-300 transition-colors group-hover:text-neutral-900"
        />
      </button>
    </div>
  )
}

/**
 * The row's overflow menu. Marking a video posted is the one thing worth doing
 * without opening it, because it happens to a whole batch at once, and walking
 * into each video and back out again for a single toggle is the slow way round.
 */
function RowMenu({ p, onChanged }: { p: GrProject; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function toggle() {
    setBusy(true)
    try {
      const posted = !p.posted
      await setPosted(p.id, posted)
      store.setProjectPostLog(p.id, p.campaign?.id, vietnamDateKey(), posted)
      onChanged()
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    // Out of the way until wanted: a row of dots down every line is clutter on a
    // list you mostly read. It stays up while its own menu is open, or letting go
    // of the row to reach the menu would take the trigger away with it, and it
    // shows on keyboard focus so it is not mouse-only.
    <div
      className={cx(
        'relative shrink-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
        open ? 'opacity-100' : 'opacity-0',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Actions for ${p.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid size-10 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-2xl bg-white py-1.5 shadow-xl ring-1 ring-neutral-900/5">
            {/* Only once there is something to grab. `done` is the status a video
                reaches when its render finishes, which is exactly what the
                "Rendered, grab these" heading is counting. */}
            {p.status === 'done' && (
              <button
                type="button"
                onClick={() => {
                  window.open(renderUrl(p.id), '_blank')
                  setOpen(false)
                  // fetching it marks the video downloaded server side, so give
                  // that a moment to land and then move the row to its new group
                  setTimeout(onChanged, 1500)
                }}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-base font-medium text-neutral-900 transition-colors hover:bg-neutral-100"
              >
                <Icon name="down" className="size-5 shrink-0" />
                Download
              </button>
            )}

            <button
              type="button"
              onClick={toggle}
              disabled={busy}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-base font-medium text-neutral-900 transition-colors hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-50"
            >
              <Icon name={p.posted ? 'x' : 'check'} className="size-5 shrink-0" />
              {busy ? 'Saving' : p.posted ? 'Mark as not posted' : 'Mark as posted'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/* ----------------------------------------------------------- filter drawer */

/** Only ever mounted while open, so the draft state seeds itself from the live
 *  filters on the way in and needs no syncing effect. */
function Filters({
  onClose,
  formats,
  projects,
  statuses,
  pickedFormats,
  onApply,
}: {
  onClose: () => void
  formats: GrFormat[]
  projects: GrProject[]
  statuses: string[]
  pickedFormats: string[]
  onApply: (statuses: string[], formats: string[]) => void
}) {
  // held as a draft so nothing changes behind the panel until Apply is pressed
  const [draftStatus, setDraftStatus] = useState(statuses)
  const [draftFormat, setDraftFormat] = useState(pickedFormats)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const usedFormats = formats.filter((f) => projects.some((p) => p.format === f.id))
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal aria-label="Filters">
      <div className="absolute inset-0 bg-neutral-900/25" onClick={onClose} />

      <div className="animate-in relative flex h-full w-full max-w-xl flex-col bg-white">
        <header className="flex items-center justify-between gap-4 px-8 pb-6 pt-7">
          <h2 className="text-2xl font-bold text-neutral-900">Filters</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-700 transition-colors hover:bg-neutral-200"
          >
            <Icon name="x" className="size-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-8 pb-8">
          <section>
            <SectionHeader title="Status" />
            <div className="flex flex-wrap gap-2.5 pt-4">
              {ALL_BUCKETS.map((b) => (
                <Chip
                  key={b.key}
                  label={b.label}
                  count={projects.filter(b.match).length}
                  on={draftStatus.includes(b.key)}
                  onClick={() => setDraftStatus((s) => toggle(s, b.key))}
                />
              ))}
            </div>
          </section>

          {usedFormats.length > 0 && (
            <section className="mt-10">
              <SectionHeader title="Format" />
              <div className="flex flex-wrap gap-2.5 pt-4">
                {usedFormats.map((f) => (
                  <Chip
                    key={f.id}
                    label={f.name}
                    count={projects.filter((p) => p.format === f.id).length}
                    on={draftFormat.includes(f.id)}
                    onClick={() => setDraftFormat((s) => toggle(s, f.id))}
                  />
                ))}
              </div>
            </section>
          )}

          <p className="mt-10 text-[15px] font-medium text-neutral-500">
            Videos live on your own machine, so this only covers what your greenroom currently holds.
          </p>
        </div>

        <footer className="flex gap-3 px-8 pb-7 pt-2">
          <Button
            variant="secondary"
            onClick={() => {
              setDraftStatus([])
              setDraftFormat([])
            }}
            className="flex-1 py-3.5"
            style={{ borderColor: LIME_DEEP, color: LIME_DEEP }}
          >
            Clear all
          </Button>
          <Button onClick={() => onApply(draftStatus, draftFormat)} className="flex-1 py-3.5">
            Apply
          </Button>
        </footer>
      </div>
    </div>
  )
}

/**
 * The one filter chip shape the whole app uses: a grey fill when off, the lime
 * of the primary button when on, and the count carried inside the same pill.
 * aria-pressed is what announces the on state, so no cross glyph is needed.
 */
function Chip({
  label,
  count,
  on,
  onClick,
}: {
  label: string
  count: number
  on: boolean
  onClick: () => void
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
      <span className="truncate">{label}</span>
      <span className={cx('font-medium', on ? 'text-[#163300]/55' : 'text-neutral-500')}>{count}</span>
    </button>
  )
}

/* -------------------------------------------------------------- small bits */

function BackToTop() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 700)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!show) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center md:bottom-8">
      <Button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="pointer-events-auto shadow-md">
        Back to top
      </Button>
    </div>
  )
}

/** The shared icon set has no magnifier or sliders, and this page is not allowed
 *  to edit that file yet. The format glyphs are only used here. */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function BubbleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke} aria-hidden>
      <path d="M21 11.5a7.5 7.5 0 0 1-10.9 6.7L4 20l1.8-5.1A7.5 7.5 0 1 1 21 11.5z" />
    </svg>
  )
}

function FlagIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke} aria-hidden>
      <path d="M6 21V4M6 4h11l-2.2 4L17 12H6" />
    </svg>
  )
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke} aria-hidden>
      <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z" />
    </svg>
  )
}

function BarsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke} aria-hidden>
      <path d="M5 20V12M12 20V5M19 20v-5" />
    </svg>
  )
}

function QuoteIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke} aria-hidden>
      <path d="M9.5 6C6.9 7.3 5.5 9.6 5.5 13v5h5v-6h-3c0-2.2.7-3.7 2.6-4.7zM19.5 6c-2.6 1.3-4 3.6-4 7v5h5v-6h-3c0-2.2.7-3.7 2.6-4.7z" />
    </svg>
  )
}

function FilmIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke} aria-hidden>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M8 5v14M16 5v14M3.5 12h17" />
    </svg>
  )
}

function Sliders({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M3 7h9M17 7h4M3 17h4M12 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9.5" cy="17" r="2.2" />
    </svg>
  )
}
