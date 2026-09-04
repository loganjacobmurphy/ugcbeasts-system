/**
 * Client for the greenroom editor running on Logan's laptop.
 *
 * It is reachable same-origin at /greenroom/embed (a Pages Function proxies it over
 * the Cloudflare tunnel, see functions/_greenroom.ts), so these are plain fetches
 * and the HQ session cookie is what authorises them.
 */

const BASE = '/greenroom/embed/api'

/** A video style, named after its hook. Says nothing about who it is about. */
export interface GrFormat {
  id: string
  name: string
  app: string
  campaigns: string[]
  dayHooks: string[]
  spanHooks: string[]
  /** transcript of a real video in this format; grounds script generation */
  reference?: string
  /** a fixed image collection for this format; when set, the flow skips the
   *  audience step because the video is about a pile of photos, not a group */
  collection?: string
  /** how the app gets worked in near the end, spoken as the method he used */
  cta?: string
  /** how many photos the hook shows at once; 0 or absent means a single image */
  hookCollage?: number
  /** 'bg' is the red TikTok slab, 'outline' is white text with a dark stroke */
  hookStyle?: 'bg' | 'outline'
  /** the Hinge swipe funnel: backgrounds are generated stat cards, and the script is
   *  written from the same numbers so the voiceover matches what is on screen */
  statsFunnel?: boolean
}

/** Who a video is about: which images to use and the word that fills {aud}. */
export interface GrAudience {
  id: string
  label: string
  collection: string
  word: string
}

export interface GrProject {
  id: string
  name: string
  status: 'queued' | 'processing' | 'ready' | 'rendering' | 'done' | 'error' | string
  progress?: number
  error?: string | null
  created?: number
  duration?: number
  outDuration?: number
  app?: string
  format?: string
  audience?: string
  campaign?: { id: string; name: string }
  downloaded?: boolean
  posted?: boolean
  /** something went wrong without failing the video, e.g. the fallback cutout */
  warning?: string
  /** an "add a clip to the end" that failed; the video itself is untouched */
  appendError?: string
}

export interface GrAsset {
  id: string
  name: string
  folder: string
  file: string
  thumb?: string | null
  type: string
  /** which audience's images this belongs to */
  collection?: string
  /** which campaign this belongs to, for app screenshots and the like */
  campaign?: string
  /** the shot type within a collection, e.g. travel or night out */
  kind?: string
  /** where the face is, as [x, y, size] fractions of the image, when one was
   *  detected. greenroom writes this when photos are imported. */
  face?: [number, number, number]
}

/**
 * How to crop a photo into a small circle without beheading anyone.
 *
 * A plain centred cover crop cuts the subject off whenever the photo is wide, or
 * shows the white margins a screenshot came with. Centring on the detected face
 * fixes both, and the extra scale pushes any leftover white border outside the
 * circle. Photos with no detected face fall back to slightly-above-centre, which
 * is where a person is in almost every portrait.
 */
export function faceCrop(a?: Pick<GrAsset, 'face'>) {
  const f = a?.face
  const pos = f ? `${(f[0] * 100).toFixed(1)}% ${(f[1] * 100).toFixed(1)}%` : '50% 35%'
  return {
    objectPosition: pos,
    // zoom from the face itself, so tightening the crop does not walk it out of frame
    transformOrigin: pos,
    transform: `scale(${f ? 1.2 : 1.3})`,
  }
}



/** greenroom serves its data dir at /files, proxied under the embed path. */
/** The finished render. Fetching it is also what marks the video downloaded. */
export const renderUrl = (id: string) => `${BASE}/projects/${id}/download`

export const assetUrl = (a: GrAsset) => `/greenroom/embed/files/library/${a.folder}/${a.file}`
export const assetThumb = (a: GrAsset) =>
  a.thumb ? `/greenroom/embed/files/library/${a.folder}/${a.thumb}` : assetUrl(a)

export interface GrState {
  projects: GrProject[]
  library: GrAsset[]
  formats: GrFormat[]
  audiences: GrAudience[]
  /** shot types come from greenroom, which is also what matches them to a line */
  shotTypes: string[]
  folders: string[]
  music: string[]
}

