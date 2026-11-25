import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { Byline } from '../../components/site/bits'
import { Icon } from '../../components/site/Icon'
import { NoteBlocks } from '../../components/site/notes/blocks'
import { Reveal } from '../../components/site/Reveal'
import { getNote, getNotes, noteAuthors, noteExcerpt } from '../../data/notes'
import { pageTitle } from '../../data/site'
import { formatDate } from '../../lib/utils'

export const Route = createFileRoute('/notes/$slug')({
  loader: ({ params }) => {
    const note = getNote(params.slug)
    if (!note) throw notFound()
    return { note }
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [{ title: pageTitle(loaderData.note.title) }, { name: 'description', content: noteExcerpt(loaderData.note) }]
      : [{ title: pageTitle('Note not found') }],
  }),
  component: NotePage,
  notFoundComponent: NoteNotFound,
})

function NotePage() {
  const { note } = Route.useLoaderData()
  const all = getNotes()
  const i = all.findIndex((n) => n.slug === note.slug)
  const newer = i > 0 ? all[i - 1] : undefined
  const older = i >= 0 && i < all.length - 1 ? all[i + 1] : undefined

  return (
    <article className="note">
      <header className="container container--narrow note__header">
        <Reveal>
          <Link to="/notes" className="back-link">
            <Icon name="arrowLeft" size={18} /> All notes
          </Link>
        </Reveal>
        <Reveal as="p" index={1} className="eyebrow">
          Progress note · <time dateTime={note.date}>{formatDate(note.date)}</time>
          {note.draft && <span className="tag tag--draft">Draft</span>}
        </Reveal>
        <Reveal as="h1" index={2} className="note__title">
          {note.title}
        </Reveal>
        <Reveal index={3} className="note__meta">
          <Byline authors={noteAuthors(note)} />
          {note.tags.length > 0 && (
            <ul className="tags" aria-label="Tags">
              {note.tags.map((t) => (
                <li key={t}>
                  <Link to="/notes" search={{ tag: t }} className="tag tag--link">
                    {t}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Reveal>
      </header>

      <div className="container container--narrow note__body">
        <NoteBlocks blocks={note.blocks} />
      </div>

      {(older || newer) && (
        <nav className="container container--narrow note-pager" aria-label="More notes">
          {older ? (
            <Link to="/notes/$slug" params={{ slug: older.slug }} className="note-pager__link lift">
              <span className="note-pager__dir">
                <Icon name="arrowLeft" size={16} /> Older
              </span>
              <span className="note-pager__title">{older.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {newer && (
            <Link to="/notes/$slug" params={{ slug: newer.slug }} className="note-pager__link note-pager__link--next lift">
              <span className="note-pager__dir">
                Newer <Icon name="arrowRight" size={16} />
              </span>
              <span className="note-pager__title">{newer.title}</span>
            </Link>
          )}
        </nav>
      )}
    </article>
  )
}

function NoteNotFound() {
  return (
    <section className="section not-found">
      <div className="container not-found__inner">
        <p className="eyebrow">Progress Notes</p>
        <h1 className="page-title">We couldn’t find that note.</h1>
        <p className="lede">It may have been renamed or not published yet.</p>
        <Link to="/notes" className="btn btn--primary">
          All notes
        </Link>
      </div>
    </section>
  )
}
