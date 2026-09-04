import { useDB, store, uid } from '../lib/store'
import { Button, Card, EmptyState, PageHeader } from '../components/ui'
import { inputBase, cx } from '../lib/tokens'
import { Icon } from '../components/icons'

export default function Schedule() {
  const { schedule } = useDB()

  const update = (id: string, patch: { time?: string; label?: string }) =>
    store.setSchedule(schedule.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  const add = () => store.setSchedule([...schedule, { id: uid(), time: '', label: '' }])
  const remove = (id: string) => store.setSchedule(schedule.filter((s) => s.id !== id))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= schedule.length) return
    const arr = [...schedule]
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    store.setSchedule(arr)
  }
  const sortByTime = () =>
    store.setSchedule([...schedule].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99')))

  return (
    <div className="animate-in">
      <PageHeader
        title="Daily Schedule"
        action={
          <Button onClick={add}>
            <Icon name="plus" className="size-4" />
            Add step
          </Button>
        }
      />

      {schedule.length === 0 ? (
        <EmptyState icon="clock" title="No routine yet">
          <div>
            <Button onClick={add} className="mt-3">
              Add your first step
            </Button>
          </div>
        </EmptyState>
      ) : (
        <>
          <Card className="divide-y divide-neutral-100 p-2">
            {schedule.map((item, i) => (
              <div key={item.id} className="flex items-center gap-2 px-1 py-2 sm:px-2">
                <div className="flex flex-col text-neutral-300">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    aria-label="Move up"
                    className="transition-colors hover:text-neutral-900 disabled:opacity-30"
                  >
                    <Icon name="up" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i === schedule.length - 1}
                    aria-label="Move down"
                    className="transition-colors hover:text-neutral-900 disabled:opacity-30"
                  >
                    <Icon name="down" className="size-4" />
                  </button>
                </div>
                <input
                  type="time"
                  value={item.time || ''}
                  onChange={(e) => update(item.id, { time: e.target.value })}
                  className={cx(inputBase, 'w-32 shrink-0')}
                />
                <input
                  value={item.label}
                  onChange={(e) => update(item.id, { label: e.target.value })}
                  placeholder="What do you do?"
                  className={cx(inputBase, 'min-w-0 flex-1')}
                />
                <button
                  type="button"
                  onClick={() => remove(item.id)}
                  aria-label="Remove step"
                  className="shrink-0 rounded-full p-1.5 text-neutral-300 transition-colors hover:bg-red-50 hover:text-red-500"
                >
                  <Icon name="trash" className="size-4" />
                </button>
              </div>
            ))}
          </Card>
          {schedule.length > 1 && (
            <button
              type="button"
              onClick={sortByTime}
              className="mt-4 text-sm font-semibold text-neutral-400 transition-colors hover:text-neutral-900"
            >
              Sort by time
            </button>
          )}
        </>
      )}
    </div>
  )
}