/** greenroom only runs when the laptop is awake, so callers get a clear signal. */
export class GreenroomOffline extends Error {
  constructor() {
    super('Greenroom is not reachable')
    this.name = 'GreenroomOffline'
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, init)
  } catch {
    throw new GreenroomOffline()
  }
  // Any gateway class code means the tunnel or the laptop, not greenroom itself.
  // 520 to 526 are Cloudflare's own tunnel failures (origin down, timed out) and
  // are what a laptop busy rendering actually returns, so they belong here too.
  const gateway = (res.status >= 502 && res.status <= 504) || (res.status >= 520 && res.status <= 526)
  if (gateway) throw new GreenroomOffline()
  if (!res.ok) {
    // Never the raw body: a Cloudflare error page is several hundred lines of
    // HTML, and it went straight into the banner on the Content page.
    const body = res.headers.get('content-type')?.includes('json') ? await res.text() : ''
    throw new Error(body || `greenroom said ${res.status}`)
  }
  return (await res.json()) as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const getState = () => req<GrState>('/state')

/** A fresh set of Hinge swipe funnel numbers, consistent from top to bottom. */
export interface GrFunnel {
  sent: number
  opened: number
  notOpened: number
  responded: number
  ignored: number
  saidNo: number
  saidYes: number
  cracked: number
}
export const getFunnel = (sent = 100000) => req<GrFunnel>(`/funnel?sent=${sent}`)

/** One generated background, ready to download. */
export interface GrCard {
  name: string
  file: string
  /** the full 1080x1920 PNG */
  url: string
  /** a small JPEG for the picker, so choosing between five does not pull 2MB */
  thumb?: string
}
export interface GrCardExport {
  token: string
  funnel: GrFunnel
  cards: GrCard[]
  note: string
}

/**
 * Draw every background for a script without making a video first.
 *
 * Some videos get cut by hand outside greenroom, but the backgrounds are still
 * generated from the numbers he says, so this reads them straight out of the script
 * and returns the same five images a real video would get.
 */
export const cardsPreview = (text: string, audience: string) =>
  req<GrCardExport>('/cards/preview', json({ text, audience }))

/** The whole set as one download. Not a fetch: it is an href the browser follows. */
export const cardsZipUrl = (token: string) => `${BASE}/cards/${token}/all.zip`

/** Card images are served by greenroom itself, through the same proxy. */
export const cardUrl = (path: string) => `/greenroom/embed/${path}`

export const saveFormat = (f: Partial<GrFormat>) => req<GrFormat>('/formats', json(f))

export const deleteFormat = (id: string) => req<{ ok: true }>(`/formats/${id}`, { method: 'DELETE' })

export const setAssetCampaign = (id: string, campaign: string) =>
  req<GrAsset>(`/library/${id}/campaign`, json({ campaign }))

export const setAssetCollection = (id: string, collection: string) =>
  req<GrAsset>(`/library/${id}/collection`, json({ collection }))

export const setAssetKind = (id: string, kind: string) =>
  req<GrAsset>(`/library/${id}/kind`, json({ kind }))

export const deleteAsset = (id: string) => req<unknown>(`/library/${id}`, { method: 'DELETE' })

/** Upload an image or clip into the library, tagged as it lands. */
export function uploadAsset(
  file: File,
  opts: { folder: string; collection?: string; campaign?: string; kind?: string },
): Promise<GrAsset> {
  // one request, so the same 100 MB edge cap applies here. Say so plainly rather
  // than letting it die mid upload with "went offline partway through"
  if (file.size > 90 * 1024 * 1024) {
    return Promise.reject(
      new Error(`"${file.name}" is ${Math.round(file.size / 1e6)} MB. Anything over about 90 MB is too big to send through the tunnel.`),
    )
  }
  const fd = new FormData()
  fd.append('file', file)
  fd.append('folder', opts.folder)
  if (opts.collection) fd.append('collection', opts.collection)
  if (opts.campaign) fd.append('campaign', opts.campaign)
  if (opts.kind) fd.append('kind', opts.kind)
  return req<GrAsset>('/library', { method: 'POST', body: fd })
}

export const deleteProject = (id: string) => req<unknown>(`/projects/${id}`, { method: 'DELETE' })

export const setPosted = (id: string, posted: boolean) =>
  req<GrProject>(`/projects/${id}/settings`, json({ posted }))

/**
 * Cloudflare refuses a request body over 100 MB, so a recording cannot be sent
 * in one request: measured on this zone, a 150 MB POST is cut off with a 413
 * after about 2 MB, which is what "went offline partway through" really was. So
 * the file goes up in parts and greenroom reassembles it before ingest.
 */
// The tunnel on this connection repeatedly drops requests around 9 to 12 MB.
// Keeping a part below that point means a retry loses at most a few megabytes and
// normally finishes before the connection has a chance to disappear.
export const VIDEO_PART_BYTES = 4 * 1024 * 1024

