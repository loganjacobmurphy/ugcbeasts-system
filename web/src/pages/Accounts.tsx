import { Link } from 'react-router-dom'
import { useDB } from '../lib/store'
import { EmptyState, PageHeader, SectionHeader } from '../components/ui'
import { Icon, platformIcon } from '../components/icons'

export default function Accounts() {
  const { campaigns } = useDB()
  const withAccounts = campaigns.filter((c) => c.accounts.length > 0)
  const total = campaigns.reduce((s, c) => s + c.accounts.length, 0)

  return (
    <div className="animate-in">
      <PageHeader
        title="Accounts"
      />

      {total === 0 ? (
        <EmptyState icon="at" title="No accounts linked yet">
          Add account links inside each campaign on the{' '}
          <Link to="/campaigns" className="font-bold text-neutral-900 underline">
            Campaigns
          </Link>{' '}
          page.
        </EmptyState>
      ) : (
        withAccounts.map((c) => (
          /* One brand per section: a grey label on a hairline, then the accounts
             as plain rows. The brand is the group, so it never gets a box. */
          <section key={c.id} className="mb-14 last:mb-0">
            <SectionHeader
              title={c.brand}
              action={<span className="text-[15px] font-medium text-neutral-500">{c.accounts.length}</span>}
            />
            <ul>
              {c.accounts.map((a) => (
                <li key={a.id}>
                  <a
                    href={a.url || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-center gap-4 px-2 py-4"
                  >
                    <span className="grid size-12 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-600">
                      <Icon name={platformIcon(a.platform)} className="size-5" />
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-bold text-neutral-900">
                        {a.handle || a.platform}
                      </span>
                      <span className="mt-0.5 block truncate text-base font-medium text-neutral-500">
                        {a.url || 'No URL'}
                      </span>
                    </span>

                    <Icon
                      name="chevronLeft"
                      className="size-5 shrink-0 rotate-180 text-neutral-300 transition-colors group-hover:text-neutral-900"
                    />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
