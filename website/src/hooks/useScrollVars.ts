import { useEffect } from 'react'
import { useRouterState } from '@tanstack/react-router'

/**
 * Publishes scroll position as CSS variables on <html>, once per frame:
 *   --sy        scrollY in px (unitless number)
 *   --progress  0..1 through the page
 * Parallax shapes, the tilting hand and the progress bar all read these.
 */
export function useScrollVars() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  useEffect(() => {
    const root = document.documentElement
    let frame = 0

    const update = () => {
      frame = 0
      const y = window.scrollY
      const max = root.scrollHeight - window.innerHeight
      root.style.setProperty('--sy', y.toFixed(1))
      root.style.setProperty('--progress', max > 0 ? Math.min(1, Math.max(0, y / max)).toFixed(4) : '0')
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const resize = new ResizeObserver(schedule)
    resize.observe(document.body)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      resize.disconnect()
    }
  }, [pathname])
}
