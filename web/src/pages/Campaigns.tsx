import { useState } from 'react'
import { useDB, store, uid } from '../lib/store'
import type { Account, CadenceType, Campaign, CampaignStatus, Platform, PayoutFrequency } from '../lib/types'
import { cadenceLabel, payFrequencyLabel } from '../lib/payouts'
import { fmtMoney, vietnamDateKey } from '../lib/format'
import { BrandBadge, Button, EmptyState, Field, Modal, PageHeader, SectionHeader } from '../components/ui'
import { dailyTarget, monthlyValue } from '../lib/payouts'
import { inputBase, inputCls, cx, LIME_DEEP } from '../lib/tokens'
import { Icon, platformIcon } from '../components/icons'

const STATUSES: CampaignStatus[] = ['active', 'upcoming', 'paused', 'ended']
const FREQS: { v: PayoutFrequency; label: string }[] = [
  { v: 'weekly', label: 'Weekly' },
  { v: 'biweekly', label: 'Every 2 weeks' },
  { v: 'monthly', label: 'Monthly' },
  { v: 'custom', label: 'Custom days' },
]
const CADENCE: { v: CadenceType; label: string }[] = [
  { v: 'per_day', label: 'per day' },
  { v: 'per_week', label: 'per week' },
  { v: 'per_month', label: 'per month' },
]
const PLATFORMS: Platform[] = ['tiktok', 'instagram', 'youtube', 'other']
const ORDER: Record<CampaignStatus, number> = { active: 0, upcoming: 1, paused: 2, ended: 3 }
const STATUS_LABEL: Record<CampaignStatus, string> = {
  active: 'Active',
  upcoming: 'Upcoming',
  paused: 'Paused',
  ended: 'Ended',
}

function blank(): Campaign {
  return {
    id: uid(),
    brand: '',
    status: 'active',
    basePay: 0,
    payFrequency: 'monthly',
    cadenceCount: 1,
    cadenceType: 'per_day',
    accounts: [],
  }
}

/** Two letters for the avatar circle, the way the reference labels a party it has no logo for. */

export default function Campaigns() {
  const { campaigns, logs, postLogs, videos, copyDays } = useDB()
  const [editing, setEditing] = useState<Campaign | null>(null)
  const [isNew, setIsNew] = useState(false)

  const sorted = [...campaigns].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.brand.localeCompare(b.brand),
  )

  // The sort already clusters by status, so the page just draws the seams:
  // one quiet group label per status, in the same order.
  const groups = STATUSES.map((status) => ({
    status,
    items: sorted.filter((c) => c.status === status),
  })).filter((g) => g.items.length > 0)

  const openNew = () => {
    setEditing(blank())
    setIsNew(true)
  }
  const openEdit = (c: Campaign) => {
    setEditing({ ...c, accounts: c.accounts.map((a) => ({ ...a })) })
    setIsNew(false)
  }
  const save = (c: Campaign) => {
    if (isNew) store.addCampaign(c)
    else store.updateCampaign(c.id, c)
    setEditing(null)
  }

  // Same shape as Home: one headline figure, then a pair of filled tiles, then
  // the list. Home already proved the layout, and these two pages are the only
  // ones that lead with money.
  const active = campaigns.filter((c) => c.status === 'active')
  const dailyCampaigns = active.filter((c) => dailyTarget(c) > 0)
  const monthly = active.reduce((sum, c) => sum + monthlyValue(c), 0)
  const perDay = dailyCampaigns.reduce((sum, c) => sum + dailyTarget(c), 0)
  // videos actually logged today against what the active deals ask for
  const dateKey = vietnamDateKey()
  const activeIds = new Set(dailyCampaigns.map((c) => c.id))
  const manualToday = dailyCampaigns.reduce(
    (sum, c) => sum + (logs[`${c.id}|${dateKey}`] || 0),
    0,
  )
  const greenroomToday = Object.values(postLogs).filter(
    (post) => post.date === dateKey && activeIds.has(post.campaignId),
  ).length
  const savedVideosToday = videos.filter(
    (video) => video.postedDate === dateKey && !!video.campaignId && activeIds.has(video.campaignId),
  ).length
  const copiedToday = copyDays[dateKey]
    ? [...copyDays[dateKey].regen, ...copyDays[dateKey].roast].filter((slot) => slot.done).length
    : 0
  // Daily Copies is the main checklist. The older logging routes remain valid,
  // but taking the larger total prevents one video being counted twice when it
  // is both ticked on Daily Copies and later marked posted in Greenroom.
  const doneToday = Math.max(copiedToday, manualToday + greenroomToday + savedVideosToday)
  const pct = perDay ? Math.min(100, Math.round((doneToday / perDay) * 100)) : 0

  return (
    <div className="animate-in">
      <PageHeader
        title="Campaigns"
        action={
          <Button onClick={openNew}>
            <Icon name="plus" className="size-4" />
            Add campaign
          </Button>
        }
      />

      {campaigns.length > 0 && (
        <>
          <div>
            <p className="text-base font-medium text-neutral-500">Base pay per month</p>
            <p className="mt-1 text-4xl font-bold tabular-nums text-neutral-900 sm:text-5xl">
              {fmtMoney(monthly)}
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col rounded-2xl bg-neutral-100 p-6">
              <h2 className="text-xl font-bold text-neutral-900">Running now</h2>
              <p className="mt-1 text-base font-medium text-neutral-500">The deals you are live on</p>
              <div className="mt-5 flex-1 space-y-3">
                <TileRow label="Brands active" value={String(active.length)} />
                <TileRow label="Videos per day" value={String(perDay)} />
              </div>
            </div>

            <div className="flex flex-col rounded-2xl bg-neutral-100 p-6">
              <h2 className="text-xl font-bold text-neutral-900">Today</h2>
              <p className="mt-1 text-base font-medium text-neutral-500">Videos logged against your daily total</p>

              <p className="mt-5 text-3xl font-bold tabular-nums text-neutral-900">
                {doneToday} of {perDay}
              </p>

              {perDay > 0 && (
                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: LIME_DEEP }} />
                </div>
              )}

              <p className="mt-3 text-base font-medium text-neutral-500">
                {perDay === 0
                  ? 'Nothing due today'
                  : doneToday >= perDay
                    ? 'All done for today'
                    : `${perDay - doneToday} still to post`}
              </p>
            </div>
          </div>

          <div className="mt-14" />
        </>
      )}

      {campaigns.length === 0 ? (
        <EmptyState title="No campaigns yet">
          <p>Add a brand to track its pay cycle, posting cadence and linked accounts.</p>
          <Button variant="soft" onClick={openNew} className="mt-5">
            Add your first
          </Button>
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section key={g.status} className="mb-14 last:mb-0">
            <SectionHeader
              title={STATUS_LABEL[g.status]}
              action={<span className="text-[15px] font-medium text-neutral-500">{g.items.length}</span>}
            />
            <ul>
              {g.items.map((c) => (
                <CampaignRow key={c.id} c={c} onEdit={() => openEdit(c)} />
              ))}
            </ul>
          </section>
        ))
      )}

      {editing && (
        <CampaignModal
          campaign={editing}
          isNew={isNew}
          onClose={() => setEditing(null)}
          onSave={save}
          onDelete={
            isNew
              ? undefined
              : () => {
                  store.removeCampaign(editing.id)
                  setEditing(null)
                }
          }
        />
      )}
    </div>
  )
}

