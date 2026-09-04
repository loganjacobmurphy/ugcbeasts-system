import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/icons'
import { Button, Modal, PageHeader, SectionHeading } from '../components/ui'
import { store, useDB } from '../lib/store'
import { inputCls } from '../lib/tokens'
import type { DailyCopyBrand, DailyCopySlot } from '../lib/types'
import { vietnamDateKey, WORKSPACE_TIME_ZONE } from '../lib/format'

const TIME_ZONE = WORKSPACE_TIME_ZONE
const COUNTS: Record<DailyCopyBrand, number> = { regen: 5, roast: 3 }

function dayLabel(date: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date)
}

function instagramEmbedUrl(value: string) {
  try {
    const url = new URL(value.trim())
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return ''
    const match = url.pathname.match(/^\/(reel|p|tv)\/([^/?#]+)/i)
    if (!match) return ''
    return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/embed/`
  } catch {
    return ''
  }
}

const emptySlots = (brand: DailyCopyBrand) =>
  Array.from({ length: COUNTS[brand] }, () => ({ url: '', done: false }))

function ReferenceSlot({
  brand,
  index,
  date,
  slot,
  onPlay,
}: {
  brand: DailyCopyBrand
  index: number
  date: string
  slot: DailyCopySlot
  onPlay: () => void
}) {
  const embed = useMemo(() => instagramEmbedUrl(slot.url), [slot.url])
  const invalid = Boolean(slot.url.trim()) && !embed

  return (
    <article className={`px-4 py-3.5 transition-colors ${slot.done ? 'bg-lime-50/40' : 'bg-white'}`}>
      <div className="grid gap-3 md:grid-cols-[minmax(9rem,auto)_minmax(14rem,1fr)_auto] md:items-center">
        <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={() => store.setDailyCopySlot(date, brand, index, { done: !slot.done })}
          aria-label={slot.done ? `Mark video ${index + 1} not done` : `Mark video ${index + 1} done`}
          className={`grid size-7 shrink-0 place-items-center rounded-full border-2 transition-colors ${
            slot.done ? 'border-[#163300] bg-[#163300] text-white' : 'border-neutral-300 text-transparent'
          }`}
        >
          <Icon name="check" className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className={`text-[15px] font-bold ${slot.done ? 'text-neutral-500 line-through' : 'text-neutral-900'}`}>
            Video {index + 1}
          </p>
          <p className="text-[13px] font-medium text-neutral-500">
            {slot.done ? 'Copied' : embed ? 'Ready to copy' : 'Reference link optional'}
          </p>
        </div>
        </div>

        <div className="relative">
          <Icon name="instagram" className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-neutral-400" />
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            className={`${inputCls} pl-12`}
            placeholder="https://www.instagram.com/reel/..."
            value={slot.url}
            onChange={(event) =>
              store.setDailyCopySlot(date, brand, index, {
                url: event.target.value,
              })
            }
          />
          {invalid && (
            <p className="mt-2 text-[13px] font-semibold text-red-600">
              Paste a Reel or Instagram post link.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-1.5">
          {embed && (
            <Button variant="soft" className="px-4" onClick={onPlay}>
              <Icon name="play" className="size-4" />
              Play
            </Button>
          )}
          {slot.url && (
            <button
              type="button"
              onClick={() => store.setDailyCopySlot(date, brand, index, { url: '' })}
              className="rounded-full px-3 py-2 text-[15px] font-semibold text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

function BrandSection({
  brand,
  date,
  slots,
  onPlay,
}: {
  brand: DailyCopyBrand
  date: string
  slots: DailyCopySlot[]
  onPlay: (brand: DailyCopyBrand, index: number) => void
}) {
  const count = COUNTS[brand]
  const rows = Array.from({ length: count }, (_, index) => slots[index] ?? { url: '', done: false })
  const done = rows.filter((slot) => slot.done).length
  const title = brand === 'regen' ? 'Regen' : 'Roast'

  return (
    <section>
      <SectionHeading
        title={title}
        blurb={`${count} videos to recreate today`}
        action={
          <span className="rounded-full bg-neutral-100 px-3 py-1 text-[15px] font-bold text-neutral-600">
            {done} of {count}
          </span>
        }
      />
      <div className="divide-y divide-neutral-200 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
        {rows.map((slot, index) => (
          <ReferenceSlot
            key={`${brand}-${index}`}
            brand={brand}
            index={index}
            date={date}
            slot={slot}
            onPlay={() => onPlay(brand, index)}
          />
        ))}
      </div>
    </section>
  )
}

export default function DailyCopies() {
  const { copyDays } = useDB()
  const [now, setNow] = useState(() => new Date())
  const [playing, setPlaying] = useState<{ brand: DailyCopyBrand; index: number } | null>(null)
  const date = vietnamDateKey(now)
  const day = copyDays[date]
  const regen = day?.regen ?? emptySlots('regen')
  const roast = day?.roast ?? emptySlots('roast')
  const playingSlot = playing ? (playing.brand === 'regen' ? regen : roast)[playing.index] : undefined
  const playingEmbed = playingSlot ? instagramEmbedUrl(playingSlot.url) : ''
  const totalDone = [...regen, ...roast].filter((slot) => slot.done).length

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <>
      <PageHeader
        title="Videos to copy today"
        action={
          <span className="rounded-full bg-[#e9f7d7] px-4 py-2 text-[15px] font-bold text-[#163300]">
            {totalDone} of 8 done
          </span>
        }
      />
      <div className="mb-12 max-w-2xl">
        <p className="text-lg font-bold text-neutral-900">{dayLabel(now)}</p>
        <p className="mt-1 text-[15px] font-medium text-neutral-500">
          Tick videos off directly. Add an Instagram link only when you want the reference saved here. A fresh empty list appears at midnight in your device's time zone.
        </p>
      </div>

      <div className="space-y-16">
        <BrandSection brand="regen" date={date} slots={regen} onPlay={(brand, index) => setPlaying({ brand, index })} />
        <BrandSection brand="roast" date={date} slots={roast} onPlay={(brand, index) => setPlaying({ brand, index })} />
      </div>

      <Modal
        open={Boolean(playing && playingEmbed)}
        onClose={() => setPlaying(null)}
        title={playing ? `${playing.brand === 'regen' ? 'Regen' : 'Roast'} video ${playing.index + 1}` : 'Reference video'}
        footer={
          playing && playingSlot ? (
            <>
              <Button
                onClick={() =>
                  store.setDailyCopySlot(date, playing.brand, playing.index, { done: !playingSlot.done })
                }
              >
                <Icon name="check" className="size-4" />
                {playingSlot.done ? 'Mark as not copied' : 'Mark as copied'}
              </Button>
              <a
                href={playingSlot.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-neutral-100 px-5 py-2.5 text-[15px] font-semibold text-neutral-900 transition-colors hover:bg-neutral-200"
              >
                Open on Instagram
                <Icon name="external" className="size-4" />
              </a>
            </>
          ) : undefined
        }
      >
        {playingEmbed && (
          <div className="mx-auto w-full max-w-[430px] overflow-hidden rounded-2xl bg-black">
            <iframe
              title="Instagram reference player"
              src={playingEmbed}
              allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
              allowFullScreen
              className="h-[min(66vh,720px)] w-full border-0 bg-black"
            />
          </div>
        )}
      </Modal>
    </>
  )
}
