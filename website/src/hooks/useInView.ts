import { useEffect, useRef, useState } from 'react'

/** Elements still waiting to be revealed, mapped to the setter that reveals them. */
const pending = new Map<Element, () => void>()
let io: IntersectionObserver | null = null
let sweepTimer = 0

function reveal(el: Element) {
  const show = pending.get(el)
  if (!show) return
  pending.delete(el)
  io?.unobserve(el)
  show()
}

/**
 * IntersectionObserver never fires for an element that jumps straight past the
 * viewport (End key, restored scroll position), so after scrolling settles we
 * also reveal anything that is in view or already above it.
 */
function sweep() {
  sweepTimer = 0
  const limit = window.innerHeight * 0.92
  for (const el of [...pending.keys()]) {
    if (el.getBoundingClientRect().top < limit) reveal(el)
  }
}

function scheduleSweep() {
  if (!sweepTimer) sweepTimer = window.setTimeout(sweep, 120)
}

function observer() {
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting || e.boundingClientRect.bottom < 0) reveal(e.target)
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    window.addEventListener('scroll', scheduleSweep, { passive: true })
  }
  return io
}

/** True once the element has scrolled into view (one shared observer for the whole page). */
export function useInView<T extends Element>() {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    pending.set(el, () => setInView(true))
    observer().observe(el)
    scheduleSweep()
    return () => {
      pending.delete(el)
      io?.unobserve(el)
    }
  }, [])

  return [ref, inView] as const
}
