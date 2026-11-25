import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { allParts, countByStatus } from '../../../data/hardware'
import { getNotes } from '../../../data/notes'
import { team } from '../../../data/team'
import { currentMilestone, milestones, milestoneState } from '../../../data/timeline'
import { cx, formatDate } from '../../../lib/utils'
import { Avatar } from '../bits'
import { Icon, type IconName } from '../Icon'
import { SectionHeading } from '../PageHeader'
import { Reveal } from '../Reveal'

type To = '/how-it-works' | '/hardware' | '/timeline' | '/notes' | '/team'

function ExploreCard({
  to,
  icon,
  title,
  blurb,
  art,
  index,
  wide,
}: {
  to: To
  icon: IconName
  title: string
  blurb: string
  art: ReactNode
  index: number
  wide?: boolean
}) {
  return (
    <Reveal as="article" index={index} className={cx('explore-card lift', wide && 'explore-card--wide')}>
      <div className="explore-card__art" aria-hidden="true">
        {art}
      </div>
      <div className="explore-card__body">
        <span className="explore-card__icon" aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
        <h3>
          <Link to={to} className="stretched-link">
            {title}
          </Link>
        </h3>
        <p>{blurb}</p>
      </div>
      <span className="explore-card__go" aria-hidden="true">
        <Icon name="arrowRight" size={18} />
      </span>
    </Reveal>
  )
}

export function Explore() {
  const counts = countByStatus()
  const total = allParts.length
  const now = currentMilestone()
  const notes = getNotes()

  return (
    <section className="section explore">
      <div className="container">
        <SectionHeading eyebrow="Explore" title="Follow the build" lede="Each part of the project has its own page." />
        <div className="explore-grid">
          <ExploreCard
            index={0}
            wide
            to="/how-it-works"
            icon="waves"
            title="How it works"
            blurb="Three steps from hand to cursor, the three gestures, and the signal pipeline inside the strap."
            art={
              <div className="flow-art">
                {['Hand', 'IMU', 'ESP32', 'Laptop'].map((label, i) => (
                  <span key={label} className="flow-art__chip" style={{ animationDelay: `${i * 0.7}s` }}>
                    {label}
                  </span>
                ))}
                <span className="flow-art__line">
                  <span className="flow-art__pulse" />
                </span>
              </div>
            }
          />
          <ExploreCard
            index={1}
            to="/hardware"
            icon="chip"
            title="Hardware"
            blurb={`${counts.have} of ${total} parts in hand, plus the wiring diagram.`}
            art={
              <div className="count-art">
                <span className="count-art__big">{counts.have}</span>
                <span className="count-art__of">/ {total}</span>
                <span className="count-art__bar">
                  <span style={{ width: `${(counts.have / total) * 100}%` }} />
                </span>
              </div>
            }
          />
          <ExploreCard
            index={2}
            to="/timeline"
            icon="calendar"
            title="Timeline"
            blurb={`Nov 10 to the Dec 4 demo. Now: ${now.label}.`}
            art={
              <div className="dots-art">
                {milestones.map((m) => (
                  <span key={m.id} className={`dots-art__dot dots-art__dot--${milestoneState(m)}`} />
                ))}
              </div>
            }
          />
          <ExploreCard
            index={3}
            to="/notes"
            icon="notes"
            title="Progress Notes"
            blurb={
              notes.length
                ? `${notes.length} update${notes.length === 1 ? '' : 's'}, latest on ${formatDate(notes[0].date)}.`
                : 'Dated updates from the build, newest first. The first notes are on their way.'
            }
            art={
              <div className="paper-art">
                <span />
                <span />
                <span />
              </div>
            }
          />
          <ExploreCard
            index={4}
            to="/team"
            icon="users"
            title="Team"
            blurb="Devansh, Ashutosh and Hue, and who does what."
            art={
              <div className="avatar-stack avatar-stack--lg">
                {team.map((m) => (
                  <Avatar key={m.id} member={m} size="md" />
                ))}
              </div>
            }
          />
        </div>
      </div>
    </section>
  )
}
