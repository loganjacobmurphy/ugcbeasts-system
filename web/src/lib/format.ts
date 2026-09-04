export const WORKSPACE_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** Calendar date in this browser's time zone, shared by checklists and post logs. */
export function vietnamDateKey(date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: WORKSPACE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function toDate(d: Date | string): Date {
  return typeof d === 'string' ? new Date(`${d}T00:00:00`) : d
}

export const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export const fmtDate = (d: Date | string) =>
  toDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export function fmtViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  return String(n)
}
