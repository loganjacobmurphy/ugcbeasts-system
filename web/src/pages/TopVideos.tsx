import { useState } from 'react'
import { useDB, store, uid } from '../lib/store'
import type { Campaign, Platform, TopVideo } from '../lib/types'
import { Button, EmptyState, Field, Modal, PageHeader, SectionHeader } from '../components/ui'
import { inputCls } from '../lib/tokens'
import { Icon, platformIcon } from '../components/icons'
import { fmtViews, fmtDate } from '../lib/format'

const PLATFORMS: Platform[] = ['tiktok', 'instagram', 'youtube', 'other']

function blank(): TopVideo {
  return { id: uid(), platform: 'tiktok', url: '', views: 0 }
}

export default function TopVideos() {
  const { videos, campaigns } = useDB()
  const [editing, setEditing] = useState<TopVideo | null>(null)
  const [isNew, setIsNew] = useState(false)

  const ranked = [...videos].sort((a, b) => b.views - a.views)
  const brandOf = (id?: string) => campaigns.find((c) => c.id === id)?.brand

  const openNew = () => {
    setEditing(blank())
    setIsNew(true)
  }
  const openEdit = (v: TopVideo) => {
    setEditing({ ...v })
    setIsNew(false)
  }
  const save = (v: TopVideo) => {
    if (isNew) store.addVideo(v)
    else store.updateVideo(v.id, v)
    setEditing(null)
  }

  return (
    <div className="animate-in">
      <PageHeader
        title="Top Videos"
        action={
          <Button onClick={openNew}>
            <Icon name="plus" className="size-4" />
            Add video
          </Button>
        }
      />

      {videos.length === 0 ? (
        <EmptyState icon="play" title="No videos logged yet">
          Add your top TikToks and Reels with their view counts to track what’s working.
          <div>
            <Button variant="soft" onClick={openNew} className="mt-5">
              Add a video
            </Button>
          </div>
        </EmptyState>
      ) : (
        <section className="mb-14 last:mb-0">
          <SectionHeader
            title="Most viewed first"
            action={<span className="text-[15px] font-medium text-neutral-500">{ranked.length}</span>}
          />
          <ul className="pt-2">
            {ranked.map((v) => (
              <VideoRow key={v.id} v={v} brand={brandOf(v.campaignId)} onOpen={() => openEdit(v)} />
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <VideoModal
          video={editing}
          isNew={isNew}
          campaigns={campaigns}
          onClose={() => setEditing(null)}
          onSave={save}
          onDelete={
            isNew
              ? undefined
              : () => {
                  store.removeVideo(editing.id)
                  setEditing(null)
                }
          }
        />
      )}
    </div>
  )
}

/**
 * A logged video reads as a transaction row: platform circle, title, one grey
 * line, and the view count right aligned. The row carries no controls of its
 * own, it is a single button into the editor, and Open / Edit / Delete all live
 * in that sheet.
 */
function VideoRow({ v, brand, onOpen }: { v: TopVideo; brand?: string; onOpen: () => void }) {
  const bits = [brand, v.postedDate ? fmtDate(v.postedDate) : null].filter(Boolean)

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-center gap-4 px-2 py-4 text-left"
      >
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-600">
          <Icon name={platformIcon(v.platform)} className="size-5" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-bold text-neutral-900">
            {v.title || v.url || 'Untitled'}
          </span>
          {bits.length > 0 && (
            <span className="mt-0.5 block truncate text-base font-medium text-neutral-500">
              {bits.join(', ')}
            </span>
          )}
        </span>

        <span className="shrink-0 pl-3 text-right">
          <span className="block text-[17px] font-bold tabular-nums text-neutral-900">{fmtViews(v.views)}</span>
          <span className="mt-0.5 block text-base font-medium text-neutral-500">views</span>
        </span>
      </button>
    </li>
  )
}

function VideoModal({
  video,
  isNew,
  campaigns,
  onClose,
  onSave,
  onDelete,
}: {
  video: TopVideo
  isNew: boolean
  campaigns: Campaign[]
  onClose: () => void
  onSave: (v: TopVideo) => void
  onDelete?: () => void
}) {
  const [v, setV] = useState<TopVideo>(video)
  const set = (patch: Partial<TopVideo>) => setV((prev) => ({ ...prev, ...patch }))

  const footer = (
    <>
      {onDelete && (
        <Button variant="danger" onClick={onDelete} className="mr-auto">
          <Icon name="trash" className="size-4" />
          Delete
        </Button>
      )}
      {/* rows are click to open only now, so watching the video is an action of
          this sheet. An anchor rather than a Button so it opens in a new tab
          without a popup blocker getting in the way. */}
      {!isNew && v.url.trim() && (
        <a
          href={v.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-full bg-neutral-100 px-5 py-2.5 text-[15px] font-semibold text-neutral-900 transition-colors hover:bg-neutral-200"
        >
          <Icon name="external" className="size-4" />
          Open video
        </a>
      )}
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button onClick={() => onSave(v)} disabled={!v.url.trim() && !(v.title || '').trim()}>
        Save
      </Button>
    </>
  )

  return (
    <Modal open onClose={onClose} title={isNew ? 'Add video' : 'Edit video'} footer={footer}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Platform">
            <select className={inputCls} value={v.platform} onChange={(e) => set({ platform: e.target.value as Platform })}>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Views">
            <input
              type="number"
              className={inputCls}
              value={v.views || ''}
              onChange={(e) => set({ views: Number(e.target.value) })}
              placeholder="0"
            />
          </Field>
        </div>
        <Field label="Video URL">
          <input
            className={inputCls}
            value={v.url}
            onChange={(e) => set({ url: e.target.value })}
            placeholder="https://…"
            autoFocus
          />
        </Field>
        <Field label="Title / hook (optional)">
          <input
            className={inputCls}
            value={v.title || ''}
            onChange={(e) => set({ title: e.target.value || undefined })}
            placeholder="e.g. POV: you just found…"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Likes (optional)">
            <input
              type="number"
              className={inputCls}
              value={v.likes || ''}
              onChange={(e) => set({ likes: Number(e.target.value) || undefined })}
              placeholder="0"
            />
          </Field>
          <Field label="Posted (optional)">
            <input
              type="date"
              className={inputCls}
              value={v.postedDate || ''}
              onChange={(e) => set({ postedDate: e.target.value || undefined })}
            />
          </Field>
        </div>
        <Field label="Campaign (optional)">
          <select
            className={inputCls}
            value={v.campaignId || ''}
            onChange={(e) => set({ campaignId: e.target.value || undefined })}
          >
            <option value="">None</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.brand}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  )
}
