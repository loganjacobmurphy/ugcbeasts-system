import type { Campaign, ScheduleItem } from './types'

/** Fresh installs never receive another creator's deals, rates or accounts. */
export function seedCampaigns(): Campaign[] { return [] }
export function seedSchedule(): ScheduleItem[] { return [] }
