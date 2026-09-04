import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, type IconName } from './icons'
import { cx } from '../lib/tokens'
import { getMe, logoutUrl } from '../lib/session'

/**
 * Account menu, top right of every page.
 *
 * People and Settings live here rather than in the sidebar: the sidebar is for
 * the work (campaigns, content), and these are about the account. Only shown on
 * the shared install, where there is an account to speak of.
 */
export default function AccountMenu() {
  const me = getMe()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!me) return null

  const go = (to: string) => {
    setOpen(false)
    navigate(to)
  }

  return (
    <div ref={wrap} className="relative">
      {/* The reference's account control: a soft grey pill holding the avatar, the
          name, and a chevron pointing right. No outline. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cx(
          'flex max-w-[15rem] items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-3 transition-colors',
          open ? 'bg-neutral-200' : 'bg-neutral-100 hover:bg-neutral-200',
        )}
      >
        <img
          src="/profile.svg"
          alt=""
          className="size-8 shrink-0 rounded-full object-cover"
          style={{ objectPosition: '50% 28%' }}
        />
        <span className="min-w-0 truncate text-[15px] font-semibold text-neutral-900">
          {me.email.split('@')[0]}
        </span>
        <Icon
          name="chevronLeft"
          className={cx(
            'size-4 shrink-0 text-neutral-500 transition-transform',
            open ? 'rotate-90' : '-rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl"
        >
          <div className="px-4 py-3.5">
            <p className="truncate text-base font-bold text-neutral-900">{me.email}</p>
            <p className="text-[15px] font-medium text-neutral-500">{me.isAdmin ? 'Admin' : 'Member'}</p>
          </div>

          <div className="border-t border-neutral-100 py-1.5">
            {me.isAdmin && <Item icon="at" label="People" onClick={() => go('/people')} />}
            <Item icon="target" label="Settings" onClick={() => go('/settings')} />
          </div>

          <div className="border-t border-neutral-100 py-1.5">
            <a
              href={logoutUrl}
              role="menuitem"
              className="flex w-full items-center gap-3 px-4 py-2.5 text-[15px] font-medium text-neutral-900 transition-colors hover:bg-neutral-100"
            >
              <Icon name="external" className="size-5" />
              Sign out
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

function Item({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] font-medium text-neutral-900 transition-colors hover:bg-neutral-100"
    >
      <Icon name={icon} className="size-5" />
      {label}
    </button>
  )
}
