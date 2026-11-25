import { Link, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { cx } from '../../lib/utils'
import { LogoMark } from './LogoMark'

export const navLinks = [
  { to: '/', label: 'Home' },
  { to: '/how-it-works', label: 'How it works' },
  { to: '/hardware', label: 'Hardware' },
  { to: '/timeline', label: 'Timeline' },
  { to: '/notes', label: 'Progress Notes' },
  { to: '/team', label: 'Team' },
] as const

export function SiteNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => setOpen(false), [pathname])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <header className={cx('nav', scrolled && 'is-scrolled', open && 'is-open')}>
      <div className="nav__bar">
        <Link to="/" className="nav__brand">
          <LogoMark />
          <span>NoMouse</span>
        </Link>
        <button
          type="button"
          className="nav__toggle"
          aria-expanded={open}
          aria-controls="site-nav"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="nav__toggle-lines" aria-hidden="true" />
          <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
        </button>
        <nav id="site-nav" className="nav__menu" aria-label="Main">
          <ul className="nav__links">
            {navLinks.map((link) => (
              <li key={link.to}>
                <Link
                  to={link.to}
                  className="nav__link"
                  activeOptions={{ exact: link.to === '/' }}
                  activeProps={{ 'aria-current': 'page' }}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  )
}
