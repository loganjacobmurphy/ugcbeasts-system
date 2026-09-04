import { createPortal } from 'react-dom'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { CampaignStatus } from '../lib/types'
import { Icon, type IconName } from './icons'
import { LIME, LIME_DEEP, brandColour, brandInitials, brandLogo, cx, tones, type Tone } from '../lib/tokens'

/**
 * The shared kit, styled against the Wise web reference.
 *
 * The rules the whole dashboard follows from here:
 *   one flat white page, no panel backgrounds
 *   1px hairlines, never 2px slabs
 *   fully rounded controls, lime only on the primary action
 *   a grey section label sitting on a hairline, not a heavy heading
 *   nothing below 15px
 */

/* ----------------------------------------------------------------- buttons */

type Variant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger' | 'destructive'

const variants: Record<Variant, string> = {
  primary: '',  // lime, applied inline so it cannot drift from the token
  secondary: 'border border-neutral-900 bg-white text-neutral-900 hover:bg-neutral-100',
  // grey fill, for rows of secondary nav where four outlines would shout
  soft: 'bg-neutral-100 text-neutral-900 hover:bg-neutral-200',
  ghost: 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
  danger: 'text-red-600 hover:bg-red-50',
  destructive: 'bg-red-600 text-white hover:bg-red-700',
}

export function Button({
  variant = 'primary',
  className,
  children,
  type,
  ...rest
}: { variant?: Variant } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[15px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40',
        variants[variant],
        className,
      )}
      style={variant === 'primary' ? { background: LIME, color: LIME_DEEP } : undefined}
      {...rest}
    >
      {children}
    </button>
  )
}

/** Round chevron button. Pages listed in App's BACK_TO get theirs in the top bar
 *  instead and should not render this. */
export function BackButton({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-11 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-800 transition-colors hover:bg-neutral-200"
    >
      <Icon name="chevronLeft" className="size-5" />
    </button>
  )
}

/* -------------------------------------------------------------------- tags */

/** One word wherever possible. Colour carries the meaning, the word confirms it. */
export function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className="inline-block rounded-full px-3 py-1 text-[15px] font-semibold"
      style={{ background: tones[tone].bg, color: tones[tone].fg }}
    >
      {children}
    </span>
  )
}

const statusTone: Record<CampaignStatus, Tone> = {
  active: 'lime',
  upcoming: 'mint',
  paused: 'yellow',
  ended: 'muted',
}

export function StatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-3 py-1 text-[15px] font-semibold capitalize"
      style={{ background: tones[statusTone[status]].bg, color: tones[statusTone[status]].fg }}
    >
      {status}
    </span>
  )
}

/* ---------------------------------------------------------------- surfaces */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-2xl border border-neutral-200 bg-white', className)}>{children}</div>
}

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="text-3xl font-bold text-neutral-900 sm:text-4xl">{title}</h1>
      {action}
    </div>
  )
}

/** The reference's group label: quiet grey text over a hairline, generous air.
 *  Reserved for date groups and minor sub-groups. For the spine of a page use
 *  SectionHeading below. */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-neutral-200 pb-3">
      <h2 className="text-[15px] font-medium text-neutral-500">{title}</h2>
      {action}
    </div>
  )
}

/**
 * The heavy section heading: bold near black, no hairline under it, an optional
 * grey blurb and an optional right-hand action or count.
 *
 * This is the variant the reference uses for the real sections of a page, and
 * the one five pages were each redefining locally at four different sizes.
 * `size="lg"` is the larger step for pages whose sections carry a whole screen;
 * `className` is there to retune the bottom margin, nothing else.
 */
