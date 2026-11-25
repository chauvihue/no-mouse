import { createFileRoute } from '@tanstack/react-router'
import { Avatar } from '../components/site/bits'
import { Icon, type IconName } from '../components/site/Icon'
import { PageHeader, SectionHeading } from '../components/site/PageHeader'
import { Reveal } from '../components/site/Reveal'
import { pageTitle } from '../data/site'
import { duties, team, type TeamMember } from '../data/team'

export const Route = createFileRoute('/team')({
  head: () => ({
    meta: [
      { title: pageTitle('Team') },
      { name: 'description', content: 'The NoMouse team: Devansh Mamoria, Ashutosh Mishra and Hue Chau, and who does what.' },
    ],
  }),
  component: TeamPage,
})

const linkMeta: Record<keyof NonNullable<TeamMember['links']>, { icon: IconName; label: string }> = {
  linkedin: { icon: 'linkedin', label: 'LinkedIn' },
  github: { icon: 'github', label: 'GitHub' },
  website: { icon: 'globe', label: 'Website' },
  email: { icon: 'mail', label: 'Email' },
}

function MemberLinks({ member }: { member: TeamMember }) {
  const entries = Object.entries(member.links ?? {}).filter(([, v]) => v) as [keyof typeof linkMeta, string][]
  if (!entries.length) return null
  return (
    <ul className="member__links">
      {entries.map(([key, href]) => (
        <li key={key}>
          <a
            href={key === 'email' && !href.startsWith('mailto:') ? `mailto:${href}` : href}
            target={key === 'email' ? undefined : '_blank'}
            rel="noopener noreferrer"
            aria-label={`${member.name} on ${linkMeta[key].label}`}
          >
            <Icon name={linkMeta[key].icon} size={18} />
          </a>
        </li>
      ))}
    </ul>
  )
}

function TeamPage() {
  return (
    <>
      <PageHeader eyebrow="Team" title="Three people, one strap" lede="Who’s building NoMouse, and who does what." motion="both" />

      <section className="section section--tight">
        <div className="container">
          <div className="team-grid">
            {team.map((m, i) => (
              <Reveal as="article" key={m.id} index={i} className={`member member--${m.tint} lift`}>
                <Avatar member={m} size="lg" />
                <h2 className="member__name">{m.name}</h2>
                <p className="member__role">{m.role}</p>
                <ul className="member__list">
                  {m.responsibilities.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <MemberLinks member={m} />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionHeading eyebrow="Who does what" title="Responsibilities" lede="How the work is split, from the project proposal." />
          <Reveal className="table-card">
            <table className="duty-table">
              <caption className="sr-only">Which team member owns each part of the project</caption>
              <thead>
                <tr>
                  <th scope="col">Area</th>
                  {team.map((m) => (
                    <th scope="col" key={m.id}>
                      <span className="duty-table__head">
                        <Avatar member={m} size="sm" />
                        <span>{m.short}</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {duties.map((d) => (
                  <tr key={d.task}>
                    <th scope="row">{d.task}</th>
                    {team.map((m) => (
                      <td key={m.id}>
                        {d.owners.includes(m.id) ? (
                          <span className={`duty-dot duty-dot--${m.tint}`}>
                            <Icon name="check" size={14} />
                            <span className="sr-only">{m.name}</span>
                          </span>
                        ) : (
                          <span className="duty-none" aria-hidden="true" />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>
        </div>
      </section>
    </>
  )
}