/**
 * Upload one recording, in parts, reporting progress across the whole file.
 *
 * `resume` is what makes a refresh survivable. The browser loses the bytes when
 * the page reloads, so it cannot simply carry on by itself, but greenroom keeps
 * the parts that already arrived for a day. Hand back the id from last time and
 * only the missing parts go up, so re-picking a 300 MB recording that was 80%
 * through costs the last 60 MB rather than all of it.
 */
export async function uploadVideo(
  file: File,
  opts: { format: string; audience: string; campaignId: string; campaignName: string },
  onProgress?: (pct: number) => void,
  resume?: { id?: string; onId?: (id: string) => void },
): Promise<GrProject> {
  const parts = Math.max(1, Math.ceil(file.size / VIDEO_PART_BYTES))

  let id = resume?.id ?? ''
  let already: number[] = []
  if (id) {
    // an id whose parts have been swept, or that never existed, starts over
    already = (await req<{ parts: number[] }>(`/uploads/${id}`).catch(() => ({ parts: [] }))).parts
    if (!already.length) id = ''
  }
  if (!id) id = (await req<{ id: string }>('/uploads', json({ filename: file.name }))).id
  // published straight away, so a refresh one second later can still resume this
  resume?.onId?.(id)

  for (let i = 0; i < parts; i++) {
    if (already.includes(i)) {
      onProgress?.(Math.min(99, Math.round((((i + 1) * VIDEO_PART_BYTES) / file.size) * 100)))
      continue
    }
    const blob = file.slice(
      i * VIDEO_PART_BYTES,
      Math.min(file.size, (i + 1) * VIDEO_PART_BYTES),
    )
    await sendPart(`/uploads/${id}/parts/${i}`, blob, (sent) =>
      // held at 99 until the parts are joined, so it never reads done early
      onProgress?.(Math.min(99, Math.round(((i * VIDEO_PART_BYTES + sent) / file.size) * 100))),
    )
  }

  const project = await req<GrProject>(
    `/uploads/${id}/finish`,
    json({
      filename: file.name,
      name: file.name.replace(/\.[^.]+$/, ''),
      parts,
      format: opts.format,
      audience: opts.audience,
      campaignId: opts.campaignId,
      campaignName: opts.campaignName,
    }),
  )
  onProgress?.(100)
  return project
}

/** No bytes for this long means the connection is dead, however alive it looks. */
const STALL_MS = 45_000
/** Once the body is up, the server still has to write the part out. */
const RESPONSE_MS = 120_000
/** How long to wait before each retry. Roughly a minute of patience in total. */
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000]

/**
 * Why a part failed, in words, and never the response body.
 *
 * A 502 from the tunnel comes back as Cloudflare's own error page, and putting
 * `responseText` in the message pasted several hundred lines of their HTML into
 * the banner on the Content page. The status is the only part of that response
 * worth reading.
 */
function uploadError(status: number): Error {
  if ((status >= 502 && status <= 504) || (status >= 520 && status <= 526)) {
    return new Error('your laptop was too busy to answer, it is probably rendering')
  }
  if (status === 413) return new Error('the tunnel rejected the part as too large')
  if (status === 0) return new GreenroomOffline()
  return new Error(`greenroom said ${status}`)
}

/**
 * One part, over XHR for the progress events, retried a couple of times. A home
 * tunnel drops the odd connection and losing a 200 MB upload to one blip is not
 * something to shrug at.
 *
 * The retry alone was not enough. A tunnel does not always close the socket when
 * it drops: sometimes the bytes simply stop and nothing errors. XHR's default
 * timeout is never, so the request would sit there for good, `onerror` would not
 * fire, the retry would not trigger, and the await above it would never return.
 * One silent drop therefore froze not just its own file but every file still
 * queued behind it, with no error shown, because failures are only reported once
 * the loop ends and the loop never ended.
 *
 * So silence is now treated as failure. The clock is reset by every progress
 * event rather than being a ceiling on the whole part, which is the difference
 * between a dead connection and a slow one: a 16 MB part on a poor upstream
 * takes minutes and must be left alone.
 */
