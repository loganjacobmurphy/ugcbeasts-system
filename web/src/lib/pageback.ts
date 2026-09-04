/**
 * Lets a page hand its own back action to the top bar.
 *
 * App renders one back button, top left, level with the account chip. Most pages
 * just need "go to my parent route", which App reads from its BACK_TO map. The
 * Content wizard is different: its back steps through the wizard rather than
 * changing route, and it still has to appear in the same place as everyone
 * else's, so it registers a handler here instead of drawing its own button.
 */
type Handler = (() => void) | null

let current: Handler = null
const subscribers = new Set<() => void>()

export function setPageBack(fn: Handler) {
  if (current === fn) return
  current = fn
  subscribers.forEach((notify) => notify())
}

export function subscribePageBack(cb: () => void) {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function getPageBack(): Handler {
  return current
}
