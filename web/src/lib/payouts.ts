import type { Campaign } from './types'

/** Human label for a campaign's posting cadence, e.g. "2 videos / day". */
export function cadenceLabel(c: Campaign): string {
  const unit = c.cadenceType === 'per_day' ? 'day' : c.cadenceType === 'per_week' ? 'week' : 'month'
  const noun = c.cadenceCount === 1 ? 'video' : 'videos'
  return `${c.cadenceCount} ${noun} / ${unit}`
}

/** Videos due per day for this campaign (normalized from its cadence). */
export function dailyTarget(c: Campaign): number {
  if (c.cadenceType === 'per_day') return c.cadenceCount
  if (c.cadenceType === 'per_week') return Math.round(c.cadenceCount / 7)
  return Math.round(c.cadenceCount / 30)
}

/** Base pay normalized to a monthly figure. */
export function monthlyValue(c: Campaign): number {
  switch (c.payFrequency) {
    case 'weekly':
      return (c.basePay * 52) / 12
    case 'biweekly':
      return (c.basePay * 26) / 12
    case 'monthly':
      return c.basePay
    case 'custom':
      return c.customIntervalDays && c.customIntervalDays > 0
        ? (c.basePay * (365 / 12)) / c.customIntervalDays
        : c.basePay
  }
}

export function payFrequencyLabel(c: Campaign): string {
  switch (c.payFrequency) {
    case 'weekly':
      return 'Weekly'
    case 'biweekly':
      return 'Every 2 weeks'
    case 'monthly':
      return 'Monthly'
    case 'custom':
      return `Every ${c.customIntervalDays || 30} days`
  }
}
