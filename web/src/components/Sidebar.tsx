import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Icon, type IconName } from './icons'
import { cx } from '../lib/tokens'
import { BRAND, IS_SHARED, TAGLINE } from '../lib/brand'

/** Wise's near-black green, used for the current item and the brand mark. */
const LIME_DEEP = '#163300'

/**
 * The UGC Beasts wordmark. It says "UGC BEASTS", so it can only stand in for the
 * brand on this standalone install. See lib/brand.ts.
 */
function Wordmark() {
  if (!IS_SHARED) {
    return (
      <div className="flex items-center gap-3">
        <img
          src="/profile.svg"
          alt=""
          className="size-11 shrink-0 rounded-full object-cover"
          style={{ objectPosition: '50% 28%' }}
        />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-lg font-bold" style={{ color: LIME_DEEP }}>
            {BRAND}
          </p>
          <p className="truncate text-[15px] font-medium text-neutral-500">{TAGLINE}</p>
        </div>
      </div>
    )
  }
  // masked rather than <img>, so the mark takes the deep green from currentColor
  return (
    <span
      role="img"
      aria-label={BRAND}
      // 7:1, the mark's own ratio, so it never stretches
      className="block h-[23px] w-[161px]"
      style={{
        background: LIME_DEEP,
        maskImage: 'url(/logo.svg)',
        WebkitMaskImage: 'url(/logo.svg)',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
      }}
    />
  )
}

type Link = {
  to: string
  label: string
  short?: string
  icon: IconName
  img?: string
  /** Sub-pages, shown indented under the parent the way the reference nests
   *  Scheduled, Direct Debits and the rest under Payments. */
  children?: Link[]
}

const baseLinks: Link[] = [
  // No Home: the work is campaigns and content, and a dashboard in front of two
  // pages is a click in the way. / redirects to Campaigns instead.
  { to: '/campaigns', label: 'Campaigns', icon: 'briefcase' },
  {
    to: '/content',
    label: 'Content',
    icon: 'film',
    // Formats is deliberately not listed: Logan does not want it in the nav. The
    // route still works at /content/formats, because that page is the only place
    // in either app where a format can be created or edited.
    children: [
      { to: '/content/daily-copies', label: 'Daily copies', icon: 'calendar' },
      { to: '/content/scripts', label: 'Scripts', icon: 'type' },
      { to: '/content/library', label: 'Library', icon: 'image' },
      { to: '/content/videos', label: 'Videos', icon: 'play' },
      // Backgrounds is for the videos he cuts by hand elsewhere: the stat cards are
      // still generated here, so this hands them over without making a video first.
      { to: '/content/backgrounds', label: 'Backgrounds', icon: 'image' },
    ],
  },
]

export default function Sidebar() {
  // only an admin has anyone to approve, so nobody else gets the tab
  // People and Settings are not here: they are about the account, not the work,
  // so they live in the account menu top right (see AccountMenu).
  const links = baseLinks

  return (
    <>
      {/* Desktop sidebar. No dividing rule and no dark active state: the reference
          sits flat on the page and marks the current item with a soft grey pill. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col overflow-y-auto bg-white px-5 py-8 md:flex">
        <div className="px-3">
          <Wordmark />
        </div>
        <nav className="mt-10 flex flex-col gap-1">
          {links.map((l) => (l.children ? <Group key={l.to} link={l} /> : <Item key={l.to} link={l} />))}
        </nav>
      </aside>

      {/* Mobile bottom tab bar. The sub-pages are not repeated here: five tabs in a
          thumb-width bar is worse than reaching them from the Content page. */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-neutral-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.to === '/'}
            className={({ isActive }) =>
              cx(
                'flex flex-1 flex-col items-center gap-1 py-2.5 text-[13px] font-semibold transition-colors',
                isActive ? '' : 'text-neutral-500',
              )
            }
            style={({ isActive }) => (isActive ? { color: LIME_DEEP } : undefined)}
          >
            {l.img ? (
              <img src={l.img} alt="" className="size-5 rounded-md object-cover" />
            ) : (
              <Icon name={l.icon} className="size-5" />
            )}
            {l.short ?? l.label}
          </NavLink>
        ))}
      </nav>
    </>
  )
}

/** A top level nav item. */
function Item({ link }: { link: Link }) {
  return (
    <NavLink
      to={link.to}
      end={link.to === '/'}
      className={({ isActive }) =>
        cx(
          'flex items-center gap-4 rounded-full px-5 py-3.5 text-[17px] transition-colors',
          isActive
            ? 'bg-neutral-100 font-bold'
            : 'font-semibold text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700',
        )
      }
      style={({ isActive }) => (isActive ? { color: LIME_DEEP } : undefined)}
    >
      {link.img ? (
        <img src={link.img} alt="" className="size-6 rounded-md object-cover" />
      ) : (
        <Icon name={link.icon} className="size-6" />
      )}
      {link.label}
    </NavLink>
  )
}

/**
 * A parent with its sub-pages under it. The row itself still navigates, so
 * Content is one click away; the chevron only folds the list. Open by default,
 * which is how the reference shows its expanded group.
 */
function Group({ link }: { link: Link }) {
  const [open, setOpen] = useState(true)

  return (
    <div>
      <div className="relative">
        <Item link={link} />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? `Collapse ${link.label}` : `Expand ${link.label}`}
          aria-expanded={open}
          className="absolute inset-y-0 right-2 my-auto grid size-9 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700"
        >
          <Icon name="down" className={cx('size-5 transition-transform', open && 'rotate-180')} />
        </button>
      </div>

      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {link.children?.map((c) => (
            <NavLink
              key={c.to}
              to={c.to}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-3.5 rounded-full py-2.5 pl-8 pr-5 text-[15px] transition-colors',
                  isActive
                    ? 'bg-neutral-100 font-bold'
                    : 'font-semibold text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700',
                )
              }
              style={({ isActive }) => (isActive ? { color: LIME_DEEP } : undefined)}
            >
              <Icon name={c.icon} className="size-5" />
              {c.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}
