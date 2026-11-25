import { Link } from '@tanstack/react-router'
import { noteAuthors, noteCover, noteExcerpt, type Note } from '../../../data/notes'
import { asset, dateParts, formatDate } from '../../../lib/utils'
import { Byline } from '../bits'
import { Icon } from '../Icon'

export function NoteCard({ note }: { note: Note }) {
  const cover = noteCover(note)
  const { month, day } = dateParts(note.date)
  return (
    <article className="note-card lift">
      <div className="note-card__date" aria-hidden="true">
        <span className="note-card__day">{day}</span>
        <span className="note-card__month">{month}</span>
      </div>
      <div className="note-card__body">
        <p className="note-card__meta">
          <time dateTime={note.date}>{formatDate(note.date)}</time>
          {note.draft && <span className="tag tag--draft">Draft</span>}
        </p>
        <h2 className="note-card__title">
          <Link to="/notes/$slug" params={{ slug: note.slug }} className="stretched-link">
            {note.title}
          </Link>
        </h2>
        <p className="note-card__excerpt">{noteExcerpt(note)}</p>
        <div className="note-card__foot">
          <Byline authors={noteAuthors(note)} />
          {note.tags.length > 0 && (
            <ul className="tags" aria-label="Tags">
              {note.tags.map((t) => (
                <li key={t} className="tag">
                  {t}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {cover ? (
        <div className="note-card__cover">
          <img src={asset(cover.src)} alt="" loading="lazy" decoding="async" />
        </div>
      ) : (
        <span className="note-card__arrow" aria-hidden="true">
          <Icon name="arrowRight" />
        </span>
      )}
    </article>
  )
}
