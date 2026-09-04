import { useSyncExternalStore } from 'react'
import type {
  Board,
  BoardItem,
  Campaign,
  DailyCopyBrand,
  DailyCopyDay,
  DailyCopySlot,
  LoggedPost,
  ScheduleItem,
  TopVideo,
} from './types'
import { seedCampaigns, seedSchedule } from './seed'

export interface DB {
  campaigns: Campaign[]
  schedule: ScheduleItem[]
  videos: TopVideo[]
  /** Daily posting tallies, keyed by `${campaignId}|${yyyy-mm-dd}`. */
  logs: Record<string, number>
  /** Greenroom posts keyed by project id, so one video can only count once. */
  postLogs: Record<string, LoggedPost>
  /** FixMyPosture planning board (items + connectors). */
  board: Board
  /** Daily Instagram references, keyed by the date in Logan's time zone. */
  copyDays: Record<string, DailyCopyDay>
}

const KEY = 'ugc-hq-db-v1'
const PASSCODE_KEY = 'ugc-hq-passcode'
/* Each person brings their own Anthropic key, so writing scripts is billed to
   whoever pressed the button. Without this the whole team spends the one key held
   in the Cloudflare project, which is Logan's. Stays in this browser and is sent
   only to our own /api routes, never to anyone else. */
const AI_KEY = 'ugc-hq-anthropic-key'

/** Accepts old (BoardNote[]) or new (Board) shapes and returns a valid Board. */
function normalizeBoard(raw: unknown): Board {
  if (Array.isArray(raw)) {
    const items: BoardItem[] = raw.map((n) => {
      const o = n as { id?: string; x?: number; y?: number; text?: string; color?: BoardItem['color'] }
      return {
        id: o.id ?? Math.random().toString(36).slice(2),
        type: 'note',
        x: o.x ?? 0,
        y: o.y ?? 0,
        text: o.text ?? '',
        color: o.color ?? 'yellow',
      }
    })
    return { items, arrows: [] }
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as Board).items)) {
    const b = raw as Board
    return { items: b.items, arrows: Array.isArray(b.arrows) ? b.arrows : [] }
  }
  return { items: [], arrows: [] }
}

const COPY_COUNTS: Record<DailyCopyBrand, number> = { regen: 5, roast: 3 }

function normalizeCopySlots(raw: unknown, count: number): DailyCopySlot[] {
  const rows = Array.isArray(raw) ? raw : []
  return Array.from({ length: count }, (_, index) => {
    const row = rows[index] as Partial<DailyCopySlot> | undefined
    return { url: typeof row?.url === 'string' ? row.url : '', done: Boolean(row?.done) }
  })
}

function normalizeCopyDays(raw: unknown): Record<string, DailyCopyDay> {
  if (!raw || typeof raw !== 'object') return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, Partial<DailyCopyDay>>).map(([date, day]) => [
      date,
      {
        regen: normalizeCopySlots(day?.regen, COPY_COUNTS.regen),
        roast: normalizeCopySlots(day?.roast, COPY_COUNTS.roast),
      },
    ]),
  )
}

function normalizePostLogs(raw: unknown): Record<string, LoggedPost> {
  if (!raw || typeof raw !== 'object') return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, Partial<LoggedPost>>).filter(
      ([, post]) => typeof post?.campaignId === 'string' && typeof post?.date === 'string',
    ),
  ) as Record<string, LoggedPost>
}

function coerce(db: DB): DB {
  const raw = db as DB & { board?: unknown; copyDays?: unknown; postLogs?: unknown }
  return {
    ...db,
    board: normalizeBoard(raw.board),
    copyDays: normalizeCopyDays(raw.copyDays),
    postLogs: normalizePostLogs(raw.postLogs),
  }
}

function initial(): DB {
  return {
    campaigns: seedCampaigns(),
    schedule: seedSchedule(),
    videos: [],
    logs: {},
    postLogs: {},
    board: { items: [], arrows: [] },
    copyDays: {},
  }
}

function saveLocal() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    /* ignore quota errors */
  }
}

function load(): DB {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return coerce({ ...initial(), ...(JSON.parse(raw) as Partial<DB>) })
  } catch {
    /* fall through to seed */
  }
  const init = initial()
  try {
    localStorage.setItem(KEY, JSON.stringify(init))
  } catch {
    /* ignore */
  }
  return init
}

let db: DB = load()
const listeners = new Set<() => void>()

// Keep two open UGCBeasts tabs on the same state. The storage event fires only
// in the other tab, so the tab that made the edit still updates through persist.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY || !event.newValue) return
    try {
      db = coerce({ ...initial(), ...(JSON.parse(event.newValue) as Partial<DB>) })
      emit()
    } catch {
      /* ignore a partial or invalid write */
    }
  })
}

function emit() {
  listeners.forEach((l) => l())
}