function sendPart(path: string, blob: Blob, onProgress: (sent: number) => void, tries = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      // Backing off rather than hammering. The thing that knocks an upload over is
      // usually the laptop being flat out rendering a video that landed a minute
      // ago, and it stays that way for a while, so five tries a second apart all
      // hit the same busy machine and the batch dies for no good reason. These
      // waits ride out about a minute of it.
      const wait = BACKOFF_MS[BACKOFF_MS.length - left] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
      const retry = (fail: () => void) => (left > 0 ? setTimeout(() => attempt(left - 1), wait) : fail())
      const xhr = new XMLHttpRequest()

      let stall: ReturnType<typeof setTimeout>
      const waitFor = (ms: number) => {
        clearTimeout(stall)
        // abort() lands on onabort below, which retries like any other failure
        stall = setTimeout(() => xhr.abort(), ms)
      }

      xhr.upload.onprogress = (e) => {
        waitFor(STALL_MS)
        if (e.lengthComputable) onProgress(e.loaded)
      }
      // body is up; from here we are waiting on greenroom, not the network
      xhr.upload.onload = () => waitFor(RESPONSE_MS)
      xhr.onload = () => {
        clearTimeout(stall)
        if (xhr.status >= 200 && xhr.status < 300) resolve()
        else retry(() => reject(uploadError(xhr.status)))
      }
      xhr.onerror = () => {
        clearTimeout(stall)
        retry(() => reject(new GreenroomOffline()))
      }
      xhr.onabort = () => {
        clearTimeout(stall)
        retry(() => reject(new GreenroomOffline()))
      }
      xhr.open('POST', `${BASE}${path}`)
      // The proxy can end a request early without reporting a network error. Tell
      // greenroom exactly how many bytes this part must contain so a truncated body
      // is rejected and retried instead of being assembled into a broken video.
      xhr.setRequestHeader('x-upload-bytes', String(blob.size))
      xhr.send(blob)
      waitFor(STALL_MS)
    }
    attempt(tries)
  })
}

/**
 * Formats a campaign can use.
 *
 * Ticking campaigns on the Formats page is the explicit rule. On top of that, a
 * format whose app matches the campaign's name is matched automatically, so a
 * campaign called Regen gets the Regen formats and nothing else without anyone
 * wiring it up. Either way a Halo format never shows under a Regen deal.
 */
export const formatsForCampaign = (formats: GrFormat[], campaignId: string, campaignName = '') => {
  const brand = campaignName.toLowerCase()
  return formats.filter(
    (f) =>
      f.campaigns.includes(campaignId) ||
      // `app` may list several names, comma separated, when a format runs under
      // more than one deal
      appNames(f).some((a) => brand.includes(a)),
  )
}

/** Every app name a format runs under. The first is the tag its videos get. */
export const appNames = (f: GrFormat) =>
  (f.app ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Waiting',
  processing: 'Processing',
  ready: 'Ready to edit',
  rendering: 'Rendering',
  done: 'Rendered',
  error: 'Failed',
}

// ---------------------------------------------------------------------------
// Shared formats
//
// Everyone runs their own greenroom on their own machine, so formats and
// audiences would drift apart install by install. The shared copy lives in D1
// (see functions/api/config.ts) and the browser is the courier between the two,
// because it is the one thing already signed in to both.
// ---------------------------------------------------------------------------

export interface SharedFormats {
  version: number
  formats: GrFormat[]
  audiences: GrAudience[]
}

/** The team's copy, or null on the single-user install where there isn't one. */
export async function getShared(): Promise<SharedFormats | null> {
  try {
    const res = await fetch('/api/config?key=formats')
    if (!res.ok) return null
    const body = (await res.json()) as { formats: SharedFormats | null }
    return body.formats ?? null
  } catch {
    return null
  }
}

/** Publish this machine's formats as the team's copy. */
export async function putShared(formats: GrFormat[], audiences: GrAudience[]): Promise<boolean> {
  try {
    const res = await fetch('/api/config?key=formats', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, formats, audiences } satisfies SharedFormats),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Bring a fresh install up to the team's formats.
 *
 * Only fills a gap, never overwrites: a format already on this machine is left
 * exactly as it is, because the local copy may be mid-edit and silently
 * replacing it would throw that away. Returns how many were added.
 */
export async function pullShared(local: GrState): Promise<number> {
  const shared = await getShared()
  if (!shared?.formats?.length) return 0

  const have = new Set(local.formats.map((f) => f.id))
  const missing = shared.formats.filter((f) => !have.has(f.id))
  for (const f of missing) await saveFormat(f)

  // Audiences are not synced here: greenroom has no endpoint to write one, they
  // are seeded from its own code. Everyone installing the same greenroom gets
  // the same audiences, so the repo is what keeps those in step.
  return missing.length
}
