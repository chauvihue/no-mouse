import { createFileRoute, Link } from '@tanstack/react-router'
import { Icon } from '../../components/site/Icon'
import { NoteCard } from '../../components/site/notes/NoteCard'
import { PageHeader } from '../../components/site/PageHeader'
import { Reveal } from '../../components/site/Reveal'
import { allTags, getNotes } from '../../data/notes'
import { pageTitle } from '../../data/site'

export const Route = createFileRoute('/notes/')({
  validateSearch: (search: Record<string, unknown>): { tag?: string } =>
    typeof search.tag === 'string' && search.tag ? { tag: search.tag } : {},
  head: () => ({
    meta: [
      { title: pageTitle('Progress Notes') },
      { name: 'description', content: 'Dated progress updates from the NoMouse build, newest first.' },
    ],
  }),
  component: NotesPage,
})

function NotesPage() {
  const { tag } = Route.useSearch()
  const all = getNotes()
  const tags = allTags(all)
  const list = tag ? all.filter((n) => n.tags.includes(tag)) : all

  return (
    <>
      <PageHeader
        eyebrow="Progress Notes"
        title="Notes from the build"
        lede="Dated updates as NoMouse comes together, newest first: what we tried, what broke and what finally worked."
        motion="pinky"
      />
      <section className="section section--tight">
        <div className="container container--narrow">
          {all.length === 0 ? (
            <Reveal className="empty-notes">
              <span className="empty-notes__icon" aria-hidden="true">
                <Icon name="notes" size={34} />
                <span className="empty-notes__caret" />
              </span>
              <h2>No notes yet</h2>
              <p>The first updates from the build are on their way. Each one will have photos, clips and what we learned.</p>
            </Reveal>
          ) : (
            <>
              {tags.length > 0 && (
                <Reveal as="div" className="tag-filter">
                  <span className="tag-filter__label">Filter</span>
                  <Link to="/notes" search={{}} className="chip" activeOptions={{ includeSearch: true }} activeProps={{ 'aria-current': 'true' }}>
                    All
                  </Link>
                  {tags.map((t) => (
                    <Link
                      key={t}
                      to="/notes"
                      search={{ tag: t }}
                      className="chip"
                      activeOptions={{ includeSearch: true }}
                      activeProps={{ 'aria-current': 'true' }}
                    >
                      {t}
                    </Link>
                  ))}
                </Reveal>
              )}
              <ol className="note-feed">
                {list.map((note, i) => (
                  <Reveal as="li" key={note.slug} index={i} variant="slide">
                    <NoteCard note={note} />
                  </Reveal>
                ))}
              </ol>
              {list.length === 0 && <p className="muted">No notes tagged “{tag}” yet.</p>}
            </>
          )}
        </div>
      </section>
    </>
  )
}
