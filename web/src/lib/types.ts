export type CampaignStatus = 'active' | 'upcoming' | 'paused' | 'ended'
export type PayoutFrequency = 'weekly' | 'biweekly' | 'monthly' | 'custom'
export type CadenceType = 'per_day' | 'per_week' | 'per_month'
export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'other'

export interface Account {
  id: string
  platform: Platform
  handle: string
  url: string
}

export interface Campaign {
  id: string
  brand: string
  status: CampaignStatus
  /** Amount paid each pay period (the recurring base). */
  basePay: number
  payFrequency: PayoutFrequency
  /** Only used when payFrequency === 'custom'. */
  customIntervalDays?: number
  cadenceCount: number
  cadenceType: CadenceType
  accounts: Account[]
  contractUrl?: string
  /** Optional brand mark. When empty the badge falls back to the brand's initials
   *  on a colour derived from its name, so every campaign still reads distinctly
   *  without anyone having to upload anything. */
  logoUrl?: string
  notes?: string
}

export interface ScheduleItem {
  id: string
  /** Optional 24h time like "09:00". */
  time?: string
  label: string
}

export interface TopVideo {
  id: string
  platform: Platform
  url: string
  title?: string
  views: number
  likes?: number
  /** ISO yyyy-mm-dd. */
  postedDate?: string
  campaignId?: string
}

export interface LoggedPost {
  campaignId: string
  /** ISO yyyy-mm-dd in Logan's time zone. */
  date: string
}

export type BoardColor = 'yellow' | 'pink' | 'blue' | 'green' | 'purple' | 'orange'
export type BoardItemType = 'note' | 'text' | 'image' | 'sticker'

/** Any element on the FixMyPosture planning board. */
export interface BoardItem {
  id: string
  type: BoardItemType
  x: number
  y: number
  w?: number
  h?: number
  text?: string // note plain text
  html?: string // rich text element (bold / highlight)
  color?: BoardColor // note background
  src?: string // image data URL
  emoji?: string // sticker
}

/** A connector between two board items. */
export interface BoardArrow {
  id: string
  from: string
  to: string
}

export interface Board {
  items: BoardItem[]
  arrows: BoardArrow[]
}

export type DailyCopyBrand = 'regen' | 'roast'

export interface DailyCopySlot {
  url: string
  done: boolean
}

export interface DailyCopyDay {
  regen: DailyCopySlot[]
  roast: DailyCopySlot[]
}
