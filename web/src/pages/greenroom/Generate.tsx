import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDB } from '../../lib/store'
import {
  GreenroomOffline,
  VIDEO_PART_BYTES,
  formatsForCampaign,
  getState,
  uploadVideo,
  type GrAudience,
  type GrFormat,
} from '../../lib/greenroom'
import { BrandBadge, Button, ChoiceList, ChoiceRow, EmptyState, PageHeader, SectionHeader } from '../../components/ui'
import { Icon } from '../../components/icons'
import { LIME, LIME_DEEP, cx, tones } from '../../lib/tokens'
import { setPageBack } from '../../lib/pageback'
import {
  clearPending,
  endBatch,
  getUploads,
  loadPending,
  markBatchFailure,
  savePending,
  setBatchProgress,
  startBatch,
  subscribeUploads,
  type Pending,
} from '../../lib/uploads'

type Step = 'campaign' | 'format' | 'audience' | 'files'

/** Stands in for a real format id when he wants them sorted by what he says. */
const AUTO = '__auto__'

/**
 * The only thing this page does is start a video: pick the campaign, the format
 * (the hook style) that campaign has access to, who it is about, then drop the
 * recordings. The hook text, green screen images and app tag are all applied
 * automatically. Finished videos live on /greenroom/videos.
 */