/**
 * A campaign reads as a transaction row: avatar, name, one grey line, and the
 * money right-aligned. Account links sit under the row rather than inside it,
 * so the row itself can stay a single button that opens the editor.
 */
function CampaignRow({ c, onEdit }: { c: Campaign; onEdit: () => void }) {
  // A finished campaign greys out whole, glyph, title and amount together.
  const dim = c.status === 'ended'

  return (
    <li>
      <button
        type="button"
        onClick={onEdit}
        className="group flex w-full items-center gap-4 px-2 py-4 text-left"
      >
        <span className={dim ? 'opacity-50' : undefined}>
          <BrandBadge brand={c.brand} logoUrl={c.logoUrl} />
        </span>

        <span className="min-w-0 flex-1">
          <span
            className={cx(
              'block truncate text-base font-bold',
              dim ? 'text-neutral-400' : 'text-neutral-900',
            )}
          >
            {c.brand || 'Untitled'}
          </span>
          <span className="mt-0.5 block truncate text-base font-medium text-neutral-500">
            {cadenceLabel(c)}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span
            className={cx(
              'block text-[17px] font-bold',
              dim ? 'text-neutral-400' : 'text-neutral-900',
            )}
          >
            {fmtMoney(c.basePay)}
          </span>
          <span className="mt-0.5 block text-base font-medium text-neutral-500">
            {payFrequencyLabel(c)}
          </span>
        </span>

        <Icon
          name="chevronLeft"
          className="size-5 shrink-0 rotate-180 text-neutral-300 transition-colors group-hover:text-neutral-900"
        />
      </button>

      {(c.notes || c.accounts.length > 0) && (
        <div className="space-y-2 pb-4 pl-[4.5rem] pr-2">
          {c.notes && <p className="text-[15px] font-medium text-neutral-500">{c.notes}</p>}
          {c.accounts.length > 0 && (
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {c.accounts.map((a) => (
                <a
                  key={a.id}
                  href={a.url || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[15px] font-medium text-neutral-500 transition-colors hover:text-neutral-900"
                >
                  <Icon name={platformIcon(a.platform)} className="size-4" />
                  {a.handle || a.platform}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function CampaignModal({
  campaign,
  isNew,
  onClose,
  onSave,
  onDelete,
}: {
  campaign: Campaign
  isNew: boolean
  onClose: () => void
  onSave: (c: Campaign) => void
  onDelete?: () => void
}) {
  const [c, setC] = useState<Campaign>(campaign)
  const set = (patch: Partial<Campaign>) => setC((prev) => ({ ...prev, ...patch }))

  const addAccount = () =>
    set({ accounts: [...c.accounts, { id: uid(), platform: 'tiktok', handle: '', url: '' }] })
  const updateAccount = (id: string, patch: Partial<Account>) =>
    set({ accounts: c.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
  const removeAccount = (id: string) => set({ accounts: c.accounts.filter((a) => a.id !== id) })

  const footer = (
    <>
      {onDelete && (
        <Button variant="danger" onClick={onDelete} className="mr-auto">
          <Icon name="trash" className="size-4" />
          Delete
        </Button>
      )}
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button onClick={() => onSave(c)} disabled={!c.brand.trim()}>
        Save
      </Button>
    </>
  )

  return (
    <Modal open onClose={onClose} title={isNew ? 'New campaign' : 'Edit campaign'} footer={footer}>
      <div className="space-y-5">
        <Field label="Brand">
          <input
            className={inputCls}
            value={c.brand}
            onChange={(e) => set({ brand: e.target.value })}
            placeholder="e.g. Mogged App"
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Status">
            <select className={inputCls} value={c.status} onChange={(e) => set({ status: e.target.value as CampaignStatus })}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Base pay ($)">
            <input
              type="number"
              className={inputCls}
              value={c.basePay || ''}
              onChange={(e) => set({ basePay: Number(e.target.value) })}
              placeholder="0"
            />
          </Field>
        </div>

        <Field label="Pay cycle">
          <select
            className={inputCls}
            value={c.payFrequency}
            onChange={(e) => set({ payFrequency: e.target.value as PayoutFrequency })}
          >
            {FREQS.map((f) => (
              <option key={f.v} value={f.v}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>

        {c.payFrequency === 'custom' && (
          <Field label="Pay every N days" hint="Number of days between payouts.">
            <input
              type="number"
              className={inputCls}
              value={c.customIntervalDays || ''}
              onChange={(e) => set({ customIntervalDays: Number(e.target.value) })}
              placeholder="30"
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Posts">
            <input
              type="number"
              className={inputCls}
              value={c.cadenceCount || ''}
              onChange={(e) => set({ cadenceCount: Number(e.target.value) })}
              placeholder="1"
            />
          </Field>
          <Field label="Cadence">
            <select
              className={inputCls}
              value={c.cadenceType}
              onChange={(e) => set({ cadenceType: e.target.value as CadenceType })}
            >
              {CADENCE.map((x) => (
                <option key={x.v} value={x.v}>
                  {x.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Logo URL (optional)" hint="Leave blank to use the brand's initials on its own colour.">
          <input
            className={inputCls}
            value={c.logoUrl || ''}
            onChange={(e) => set({ logoUrl: e.target.value || undefined })}
            placeholder="https://…"
          />
        </Field>

        <Field label="Contract URL (optional)">
          <input
            className={inputCls}
            value={c.contractUrl || ''}
            onChange={(e) => set({ contractUrl: e.target.value || undefined })}
            placeholder="https://…"
          />
        </Field>

        <div className="pt-1">
          <SectionHeader
            title="Accounts"
            action={
              <button
                type="button"
                onClick={addAccount}
                className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-neutral-500 transition-colors hover:text-neutral-900"
              >
                <Icon name="plus" className="size-4" />
                Add
              </button>
            }
          />
          <div className="mt-4 space-y-2.5">
            {c.accounts.length === 0 && (
              <p className="text-[15px] font-medium text-neutral-500">No accounts linked yet.</p>
            )}
            {c.accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-2">
                <select
                  className={cx(inputBase, 'w-28 shrink-0')}
                  value={a.platform}
                  onChange={(e) => updateAccount(a.id, { platform: e.target.value as Platform })}
                >
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  className={cx(inputBase, 'w-24 shrink-0')}
                  value={a.handle}
                  onChange={(e) => updateAccount(a.id, { handle: e.target.value })}
                  placeholder="@handle"
                />
                <input
                  className={cx(inputBase, 'min-w-0 flex-1')}
                  value={a.url}
                  onChange={(e) => updateAccount(a.id, { url: e.target.value })}
                  placeholder="https://…"
                />
                <button
                  type="button"
                  onClick={() => removeAccount(a.id)}
                  aria-label="Remove account"
                  className="grid size-9 shrink-0 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                >
                  <Icon name="x" className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <Field label="Notes (optional)">
          <textarea
            className={cx(inputCls, 'min-h-20 resize-y')}
            value={c.notes || ''}
            onChange={(e) => set({ notes: e.target.value || undefined })}
            placeholder="Bonus terms, contacts, reminders…"
          />
        </Field>
      </div>
    </Modal>
  )
}

/** Grey label on the left, bold figure on the right, the way the Home tiles read. */
function TileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-base font-medium text-neutral-500">{label}</span>
      <span className="text-base font-bold tabular-nums text-neutral-900">{value}</span>
    </div>
  )
}
