import { useCallback, useEffect, useState } from 'react'
import { Button, ChoiceList, EmptyState, Modal, PageHeader, SectionHeading } from '../components/ui'
import { Icon } from '../components/icons'
import { LIME } from '../lib/tokens'
import { getMe, logoutUrl } from '../lib/session'

/**
 * Who can get in. Admin only.
 *
 * Signing in with Google proves an email, not that the person behind it is
 * meant to be here, so everyone new lands as pending until approved from here.
 *
 * Presentation follows the reference's Recipients screen: full-bleed rows on
 * white, an initials circle, a bold name and a grey line underneath. The rows
 * carry no controls, the same rule Edit follows for videos: tapping a person
 * opens their sheet and approve, admin and remove live in its stacked footer.
 * State (waiting, admin, you) is bold near black on the right, never a pill.
 */

interface Person {
  email: string
  status: 'pending' | 'approved'
  isAdmin: boolean
  createdAt: number | null
  approvedAt: number | null
}

type Action = 'approve' | 'revoke' | 'promote' | 'demote' | 'remove'

const when = (secs: number | null) => {
  if (!secs) return ''
  return new Date(secs * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Two letters off the local part, the way the reference abbreviates a recipient. */
const initials = (email: string) => {
  const name = email.split('@')[0] ?? email
  const letters = name.replace(/[^a-zA-Z0-9]/g, '')
  return (letters.slice(0, 2) || email.slice(0, 2)).toUpperCase()
}

export default function People() {
  const me = getMe()
  const [people, setPeople] = useState<Person[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  // the sheet tracks an email rather than a person so a refresh keeps it live:
  // the row reopens with the new state, and a removed person closes it
  const [openEmail, setOpenEmail] = useState('')

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/users')
      if (!res.ok) {
        setErr(res.status === 403 ? 'Only admins can see this.' : 'Could not load people.')
        setPeople([])
        return
      }
      const body = (await res.json()) as { users: Person[] }
      setPeople(body.users)
      setErr('')
    } catch {
      setErr('Could not reach the server.')
      setPeople([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function act(email: string, action: Action) {
    if (action === 'remove' && !confirm(`Remove ${email}? Their videos and campaigns go with them.`)) return
    setBusy(email)
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, action }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setErr(body.error || 'That did not work.')
      } else {
        setErr('')
      }
    } catch {
      setErr('Could not reach the server.')
    }
    setBusy('')
    await refresh()
  }

  const pending = (people ?? []).filter((p) => p.status === 'pending')
  const approved = (people ?? []).filter((p) => p.status === 'approved')
  const open = (people ?? []).find((p) => p.email === openEmail) ?? null

  return (
    <>
      <PageHeader
        title="People"
        action={
          me ? (
            <div className="flex items-center gap-3">
              <span className="truncate text-base font-medium text-neutral-500">Signed in as {me.email}</span>
              <a
                href={logoutUrl}
                className="inline-flex shrink-0 items-center rounded-full bg-neutral-100 px-5 py-2.5 text-[15px] font-semibold text-neutral-900 transition-colors hover:bg-neutral-200"
              >
                Sign out
              </a>
            </div>
          ) : null
        }
      />

      {err && <p className="mb-8 text-base font-medium text-red-600">{err}</p>}

      {people === null ? (
        <p className="text-base font-medium text-neutral-500">Loading…</p>
      ) : people.length === 0 && !err ? (
        <EmptyState icon="at" title="Nobody yet">
          Anyone who signs in shows up here waiting for you to let them in.
        </EmptyState>
      ) : (
        <>
          {pending.length > 0 && (
            <section className="mb-14">
              <SectionHeading
                title="Waiting on you"
                action={
                  <span className="text-base font-medium text-neutral-500">
                    {pending.length} {pending.length === 1 ? 'person' : 'people'}
                  </span>
                }
              />
              <ChoiceList>
                {pending.map((p) => (
                  <Row key={p.email} person={p} onOpen={setOpenEmail} />
                ))}
              </ChoiceList>
            </section>
          )}

          <section className="mb-14">
            <SectionHeading
              title="In"
              action={
                <span className="text-base font-medium text-neutral-500">
                  {approved.length} {approved.length === 1 ? 'person' : 'people'}
                </span>
              }
            />
            {approved.length === 0 ? (
              <p className="py-6 text-base font-medium text-neutral-500">Nobody has been let in yet.</p>
            ) : (
              <ChoiceList>
                {approved.map((p) => (
                  <Row key={p.email} person={p} isSelf={p.email === me?.email} onOpen={setOpenEmail} />
                ))}
              </ChoiceList>
            )}
          </section>
        </>
      )}

      {open && (
        <PersonSheet
          person={open}
          busy={busy === open.email}
          isSelf={open.email === me?.email}
          onClose={() => setOpenEmail('')}
          onAct={act}
        />
      )}
    </>
  )
}

/** What the row and the sheet both call this person: bold near black, one word. */
const stateWord = (person: Person, isSelf?: boolean) =>
  person.status === 'pending' ? 'Waiting' : isSelf ? 'You' : person.isAdmin ? 'Admin' : 'Member'

function Row({ person, isSelf, onOpen }: { person: Person; isSelf?: boolean; onOpen: (email: string) => void }) {
  const pending = person.status === 'pending'
  const asked = when(person.createdAt)
  const since = when(person.approvedAt) || asked
  const line = pending
    ? asked
      ? `Asked ${asked}`
      : 'Asked to join'
    : since
      ? `In since ${since}`
      : 'Let in'

  return (
    <button
      type="button"
      onClick={() => onOpen(person.email)}
      className="group flex w-full items-center gap-4 px-2 py-4 text-left"
    >
      <span className="grid size-12 shrink-0 place-items-center rounded-full bg-neutral-100 text-base font-bold text-neutral-600">
        {initials(person.email)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-bold text-neutral-900">{person.email}</span>
        <span className="mt-0.5 block truncate text-base font-medium text-neutral-500">{line}</span>
      </span>

      <span className="flex shrink-0 items-center gap-2">
        {/* the only colour a row gets: a dot saying this one still needs you */}
        {pending && <span className="size-2 rounded-full" style={{ background: LIME }} aria-hidden />}
        <span className="text-base font-bold text-neutral-900">{stateWord(person, isSelf)}</span>
        <Icon name="chevronLeft" className="size-5 rotate-180 text-neutral-400" />
      </span>
    </button>
  )
}

/** The detail sheet: every action for one person, stacked full width in the
 *  footer, so a queue of five people is five plain rows and not ten buttons. */
function PersonSheet({
  person,
  busy,
  isSelf,
  onClose,
  onAct,
}: {
  person: Person
  busy: boolean
  isSelf?: boolean
  onClose: () => void
  onAct: (email: string, action: Action) => void
}) {
  const pending = person.status === 'pending'
  const asked = when(person.createdAt)
  const since = when(person.approvedAt)

  return (
    <Modal
      open
      onClose={onClose}
      title={person.email}
      footer={
        <div className="flex w-full flex-col gap-2.5">
          {pending ? (
            <Button className="w-full" disabled={busy} onClick={() => onAct(person.email, 'approve')}>
              {busy ? 'Working…' : 'Let them in'}
            </Button>
          ) : isSelf ? null : (
            <Button
              className="w-full"
              disabled={busy}
              onClick={() => onAct(person.email, person.isAdmin ? 'demote' : 'promote')}
            >
              {busy ? 'Working…' : person.isAdmin ? 'Remove admin' : 'Make admin'}
            </Button>
          )}

          <Button variant="secondary" className="w-full" disabled={busy} onClick={onClose}>
            Close
          </Button>

          {!isSelf && (
            <Button variant="danger" className="w-full" disabled={busy} onClick={() => onAct(person.email, 'remove')}>
              <Icon name="trash" className="size-4" />
              {pending ? 'Ignore' : 'Remove'}
            </Button>
          )}
        </div>
      }
    >
      <div className="divide-y divide-neutral-200">
        <Detail label="Status" value={stateWord(person, isSelf)} />
        <Detail label="Role" value={person.isAdmin ? 'Admin' : 'Member'} />
        {asked && <Detail label="Asked to join" value={asked} />}
        {since && <Detail label="In since" value={since} />}
      </div>
      {isSelf && (
        // the server refuses this anyway, so there is nothing here to press
        <p className="pt-4 text-base font-medium text-neutral-500">
          This is you, so you cannot change your own access.
        </p>
      )}
    </Modal>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3.5">
      <span className="text-[15px] font-medium text-neutral-500">{label}</span>
      <span className="text-base font-bold text-neutral-900">{value}</span>
    </div>
  )
}
