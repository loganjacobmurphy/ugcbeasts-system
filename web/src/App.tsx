import { useEffect, useSyncExternalStore } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import AccountMenu from './components/AccountMenu'
import Campaigns from './pages/Campaigns'
import Generate from './pages/greenroom/Generate'
import GrFormats from './pages/greenroom/Formats'
import GrVideos from './pages/greenroom/Videos'
import GrLibrary from './pages/greenroom/Library'
import GrScripts from './pages/greenroom/Scripts'
import GrBackgrounds from './pages/greenroom/Backgrounds'
import GrEdit from './pages/greenroom/Edit'
import DailyCopies from './pages/DailyCopies'
import People from './pages/People'
import Settings from './pages/Settings'
import { BRAND } from './lib/brand'
import { Icon } from './components/icons'
import { getPageBack, subscribePageBack } from './lib/pageback'
import { getUploads, subscribeUploads } from './lib/uploads'

/**
 * A running upload, visible from wherever you happen to be.
 *
 * Uploads keep going when you leave the Content wizard, but until this existed
 * nothing said so: the progress bar was the wizard's own state, so navigating
 * away looked identical to the upload having stopped. Sits above the mobile tab
 * bar, and clicking it goes back to the batch.
 */
function UploadBar() {
  const batch = useSyncExternalStore(subscribeUploads, getUploads)
  const navigate = useNavigate()
  if (!batch) return null
  const { files, index, pct } = batch
  const overall = Math.round(((index + pct / 100) / files.length) * 100)
  return (
    <button
      type="button"
      onClick={() => navigate('/content')}
      className="animate-in fixed inset-x-0 bottom-20 z-40 mx-auto flex w-[min(26rem,calc(100%-2.5rem))] flex-col gap-2 rounded-2xl px-5 py-3.5 text-left shadow-lg md:bottom-8"
      style={{ background: '#163300', color: '#fff' }}
    >
      <span className="flex items-baseline justify-between gap-4">
        <span className="truncate text-[15px] font-semibold">
          Uploading {index + 1} of {files.length}
        </span>
        <span className="shrink-0 text-[15px] font-bold tabular-nums">{overall}%</span>
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-white/25">
        <span
          className="block h-full rounded-full transition-[width]"
          style={{ width: `${overall}%`, background: '#9fe870' }}
        />
      </span>
    </button>
  )
}

/**
 * Pages whose back control belongs in the top bar, level with the account chip,
 * rather than inside the page body. Generate is deliberately absent: its back
 * button walks the wizard back a step, it does not leave the page. Edit is full
 * bleed, so it has no top bar and keeps its own.
 */
const BACK_TO: Record<string, string> = {
  '/content/videos': '/content',
  '/content/formats': '/content',
  '/content/library': '/content',
  '/content/scripts': '/content',
  '/content/daily-copies': '/content',
  '/content/backgrounds': '/content',
}

function TopBack({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      title="Back"
      className="grid size-11 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-800 transition-colors hover:bg-neutral-200"
    >
      <Icon name="chevronLeft" className="size-5" />
    </button>
  )
}

const TITLES: Record<string, string> = {
  '/campaigns': 'Campaigns',
  '/content': 'Content',
  '/content/formats': 'Formats',
  '/content/videos': 'Videos',
  '/content/library': 'Library',
  '/content/scripts': 'Scripts',
  '/content/daily-copies': 'Videos to copy today',
  '/content/backgrounds': 'Backgrounds',
  '/people': 'People',
  '/settings': 'Settings',
}

export default function App() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  // a page can hand its own back action up here, so every back button in the app
  // sits in the same place whether it changes route or walks a wizard back a step
  const pageBack = useSyncExternalStore(subscribePageBack, getPageBack)
  useEffect(() => {
    document.title = TITLES[pathname] || BRAND
  }, [pathname])

  // the editor needs the whole column, so it opts out of the centred page padding
  const fullBleed = pathname.startsWith('/content/edit')

  const parent = BACK_TO[pathname]
  const back = pageBack ?? (parent ? () => navigate(parent) : null)

  return (
    <div className="min-h-screen md:pl-72">
      <Sidebar />
      <main
        className={
          fullBleed
            ? 'w-full min-w-0 flex-1'
            : 'mx-auto w-full max-w-5xl flex-1 px-5 pb-28 pt-7 md:px-10 md:pb-12 md:pt-10'
        }
      >
        {/* sits above the page title. On the single-user install AccountMenu
            renders null, so the row is just the back button, or nothing. */}
        {!fullBleed && (
          <div className="mb-14 flex items-center justify-between gap-4 md:-mt-3">
            {back ? <TopBack onClick={back} /> : <span />}
            <AccountMenu />
          </div>
        )}
        <Routes>
          {/* no dashboard: the work starts at Campaigns */}
          <Route path="/" element={<Navigate to="/campaigns" replace />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/people" element={<People />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/content" element={<Generate />} />
          <Route path="/content/formats" element={<GrFormats />} />
          <Route path="/content/videos" element={<GrVideos />} />
          <Route path="/content/library" element={<GrLibrary />} />
          <Route path="/content/scripts" element={<GrScripts />} />
          <Route path="/content/backgrounds" element={<GrBackgrounds />} />
          <Route path="/content/daily-copies" element={<DailyCopies />} />
          <Route path="/content/edit/:id" element={<GrEdit />} />
          <Route path="/greenroom/*" element={<Navigate to="/content" replace />} />
          <Route path="/greenroom" element={<Navigate to="/content" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <UploadBar />
    </div>
  )
}
