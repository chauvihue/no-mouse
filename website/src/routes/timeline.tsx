import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '../components/site/PageHeader'
import { Reveal } from '../components/site/Reveal'
import { TimelineTrack } from '../components/site/TimelineTrack'
import { pageTitle } from '../data/site'
import { milestones } from '../data/timeline'

export const Route = createFileRoute('/timeline')({
  head: () => ({
    meta: [
      { title: pageTitle('Timeline') },
      { name: 'description', content: 'Weekly NoMouse milestones from ordering parts on Nov 10 to the final demo on Dec 4.' },
    ],
  }),
  component: TimelinePage,
})

function TimelinePage() {
  const tasks = milestones.flatMap((m) => m.groups.flatMap((g) => g.tasks))
  const done = tasks.filter((t) => t.done).length
  return (
    <>
      <PageHeader
        eyebrow="Timeline"
        title="Four weeks to demo day"
        lede="From ordering parts on Nov 10 to the live demo on Dec 4. The line fills in as you scroll; checked items are done."
        motion="index"
      />
      <section className="section section--tight">
        <div className="container">
          <Reveal className="timeline-summary">
            <span className="timeline-summary__num">
              {done}
              <span>/ {tasks.length}</span>
            </span>
            <span>tasks done so far</span>
            <span className="timeline-summary__bar" aria-hidden="true">
              <span style={{ width: `${(done / tasks.length) * 100}%` }} />
            </span>
          </Reveal>
          <TimelineTrack />
        </div>
      </section>
    </>
  )
}