export default function Generate() {
  const { campaigns } = useDB()
  const navigate = useNavigate()

  const [formats, setFormats] = useState<GrFormat[] | null>(null)
  const [audiences, setAudiences] = useState<GrAudience[]>([])
  const [offline, setOffline] = useState(false)
  const [step, setStep] = useState<Step>('campaign')
  const [campaignId, setCampaignId] = useState('')
  const [formatId, setFormatId] = useState('')
  const [audienceId, setAudienceId] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // The running batch lives outside this component, so leaving the page and coming
  // back rejoins an upload in flight rather than showing a blank dropzone.
  //
  // Both of these are derived rather than copied into state. A remount has empty
  // `files` and a `step` back at the start, but the batch still knows what is going
  // up and how far along it is, so while one is running it wins.
  const batch = useSyncExternalStore(subscribeUploads, getUploads)
  const busy = batch && { index: batch.index, pct: batch.pct }
  const listed = batch?.files ?? files
  const view: Step = batch ? 'files' : step

  // What a previous session left part way up. Read once: it only changes when a
  // batch finishes, and by then this page has navigated away.
  const [pending] = useState(loadPending)
  // A part id only describes an index, not the byte range behind it. Never combine
  // parts left by the old 16 MB uploader with the new 4 MB layout or the finished
  // video would contain duplicated bytes.
  const resumablePending = pending?.partBytes === VIDEO_PART_BYTES ? pending : null
  // upload ids from that session, keyed the only way a re-picked file can be
  // recognised, since a File carries no identity across a reload
  const resumeIds: Record<string, string | undefined> = {}
  for (const f of resumablePending?.files ?? []) if (!f.done) resumeIds[`${f.name}:${f.size}`] = f.uploadId
  const key = (f: File) => `${f.name}:${f.size}`
  const resumable = listed.filter((f) => resumeIds[key(f)])
  const unfinished = (resumablePending?.files ?? []).filter((f) => !f.done)

  useEffect(() => {
    getState()
      .then((s) => {
        setFormats(s.formats)
        setAudiences(s.audiences ?? [])
      })
      .catch((e) => (e instanceof GreenroomOffline ? setOffline(true) : setError(String(e.message))))
  }, [])

  // A campaign with no formats cannot start a video, so it does not belong in
  // this picker. It remains available on Campaigns for pay and account tracking.
  const active = campaigns.filter(
    (c) =>
      (c.status === 'active' || c.status === 'upcoming') &&
      (!formats || formatsForCampaign(formats, c.id, c.brand).length > 0),
  )
  const campaign = campaigns.find((c) => c.id === campaignId)
  const available = formats ? formatsForCampaign(formats, campaignId, campaign?.brand) : []
  const format = formats?.find((f) => f.id === formatId)
  const audience = audiences.find((a) => a.id === audienceId)

  // hand the wizard's back action to App, so it renders in the same top-left slot
  // every other page's back button uses instead of floating beside the title
  useEffect(() => {
    if (step === 'campaign') {
      setPageBack(null)
      return
    }
    setPageBack(() =>
      setStep(
        step === 'files'
          ? format?.collection
            ? 'format' // this format has no audience step to go back to
            : 'audience'
          : step === 'audience'
            ? 'format'
            : 'campaign',
      ),
    )
    return () => setPageBack(null)
  }, [step, format?.collection])


  function addFiles(list: FileList | null) {
    if (!list) return
    const all = [...list]
    const vids = all.filter((f) => f.type.startsWith('video') || /\.(mp4|mov|m4v|webm|hevc|avi|mkv)$/i.test(f.name))
    const skipped = all.filter((f) => !vids.includes(f))
    // never drop a file in silence. A batch of 19 that quietly became 17 is
    // impossible to notice until the videos page comes up short.
    setError(
      skipped.length
        ? `Skipped ${skipped.length} that are not video: ${skipped.map((f) => f.name).join(', ')}`
        : '',
    )
    if (vids.length) setFiles((prev) => [...prev, ...vids])
  }

  // "let it sort them" is the batch path: pick the campaign, drop the lot in, and
  // greenroom works out the format from the transcript once each one is through
  const autoSort = formatId === AUTO

  async function queueAll() {
    if (!files.length) return
    if (!autoSort) {
      if (!format) return
      if (!format.collection && !audience) return
    }
    setError('')
    // keep going past a failure. Stopping the whole batch on the first bad upload
    // meant one blip could cost every recording after it, silently.
    const failed: string[] = []
    const opts = {
      format: autoSort ? '' : format!.id,
      audience: autoSort ? '' : (audience?.id ?? ''),
      campaignId,
      campaignName: campaign?.brand ?? '',
    }
    // Written to disk as it goes, so a refresh mid batch can pick these back up.
    // Any id carried in from a previous attempt is reused, which is what turns a
    // reload from "start that 300 MB file again" into "send the last two parts".
    const manifest: Pending = {
      partBytes: VIDEO_PART_BYTES,
      opts,
      files: files.map((f) => ({ name: f.name, size: f.size, uploadId: resumeIds[key(f)] })),
    }
    savePending(manifest)

    // published, not local: this loop outlives the component, and anyone watching
    // from another page reads its progress from here
    startBatch(files)
    for (let i = 0; i < files.length; i++) {
      setBatchProgress(i, 0)
      try {
        await uploadVideo(files[i], opts, (pct) => setBatchProgress(i, pct), {
          id: manifest.files[i].uploadId,
          onId: (id) => {
            manifest.files[i].uploadId = id
            savePending(manifest)
          },
        })
        manifest.files[i].done = true
        savePending(manifest)
      } catch (e) {
        failed.push(
          `${files[i].name} (${e instanceof GreenroomOffline ? 'connection dropped' : (e as Error).message})`,
        )
        markBatchFailure(files[i].name)
      }
    }
    endBatch()
    if (!failed.length) clearPending()
    if (failed.length) {
      setError(`${files.length - failed.length} of ${files.length} uploaded. These did not: ${failed.join('; ')}`)
      setFiles(files.filter((f) => failed.some((x) => x.startsWith(f.name))))
      return
    }
    navigate('/content/videos')
  }

  if (offline) {
    return (
      <div className="animate-in">
        <PageHeader title="Content" />
        <EmptyState icon="film" title="Content is offline">
          It runs on your laptop, so the machine needs to be awake with the tunnel running.
        </EmptyState>
      </div>
    )
  }


  return (
    <div className="animate-in">
      <PageHeader
        title="Content"
        action={
          <Link to="/content/daily-copies">
            <Button variant="soft">
              <Icon name="calendar" className="size-5" />
              Videos to copy today
            </Button>
          </Link>
        }
      />

      <div>
        {error && (
          <p
            className="mb-8 rounded-2xl px-5 py-4 text-base font-medium"
            style={{ background: tones.red.bg, color: tones.red.fg }}
          >
            {error}
          </p>
        )}

        {view === 'campaign' && (
          <StepBody title="Which campaign is this for?">
            {active.length === 0 ? (
              <EmptyState icon="briefcase" title="No active campaigns">
                Add one on the <Link to="/campaigns" className="font-semibold underline">Campaigns</Link> page first.
              </EmptyState>
            ) : (
              <ChoiceList divided={false}>
                {active.map((c) => (
                  <ChoiceRow
                    key={c.id}
                    label={c.brand}
                    hint={`${formats ? formatsForCampaign(formats, c.id, c.brand).length : 0} formats`}
                    leading={<BrandBadge brand={c.brand} logoUrl={c.logoUrl} />}
                    selected={campaignId === c.id}
                    onClick={() => {
                      setCampaignId(c.id)
                      setFormatId('')
                      setStep('format')
                    }}
                  />
                ))}
              </ChoiceList>
            )}
          </StepBody>
        )}

        {view === 'format' && (
          <StepBody title="Which format?">
            {!formats ? (
              <p className="text-base font-medium text-neutral-500">Loading formats</p>
            ) : available.length === 0 ? (
              <EmptyState icon="film" title="No formats for this campaign">
                Give a format access to {campaign?.brand} on the{' '}
                <Link to="/content/formats" className="font-semibold underline">Formats</Link> page.
              </EmptyState>
            ) : (
              <>
                {/* the batch path gets the reference's highlighted row: it is the one
                    choice that changes how the whole rest of the wizard behaves */}
                <FeatureRow
                  label="Sort them for me"
                  hint="Drop a whole batch in and each one is filed by what you say in it"
                  onClick={() => {
                    setFormatId(AUTO)
                    setAudienceId('')
                    setStep('files')
                  }}
                />

                <div className="mt-10">
                  <SectionHeader title="Or pick the format yourself" />
                  <ChoiceList>
                    {available.map((f) => (
                      <ChoiceRow
                        key={f.id}
                        label={f.name}
                        hint={f.collection ? `${f.collection} images, ${f.app}` : f.app}
                        icon="film"
                        selected={formatId === f.id}
                        onClick={() => {
                          setFormatId(f.id)
                          setAudienceId('')
                          setStep(f.collection ? 'files' : 'audience')
                        }}
                      />
                    ))}
                  </ChoiceList>
                </div>
              </>
            )}
          </StepBody>
        )}

        {view === 'audience' && (
          <StepBody title="Who is it about?">
            {audiences.length === 0 ? (
              <EmptyState icon="image" title="No image sets yet">
                Add one in the <Link to="/content/library" className="font-semibold underline">Library</Link> and it
                shows up here.
              </EmptyState>
            ) : (
              <ChoiceList>
                {audiences.map((a) => (
                  <ChoiceRow
                    key={a.id}
                    label={a.label}
                    hint={`${a.collection} images`}
                    icon="image"
                    selected={audienceId === a.id}
                    onClick={() => {
                      setAudienceId(a.id)
                      setStep('files')
                    }}
                  />
                ))}
              </ChoiceList>
            )}
          </StepBody>
        )}

        {view === 'files' && (
          <StepBody title="Add your recordings">
            {/* border-b only: StepBody's own heading already draws the rule above
                this, and border-y put a second hairline 8px under the first */}
            <dl className="mb-8 divide-y divide-neutral-200 border-b border-neutral-200">
              <Summary label="Campaign" value={campaign?.brand ?? ''} />
              <Summary label="Format" value={autoSort ? 'Sorted by what you say' : (format?.name ?? '')} />
              {audience && <Summary label="Who it is about" value={audience.label} />}
            </dl>

            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                addFiles(e.dataTransfer.files)
              }}
              className="cursor-pointer rounded-2xl bg-neutral-100 px-6 py-12 text-center transition-colors hover:bg-neutral-200"
            >
              <span className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-white text-neutral-700">
                <Icon name="up" className="size-5" />
              </span>
              <p className="text-lg font-bold text-neutral-900">Drop recordings here, or click to choose</p>
              <p className="mx-auto mt-1.5 max-w-md text-base font-medium text-neutral-500">
                Each one becomes its own video and they process one after another
              </p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="video/*"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }}
            />

            {/* Left over from a batch that did not finish, usually a refresh or a
                closed tab. Greenroom still has the parts that arrived, so picking
                the same files again continues them rather than starting over. */}
            {!batch && unfinished.length > 0 && (
              <div className="mt-8 rounded-2xl bg-neutral-100 px-5 py-4">
                <p className="text-base font-bold text-neutral-900">
                  {unfinished.length === 1
                    ? '1 recording did not finish'
                    : `${unfinished.length} recordings did not finish`}
                </p>
                <p className="mt-1 text-base font-medium text-neutral-500">
                  Choose {unfinished.length === 1 ? 'it' : 'them'} again and they carry on from where
                  they stopped: {unfinished.map((f) => f.name).join(', ')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    clearPending()
                    location.reload()
                  }}
                  className="mt-3 text-base font-semibold text-neutral-900 underline"
                >
                  Forget them
                </button>
              </div>
            )}

            {listed.length > 0 && (
              <div className="mt-10">
                <SectionHeader
                  title={listed.length === 1 ? '1 recording' : `${listed.length} recordings`}
                  action={
                    resumable.length > 0 && !batch ? (
                      <span className="text-[15px] font-medium text-neutral-500">
                        {resumable.length} will carry on
                      </span>
                    ) : undefined
                  }
                />
                <ul className="divide-y divide-neutral-200">
                  {listed.map((f, i) => {
                    const uploading = busy?.index === i
                    // rows already through are greyed the way the reference retires a
                    // finished item, rather than claiming a result the batch has not
                    // finished checking for
                    const done = !!busy && busy.index > i
                    return (
                      <li key={`${f.name}-${i}`} className={cx('py-4', done && 'opacity-40')}>
                        <div className="flex items-center gap-4">
                          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-600">
                            <Icon name="film" className="size-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-base font-bold text-neutral-900">{f.name}</span>
                            {uploading && (
                              <span className="mt-0.5 block text-base font-medium text-neutral-500">Uploading</span>
                            )}
                          </span>
                          <span className="shrink-0 text-[17px] font-bold tabular-nums text-neutral-900">
                            {uploading ? `${busy.pct}%` : `${(f.size / 1024 / 1024).toFixed(0)} MB`}
                          </span>
                          {!busy && (
                            <button
                              type="button"
                              onClick={() => setFiles(files.filter((_, j) => j !== i))}
                              className="grid size-10 shrink-0 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
                              aria-label={`Remove ${f.name}`}
                            >
                              <Icon name="x" className="size-5" />
                            </button>
                          )}
                        </div>
                        {uploading && (
                          <div className="mt-3 h-1 overflow-hidden rounded-full bg-neutral-200">
                            <div
                              className="h-full rounded-full transition-[width]"
                              style={{ width: `${busy.pct}%`, background: LIME_DEEP }}
                            />
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            <div className="mt-10">
              <Button className="w-full" disabled={!files.length || !!busy} onClick={queueAll}>
                {busy
                  ? `Uploading ${busy.index + 1} of ${listed.length}`
                  : listed.length > 1
                    ? `Start ${listed.length} videos`
                    : 'Start video'}
              </Button>
            </div>
          </StepBody>
        )}
      </div>
    </div>
  )
}

/** The reference's wizard rail: a filled segment per step done, the one you are
 *  on named in black and the rest in grey. */

/** One question in the wizard. The heading is the real section heading the
 *  reference uses for a step, not the quiet grey group label. */
function StepBody({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionHeader title={title} />
      <div className="pt-2">{children}</div>
    </section>
  )
}

/**
 * The reference's highlighted choice: same row, sitting on a grey fill with a
 * lime circle, for the one option that is a different route rather than a
 * sibling of the list under it. Not in the shared kit, only this page needs it.
 */
function FeatureRow({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-4 bg-neutral-100 px-4 py-5 text-left"
    >
      <span
        className="grid size-12 shrink-0 place-items-center rounded-full"
        style={{ background: LIME, color: LIME_DEEP }}
      >
        <Icon name="sparkle" className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-bold text-neutral-900">{label}</span>
        <span className="mt-0.5 block text-base font-medium text-neutral-500">{hint}</span>
      </span>
      <Icon
        name="chevronLeft"
        className="size-5 shrink-0 rotate-180 text-neutral-400 transition-colors group-hover:text-neutral-900"
      />
    </button>
  )
}

/** Grey label, bold answer, the way the reference recaps what you picked. */
function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-3.5">
      <dt className="shrink-0 text-base font-medium text-neutral-500">{label}</dt>
      <dd className="min-w-0 truncate text-base font-bold text-neutral-900">{value}</dd>
    </div>
  )
}
