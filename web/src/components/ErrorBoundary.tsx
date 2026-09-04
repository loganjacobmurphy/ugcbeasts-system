import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * A render error used to leave the whole app as a blank white page with nothing to
 * go on. This catches it and shows what actually broke, plus a way out that does not
 * involve clearing the site by hand.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Logan HQ crashed', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-lg rounded-2xl border border-neutral-200 bg-white p-7">
          <h1 className="text-2xl font-bold text-neutral-900">Something broke</h1>
          <p className="mt-1 text-base font-medium text-neutral-500">
            The page failed to render. The error is below, and a reload usually clears it.
          </p>
          <pre className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-neutral-100 p-3 text-[13px] font-medium text-neutral-700">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ''}
          </pre>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full bg-[#9fe870] px-5 py-2.5 text-[15px] font-semibold text-[#163300] hover:opacity-85"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.href = '/'
              }}
              className="rounded-full border border-neutral-900 bg-white px-5 py-2.5 text-[15px] font-semibold text-neutral-900 hover:bg-neutral-100"
            >
              Back to Home
            </button>
            <button
              type="button"
              onClick={() => {
                // last resort: the cloud copy in D1 is the source of truth, but any
                // edits made offline and not yet synced would go with it
                if (!confirm('Clear the local offline copy? Anything not yet synced to the cloud is lost.')) return
                try {
                  localStorage.removeItem('ugc-hq-db-v1')
                } catch {
                  /* ignore */
                }
                window.location.reload()
              }}
              className="rounded-full px-4 py-2.5 text-[15px] font-semibold text-red-500 hover:bg-red-50"
            >
              Clear the offline copy and reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
