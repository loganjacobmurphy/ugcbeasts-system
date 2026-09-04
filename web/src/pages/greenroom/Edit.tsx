import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { STATUS_LABEL, deleteProject, getState, setPosted, type GrProject } from '../../lib/greenroom'
import { store, useDB } from '../../lib/store'
import { BackButton, Button, Modal } from '../../components/ui'
import { Icon, type IconName } from '../../components/icons'
import { cx } from '../../lib/tokens'
import { vietnamDateKey } from '../../lib/format'

/**
 * The scene editor, still the original greenroom UI in a frame, opened straight on
 * the chosen video via its #p= hash. This is the one piece not yet rebuilt as a
 * native HQ page; the timeline, transcript and drag-placement stage are a port of
 * their own.
 *
 * The bar on top is HQ's, so there is always a way back to Videos: the frame's own
 * back button would drop you into the old greenroom home instead.
 *
 * Styled off the reference's Transaction details header: round grey back button,
 * bold name, the state of the thing as a quiet grey line underneath rather than a
 * pill, and the overflow dots at the far right of the same row.
 */
export default function Edit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { campaigns } = useDB()
  const [name, setName] = useState('')
  const [project, setProject] = useState<GrProject | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [menu, setMenu] = useState(false)
  // pushed up by the editor on every paint, so the header tracks a render without
  // this page polling the tunnel a second time
  const [live, setLive] = useState<{
    status: string
    progress: number
    outDuration?: number
    warning?: string
    hasRender?: boolean
  } | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)

  /** Ask the editor to do something whose button now lives in this menu. */
  const command = (cmd: 'render' | 'rebuild') =>
    frame.current?.contentWindow?.postMessage(
      { type: 'greenroom:command', command: cmd },
      window.location.origin,
    )

  useEffect(() => {
    getState()
      .then((s) => {
        const p = s.projects.find((x: GrProject) => x.id === id) ?? null
        setProject(p)
        setName(p?.name ?? '')
      })
      .catch(() => setName(''))
  }, [id])

  // The editor has no way to read HQ's own data, so it asks for the campaign list
  // as soon as it boots and we answer. Without this its Campaign picker is empty
  // and every video reads as "No campaign" even when it has one.
  useEffect(() => {
    const send = () =>
      frame.current?.contentWindow?.postMessage(
        { type: 'greenroom:campaigns', campaigns: campaigns.map((c) => ({ id: c.id, name: c.brand })) },
        window.location.origin,
      )
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const msg = e.data as { type?: string; project?: typeof live } | null
      if (msg?.type === 'greenroom:status') {
        setLive(msg.project ?? null)
        return
      }
      if (msg?.type !== 'greenroom:ready') return
      ready.current = true
      send()
    }
    window.addEventListener('message', onMessage)
    // campaigns load asynchronously, so resend once they arrive after the frame
    if (ready.current) send()
    return () => window.removeEventListener('message', onMessage)
  }, [campaigns])

  // Posted is the state that outranks everything else here: a posted video is
  // finished, whatever the render pipeline last called it.
  const status = live?.status ?? project?.status
  const rendering = status === 'rendering' || status === 'processing' || status === 'queued'
  const state = [
    project?.posted ? 'Posted' : status ? (STATUS_LABEL[status] ?? status) : '',
    rendering && live ? `${Math.round((live.progress || 0) * 100)}%` : '',
    live?.outDuration ? `${live.outDuration}s final` : '',
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <div className="flex h-[calc(100dvh-56px)] flex-col bg-white md:h-[100dvh]">
      <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-5 py-3 md:gap-4 md:px-8">
        <BackButton onClick={() => navigate('/content/videos')} label="Back to videos" />

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-bold text-neutral-900">{name || 'Editing'}</h1>
          {state && <p className="truncate text-[15px] font-medium text-neutral-500">{state}</p>}
        </div>

        {/* Videos rows are click-to-open only now, so this is where a video gets
            marked or removed. The reference does the same: list rows carry no
            controls, the detail screen carries the overflow menu. */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            aria-label="Video actions"
            aria-haspopup="menu"
            aria-expanded={menu}
            className="grid size-11 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>

          {menu && (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => setMenu(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-2xl bg-white py-1.5 shadow-xl ring-1 ring-neutral-900/5">
                {/* Render used to be a button inside the frame. The frame has no bar
                    of its own any more, so the menu asks it to render instead. */}
                <MenuItem
                  icon="play"
                  label={rendering ? `Rendering ${Math.round((live?.progress || 0) * 100)}%` : 'Render'}
                  disabled={rendering}
                  onClick={() => {
                    setMenu(false)
                    command('render')
                  }}
                />

                {live?.hasRender && (
                  <MenuItem
                    icon="down"
                    label="Download"
                    onClick={() => {
                      setMenu(false)
                      window.open(`/greenroom/embed/api/projects/${id}/download`, '_blank')
                    }}
                  />
                )}

                {live?.warning && (
                  <MenuItem
                    icon="film"
                    label="Rebuild Hinge and stats cards"
                    onClick={() => {
                      setMenu(false)
                      command('rebuild')
                    }}
                  />
                )}

                {project?.status === 'done' && (
                  <MenuItem
                    icon={project.posted ? 'x' : 'check'}
                    label={project.posted ? 'Mark as not posted' : 'Mark as posted'}
                    onClick={async () => {
                      setMenu(false)
                      const posted = !project.posted
                      const updated = await setPosted(project.id, posted)
                      store.setProjectPostLog(project.id, project.campaign?.id, vietnamDateKey(), posted)
                      setProject(updated)
                    }}
                  />
                )}
                <MenuItem
                  icon="trash"
                  label="Delete"
                  danger
                  onClick={() => {
                    setMenu(false)
                    setConfirming(true)
                  }}
                />
              </div>
            </>
          )}
        </div>
      </header>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this video?"
        footer={
          // the reference stacks a confirm over its way out, both full width,
          // never side by side
          <div className="w-full space-y-2.5">
            <Button
              variant="destructive"
              className="w-full"
              onClick={async () => {
                if (!id) return
                await deleteProject(id)
                navigate('/content/videos')
              }}
            >
              Delete
            </Button>
            <Button variant="soft" className="w-full" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        }
      >
        <p className="text-base font-medium text-neutral-500">
          {name || 'This video'} will be removed from your greenroom. You cannot undo this.
        </p>
      </Modal>

      <iframe
        ref={frame}
        src={`/greenroom/embed/#p=${id ?? ''}`}
        title="Greenroom editor"
        allow="fullscreen; clipboard-write"
        className="min-h-0 w-full flex-1 border-0"
        // belt and braces: the frame announces itself on boot, but if that lands
        // before this page is listening the picker would sit empty for good
        onLoad={() => {
          ready.current = true
          frame.current?.contentWindow?.postMessage(
            { type: 'greenroom:campaigns', campaigns: campaigns.map((c) => ({ id: c.id, name: c.brand })) },
            window.location.origin,
          )
        }}
      />
    </div>
  )
}

/** The reference's overflow row: an outline glyph, then plain 16px label, on a
 *  panel that leans on its shadow rather than a border. */
function MenuItem({
  icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon: IconName
  label: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'flex w-full items-center gap-3 px-4 py-3 text-left text-base font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        danger ? 'text-red-600 hover:bg-red-50' : 'text-neutral-900 hover:bg-neutral-100',
      )}
    >
      <Icon name={icon} className="size-5 shrink-0" />
      {label}
    </button>
  )
}