export function SectionHeading({
  title,
  blurb,
  action,
  size = 'md',
  className,
}: {
  title: string
  blurb?: string
  action?: ReactNode
  size?: 'md' | 'lg'
  className?: string
}) {
  return (
    <div className={cx('mb-4', className)}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className={cx('font-bold text-neutral-900', size === 'lg' ? 'text-2xl' : 'text-xl')}>{title}</h2>
        {action}
      </div>
      {blurb && <p className="mt-2 max-w-2xl text-base font-medium text-neutral-500">{blurb}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ inputs */

/**
 * One form label for the whole app. The reference writes a field label bold and
 * near black above the input, so that is the default here: the grey version read
 * as a caption rather than a question, which is why two pages had each grown
 * their own bold copy of this component.
 *
 * `strong={false}` keeps the quiet grey caption for the rare read-only pairing.
 */
export function Field({
  label,
  children,
  hint,
  strong = true,
}: {
  label: string
  children: ReactNode
  hint?: string
  strong?: boolean
}) {
  return (
    <label className="block">
      <span className={cx('text-[15px]', strong ? 'font-bold text-neutral-900' : 'font-medium text-neutral-500')}>
        {label}
      </span>
      <div className={strong ? 'mt-2' : 'mt-1.5'}>{children}</div>
      {hint && (
        <p className={cx('text-[15px] font-medium text-neutral-500', strong ? 'mt-2' : 'mt-1.5')}>{hint}</p>
      )}
    </label>
  )
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  )
}

/**
 * A brand's mark: its logo when it has one, otherwise its initials on a colour
 * derived from the name. Used anywhere a campaign is listed, so the same brand
 * always looks the same wherever it turns up.
 */
export function BrandBadge({
  brand,
  logoUrl,
  className = 'size-12',
}: {
  brand: string
  logoUrl?: string
  className?: string
}) {
  const c = brandColour(brand)
  const logo = brandLogo(brand, logoUrl)
  if (logo) {
    // A covered mark gets no padding, so the circle actually clips it. Padding is
    // what left Bounty reading as a rounded square: inset by p-1 the icon never
    // reached the rounded edge, so its own corners showed instead of the badge's.
    const cover = logo.fit === 'cover'
    return (
      <span
        className={cx(
          'grid shrink-0 place-items-center overflow-hidden rounded-full',
          cover ? '' : 'bg-white p-1',
          className,
        )}
      >
        <img src={logo.src} alt="" className={cx('size-full', cover ? 'object-cover' : 'object-contain')} />
      </span>
    )
  }
  return (
    <span
      className={cx('grid shrink-0 place-items-center rounded-full text-[15px] font-bold', className)}
      style={{ background: c.bg, color: c.fg }}
    >
      {brandInitials(brand)}
    </span>
  )
}

/**
 * The reference's "pick one" row, used wherever a screen asks you to choose:
 * a circle, a bold label, a grey hint, and a chevron. Stack them in ChoiceList,
 * which draws the hairlines. Deliberately not a card: the reference only boxes
 * things that are genuinely separate objects.
 */
export function ChoiceList({ children, divided = true }: { children: ReactNode; divided?: boolean }) {
  return <div className={divided ? 'divide-y divide-neutral-200' : undefined}>{children}</div>
}

export function ChoiceRow({
  label,
  hint,
  icon,
  leading,
  selected,
  onClick,
}: {
  label: string
  hint?: string
  icon?: IconName
  /** Overrides the icon circle, for rows that carry a brand mark or a photo. */
  leading?: ReactNode
  selected?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-4 px-2 py-4 text-left"
    >
      {leading ?? (
        <span
          className={cx('grid size-12 shrink-0 place-items-center rounded-full', !selected && 'bg-neutral-100')}
          style={selected ? { background: LIME, color: LIME_DEEP } : { color: '#454b52' }}
        >
          {icon && <Icon name={icon} className="size-5" />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-bold text-neutral-900">{label}</span>
        {hint && <span className="mt-0.5 block truncate text-base font-medium text-neutral-500">{hint}</span>}
      </span>
      <Icon
        name="chevronLeft"
        className="size-5 shrink-0 rotate-180 text-neutral-300 transition-colors group-hover:text-neutral-900"
      />
    </button>
  )
}

/* ------------------------------------------------------------ empty, modal */

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: IconName
  title: string
  children?: ReactNode
}) {
  return (
    <div className="py-16 text-center">
      {icon && (
        <div className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-neutral-100 text-neutral-400">
          <Icon name={icon} className="size-6" />
        </div>
      )}
      <p className="text-xl font-bold text-neutral-900">{title}</p>
      {children && (
        <div className="mx-auto mt-2 max-w-sm text-base font-medium text-neutral-500">{children}</div>
      )}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}) {
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-neutral-900/25" onClick={onClose} />
      {/* shadow only: the reference sheet has no hairline on top of its shadow */}
      <div className="animate-in relative z-10 flex max-h-[92vh] w-full flex-col rounded-t-3xl bg-white shadow-2xl md:max-w-lg md:rounded-3xl">
        <header className="flex items-center justify-between gap-4 px-6 pb-4 pt-6">
          <h2 className="text-xl font-bold text-neutral-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-10 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-700 transition-colors hover:bg-neutral-200"
          >
            <Icon name="x" className="size-5" />
          </button>
        </header>
        <div className="overflow-y-auto px-6 pb-2">{children}</div>
        {/* the reference stacks a sheet's buttons full width, primary on top and
            the way out beneath it, never side by side */}
        {footer && <footer className="flex w-full flex-col gap-2.5 px-6 py-5">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

/** Small dark pill, bottom centre, the way the reference confirms an action. */
export function Toast({ message }: { message: string }) {
  if (!message) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center px-5">
      <div className="animate-in rounded-full bg-neutral-900 px-5 py-2.5 text-[15px] font-medium text-white shadow-lg">
        {message}
      </div>
    </div>
  )
}
