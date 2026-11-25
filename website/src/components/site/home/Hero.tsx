import { Link } from '@tanstack/react-router'
import { site } from '../../../data/site'
import { team } from '../../../data/team'
import { currentMilestone } from '../../../data/timeline'
import { Avatar } from '../bits'
import { HeroScene } from '../HeroScene'
import { Icon } from '../Icon'
import { Reveal } from '../Reveal'

export function Hero() {
  const now = currentMilestone()
  const names = team.map((m) => m.name)
  return (
    <section className="hero">
      <div className="container hero__grid">
        <div className="hero__text">
          <Reveal as="p" className="eyebrow eyebrow--pill">
            <span className="pulse-dot" aria-hidden="true" />
            {site.course.code} · {site.course.term}
          </Reveal>
          <Reveal as="h1" index={1} className="hero__title">
            NoMouse
          </Reveal>
          <Reveal as="p" index={2} className="hero__tagline">
            Your hand is the mouse.
          </Reveal>
          <Reveal as="p" index={3} className="hero__pitch">
            {site.pitch}
          </Reveal>
          <Reveal index={4} className="hero__actions">
            <Link to="/how-it-works" className="btn btn--primary">
              See how it works <Icon name="arrowRight" size={18} />
            </Link>
            <Link to="/hardware" className="btn btn--ghost">
              Hardware list
            </Link>
          </Reveal>
          <Reveal index={5} className="hero__team">
            <span className="avatar-stack">
              {team.map((m) => (
                <Avatar key={m.id} member={m} size="sm" />
              ))}
            </span>
            <span>
              By {names.slice(0, -1).join(', ')} &amp; {names[names.length - 1]}
            </span>
          </Reveal>
          <Reveal index={6}>
            <Link to="/timeline" className="now-pill">
              <span className="now-pill__dot" aria-hidden="true" />
              <span>
                <strong>Now:</strong> {now.label} · {now.title}
              </span>
            </Link>
          </Reveal>
        </div>
        <Reveal index={2} variant="scale" className="hero__art">
          <HeroScene />
        </Reveal>
      </div>
    </section>
  )
}
