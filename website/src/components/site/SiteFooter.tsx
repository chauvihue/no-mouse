import { Link } from '@tanstack/react-router'
import { site } from '../../data/site'
import { team } from '../../data/team'
import { LogoMark } from './LogoMark'
import { navLinks } from './SiteNav'

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="container footer__grid">
        <div className="footer__brand">
          <Link to="/" className="footer__logo">
            <LogoMark size={36} />
            <span>NoMouse</span>
          </Link>
          <p className="footer__tagline">{site.tagline}</p>
          <p className="footer__team">{team.map((m) => m.name).join(' · ')}</p>
        </div>
        <nav className="footer__nav" aria-label="Footer">
          <p className="footer__heading">Pages</p>
          <ul>
            {navLinks.map((link) => (
              <li key={link.to}>
                <Link to={link.to}>{link.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="footer__course">
          <p className="footer__heading">Course</p>
          <p>
            <strong>{site.course.code}</strong>, {site.course.title}
          </p>
          <p>{site.course.school}</p>
        </div>
      </div>
      <div className="container footer__base">
        <p>
          {site.course.code}, {site.course.term}
        </p>
        <p className="footer__signal">
          <span className="footer__dot" aria-hidden="true" /> Made with a strap, an IMU and a lot of calibration
        </p>
      </div>
    </footer>
  )
}
