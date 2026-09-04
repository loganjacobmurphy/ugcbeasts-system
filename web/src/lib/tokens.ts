/**
 * Design tokens and class strings, kept out of components/ui.tsx so that file
 * exports components and nothing else (which is what fast refresh needs).
 *
 * Values come from the Wise web reference.
 */

/** Wise's lime, and the near-black green that is the only text colour on it. */
export const LIME = '#9fe870'
export const LIME_DEEP = '#163300'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export type Tone = 'lime' | 'mint' | 'yellow' | 'grey' | 'muted' | 'red' | 'amber'

export const tones: Record<Tone, { bg: string; fg: string }> = {
  lime: { bg: LIME, fg: LIME_DEEP },
  mint: { bg: '#d4f2bd', fg: LIME_DEEP },
  yellow: { bg: '#ffeb69', fg: LIME_DEEP },
  grey: { bg: '#f0efeb', fg: '#454b52' },
  muted: { bg: '#f0efeb', fg: '#8a9099' },
  red: { bg: '#ffd7d5', fg: '#a8200d' },
  amber: { bg: '#ffe0b3', fg: '#7a4a00' },
}

export const inputBase =
  'rounded-xl border border-neutral-300 bg-white px-4 py-3 text-base font-medium text-neutral-900 placeholder:text-neutral-500 outline-none transition-colors focus:border-neutral-900'

export const inputCls = `${inputBase} w-full`

/** The pill-shaped search box that sits beside a page title. */
export const searchCls =
  'w-full rounded-full border border-neutral-300 bg-white py-2.5 pl-11 pr-4 text-base font-medium text-neutral-900 outline-none transition-colors placeholder:text-neutral-500 focus:border-neutral-900'

/**
 * A stable colour per brand, so two campaigns never wear the same badge and the
 * colour never moves when the list re-sorts. Backgrounds are soft enough that the
 * deep tone on top stays readable at 15px.
 */
const BRAND_COLOURS: { bg: string; fg: string }[] = [
  { bg: '#d4f2bd', fg: '#163300' },
  { bg: '#cfe4ff', fg: '#0b3a6b' },
  { bg: '#ffe0b3', fg: '#7a4a00' },
  { bg: '#ffd7d5', fg: '#8a1c0c' },
  { bg: '#e6dcff', fg: '#3b2170' },
  { bg: '#ffeb69', fg: '#4a3d00' },
  { bg: '#c9f0ea', fg: '#0d4a42' },
  { bg: '#ffd9ee', fg: '#7a1552' },
]

export function brandColour(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return BRAND_COLOURS[h % BRAND_COLOURS.length]
}

/** Two letters, the way the campaign list badges a brand. */
export function brandInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

/**
 * Logos that ship with the app, matched on the brand name.
 *
 * These exist so a known brand shows its real mark without anyone filling in a
 * field. A campaign's own `logoUrl` still wins, so pasting one in overrides this.
 * Matching is a substring on the lowercased name because the campaign is called
 * "Regen (Bounty)", not "Bounty".
 */
/**
 * `fit` is the difference between the two kinds of mark, and getting it wrong is
 * visible. An app icon already fills its own square, so it has to be let out to
 * the edges and cropped by the badge, otherwise you see the icon's own rounded
 * square sitting inside the circle with white all round it, which is what Bounty
 * looked like. A wordmark is wider than it is tall and has to be contained, or
 * cropping eats its ends.
 */
type Logo = { match: string; src: string; fit: 'cover' | 'contain' }

const BUNDLED_LOGOS: Logo[] = [
  { match: 'higgsfield', src: '/logos/higgsfield.webp', fit: 'cover' },
  { match: 'cluely', src: '/logos/cluely.jpeg', fit: 'cover' },
  { match: 'bounty', src: '/logos/bounty.png', fit: 'cover' },
  // the same deal: the campaign reads "Regen (Bounty)", but a video that carries
  // only the app name would otherwise drop to initials next to its own siblings
  { match: 'regen', src: '/logos/bounty.png', fit: 'cover' },
  { match: 'roast', src: '/logos/roast.svg', fit: 'contain' },
]

export function brandLogo(brand: string, logoUrl?: string): Logo | undefined {
  // a pasted-in URL could be either shape, so contain is the safe read: it can
  // letterbox, where cover would silently cut the sides off a wordmark
  if (logoUrl) return { match: '', src: logoUrl, fit: 'contain' }
  const name = brand.toLowerCase()
  return BUNDLED_LOGOS.find((l) => name.includes(l.match))
}
