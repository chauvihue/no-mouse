import { site } from '../../../data/site'
import { SectionHeading } from '../PageHeader'
import { Reveal } from '../Reveal'

export function About() {
  return (
    <section className="section about" id="about">
      <div className="container about__grid">
        <div className="about__aside">
          <SectionHeading eyebrow="About" title="About the project" />
          <dl className="facts">
            {site.facts.map((f, i) => (
              <Reveal key={f.label} index={i + 2} variant="slide" className="fact">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </Reveal>
            ))}
          </dl>
        </div>
        <Reveal index={1} className="about__card">
          <p className="about__label">Project description</p>
          <p className="about__paragraph">{site.description}</p>
        </Reveal>
      </div>
    </section>
  )
}