function persist() {
  saveLocal()
  emit()
  schedulePush()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot() {
  return db
}

export function useDB(): DB {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)

// ---------------------------------------------------------------------------
// Passcode (stored locally; verified against the server's APP_PASSCODE secret)
// ---------------------------------------------------------------------------

export const getPasscode = () => {
  try {
    return localStorage.getItem(PASSCODE_KEY) || ''
  } catch {
    return ''
  }
}
export const setPasscode = (p: string) => {
  try {
    localStorage.setItem(PASSCODE_KEY, p)
  } catch {
    /* ignore */
  }
}
export const getApiKey = () => {
  try {
    return localStorage.getItem(AI_KEY) || ''
  } catch {
    return ''
  }
}
export const setApiKey = (k: string) => {
  try {
    if (k.trim()) localStorage.setItem(AI_KEY, k.trim())
    else localStorage.removeItem(AI_KEY)
  } catch {
    /* ignore */
  }
}

export const clearPasscode = () => {
  try {
    localStorage.removeItem(PASSCODE_KEY)
    document.cookie = 'gr_pass=; Path=/; Max-Age=0; SameSite=Lax'
  } catch {
    /* ignore */
  }
}

/**
 * Unlocking HQ also unlocks the Greenroom page. /greenroom is served by a Pages
 * Function (it proxies the editor on Logan's laptop), so a plain navigation has
 * to carry proof in a cookie; localStorage is invisible to it. Same passcode,
 * so this is no weaker than the rest of the app, it just avoids asking twice.
 */
export async function grantGreenroom(passcode: string) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`greenroom|${passcode}`))
    const token = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    document.cookie = `gr_pass=${token}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Cloud sync — the whole DB is stored as one JSON document in D1.
// localStorage stays as an instant offline cache; cloud is source of truth.
// ---------------------------------------------------------------------------

export type AuthResult = 'ok' | 'bad' | 'offline'

/* Sync stays off until startup has established who we are. Without this the
   first local edit would race the identity check and push a seeded, empty DB
   over the top of real cloud data. */
let cloudOn = false
export function enableCloud() {
  cloudOn = true
}

/* Behind Cloudflare Access the browser's own cookie carries identity, so no
   header is needed. On the passcode install the stored code is the credential. */
function authHeaders(passcode?: string): Record<string, string> {
  const p = passcode ?? getPasscode()
  return p ? { 'x-passcode': p } : {}
}

async function apiGet(passcode?: string): Promise<{ status: number; data: DB | null }> {
  try {
    const res = await fetch('/api/state', { headers: authHeaders(passcode) })
    if (!res.ok) return { status: res.status, data: null }
    const json = (await res.json()) as { data: DB | null }
    return { status: 200, data: json.data }
  } catch {
    return { status: 0, data: null }
  }
}

/** Verify a passcode against the server. */
export async function checkPasscode(passcode: string): Promise<AuthResult> {
  const r = await apiGet(passcode)
  if (r.status === 200) return 'ok'
  if (r.status === 401) return 'bad'
  return 'offline'
}

let pushTimer: ReturnType<typeof setTimeout> | undefined

/* Set the moment anything changes locally, cleared only once the cloud has taken
   it. While it is set, startup must not adopt the cloud copy: doing so silently
   threw away anything edited while the connection was down. */
const DIRTY = 'ugc-hq-dirty'
const isDirty = () => localStorage.getItem(DIRTY) === '1'

async function pushCloud() {
  if (!cloudOn) return
  try {
    const res = await fetch('/api/state', {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(db),
    })
    // a non-ok response is just as much a failed save as a thrown one
    if (res.ok) localStorage.removeItem(DIRTY)
  } catch {
    /* offline — will retry on the next change */
  }
}

function schedulePush() {
  if (!cloudOn) return
  localStorage.setItem(DIRTY, '1')
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    void pushCloud()
  }, 700)
}

/**
 * Pull cloud state at startup (after the passcode is verified). If the cloud
 * already has data, adopt it; if it's empty, push the local data up so an
 * existing single-device dataset isn't lost.
 */
export async function syncFromCloud(): Promise<void> {
  if (!cloudOn) return
  const r = await apiGet()
  if (r.status === 200) {
    if (r.data && !isDirty()) {
      db = coerce({ ...initial(), ...r.data })
      saveLocal()
      emit()
    } else {
      // local has changes the cloud never took, so local wins and goes up
      await pushCloud()
    }
  }
}

export const store = {
  addCampaign(c: Campaign) {
    db = { ...db, campaigns: [...db.campaigns, c] }
    persist()
  },
  updateCampaign(id: string, patch: Partial<Campaign>) {
    db = { ...db, campaigns: db.campaigns.map((c) => (c.id === id ? { ...c, ...patch } : c)) }
    persist()
  },
  removeCampaign(id: string) {
    db = { ...db, campaigns: db.campaigns.filter((c) => c.id !== id) }
    persist()
  },
  setSchedule(items: ScheduleItem[]) {
    db = { ...db, schedule: items }
    persist()
  },
  addVideo(v: TopVideo) {
    db = { ...db, videos: [...db.videos, v] }
    persist()
  },
  updateVideo(id: string, patch: Partial<TopVideo>) {
    db = { ...db, videos: db.videos.map((v) => (v.id === id ? { ...v, ...patch } : v)) }
    persist()
  },
  removeVideo(id: string) {
    db = { ...db, videos: db.videos.filter((v) => v.id !== id) }
    persist()
  },
  setLog(campaignId: string, date: string, count: number) {
    db = { ...db, logs: { ...db.logs, [`${campaignId}|${date}`]: count } }
    persist()
  },
  setProjectPostLog(projectId: string, campaignId: string | undefined, date: string, posted: boolean) {
    const postLogs = { ...db.postLogs }
    if (posted && campaignId) postLogs[projectId] = { campaignId, date }
    else delete postLogs[projectId]
    db = { ...db, postLogs }
    persist()
  },
  setBoard(board: Board) {
    db = { ...db, board }
    persist()
  },
  setDailyCopySlot(
    date: string,
    brand: DailyCopyBrand,
    index: number,
    patch: Partial<DailyCopySlot>,
  ) {
    const current = db.copyDays[date] ?? {
      regen: normalizeCopySlots([], COPY_COUNTS.regen),
      roast: normalizeCopySlots([], COPY_COUNTS.roast),
    }
    const slots = normalizeCopySlots(current[brand], COPY_COUNTS[brand]).map((slot, i) =>
      i === index ? { ...slot, ...patch } : slot,
    )
    db = {
      ...db,
      copyDays: { ...db.copyDays, [date]: { ...current, [brand]: slots } },
    }
    persist()
  },
}
