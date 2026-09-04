/**
 * The state of a running upload batch, kept outside React.
 *
 * The upload loop itself always survived navigating away, because nothing aborts
 * the requests when the page unmounts. What did not survive was any sign of it:
 * the file list and the percentage were component state on the Content wizard, so
 * leaving the page took the progress bar with them, and coming back remounted the
 * wizard at step one with an empty dropzone. The upload was still going, and the
 * app looked like it had forgotten.
 *
 * So the batch lives here instead, the same way pageback.ts holds the back action.
 * The wizard reads it and can pick a batch back up mid flight, and App can show it
 * from any page.
 */

export type UploadBatch = {
  /** Every recording in this batch, in the order they go up. */
  files: File[]
  /** Which one is on the wire. */
  index: number
  /** How far through that one file, 0 to 100. */
  pct: number
  /** Filled in as each one lands, so a finished batch can still report failures. */
  failed: string[]
}

let current: UploadBatch | null = null
const subscribers = new Set<() => void>()

const notify = () => subscribers.forEach((f) => f())

export function startBatch(files: File[]) {
  current = { files, index: 0, pct: 0, failed: [] }
  notify()
}

export function setBatchProgress(index: number, pct: number) {
  if (!current) return
  // a new object every time: useSyncExternalStore compares by reference
  current = { ...current, index, pct }
  notify()
}

export function markBatchFailure(name: string) {
  if (!current) return
  current = { ...current, failed: [...current.failed, name] }
  notify()
}

export function endBatch() {
  current = null
  notify()
}

export function subscribeUploads(cb: () => void) {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function getUploads(): UploadBatch | null {
  return current
}

/* ------------------------------------------------------ surviving a refresh */

/**
 * What was part way up when the page went away.
 *
 * A reload cannot simply carry on: the File objects came from a picker and the
 * bytes are gone with the tab. What does survive is greenroom's copy of the parts
 * that already arrived, for a day. So the names, sizes and upload ids are kept
 * here, and picking the same recordings again continues them instead of starting
 * from nothing.
 */
export type PendingFile = { name: string; size: number; uploadId?: string; done?: boolean }
export type Pending = {
  /** Resume ids are only safe when the browser slices the file the same way. */
  partBytes?: number
  files: PendingFile[]
  opts: { format: string; audience: string; campaignId: string; campaignName: string }
}

const KEY = 'ugcbeasts.upload.pending'

export function savePending(p: Pending) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // a full or blocked store only costs the resume, never the upload
  }
}

export function loadPending(): Pending | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Pending
    // nothing left to carry on with
    return p.files?.some((f) => !f.done) ? p : null
  } catch {
    return null
  }
}

export function clearPending() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to do */
  }
}
