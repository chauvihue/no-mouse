/**
 * Progress notes: a dated feed, newest first. Each note is an ordered list of
 * typed blocks; one renderer component per block type lives in
 * src/components/site/notes/. To add a note, add an entry to `notes` below and
 * put its media in public/notes/<slug>/ (paths are relative to public/).
 *
 * Template:
 *
 *   {
 *     slug: 'first-cursor-movement',          // URL: /notes/first-cursor-movement
 *     title: 'The cursor moved!',
 *     date: '2026-11-25',                     // YYYY-MM-DD
 *     author: 'hue',                          // team id, or ['hue', 'devansh']
 *     tags: ['software', 'milestone'],
 *     summary: 'Optional one-liner for the feed; otherwise the first text block is used.',
 *     blocks: [
 *       { type: 'text', text: 'Paragraphs, **bold**, *italic*, `code`, [links](https://…) and "- " lists.' },
 *       { type: 'image', src: 'notes/first-cursor-movement/setup.jpg', alt: 'What the photo shows', caption: 'Optional' },
 *       { type: 'gif', src: 'notes/first-cursor-movement/demo.gif', alt: 'Cursor following the hand' },
 *       { type: 'video', youtube: 'https://youtu.be/VIDEO_ID', caption: 'Optional' },
 *       { type: 'video', src: 'notes/first-cursor-movement/demo.mp4', poster: 'notes/…/poster.jpg' },
 *       { type: 'gallery', images: [{ src: '…', alt: '…' }, { src: '…', alt: '…' }] },
 *       { type: 'callout', tone: 'win', title: 'Milestone', text: 'Highlighted text.' },  // tone: note | win | problem
 *     ],
 *   },
 *
 * Set `draft: true` to see a note while running `npm run dev` without publishing it.
 */
import type { TeamId } from './team'

export interface Media {
  src: string
  alt: string
  caption?: string
}

export type TextBlock = { type: 'text'; text: string }
export type ImageBlock = { type: 'image'; wide?: boolean } & Media
export type GifBlock = { type: 'gif' } & Media
export type VideoBlock = { type: 'video'; caption?: string; title?: string } & (
  | { youtube: string }
  | { src: string; poster?: string }
)
export type GalleryBlock = { type: 'gallery'; images: Media[]; caption?: string }
export type CalloutBlock = {
  type: 'callout'
  tone?: 'note' | 'win' | 'problem'
  title?: string
  text: string
}

export type NoteBlock = TextBlock | ImageBlock | GifBlock | VideoBlock | GalleryBlock | CalloutBlock

export interface Note {
  slug: string
  title: string
  date: string
  author: TeamId | TeamId[] | string
  tags: string[]
  summary?: string
  /** Feed thumbnail. Defaults to the note's first image, GIF or gallery image. */
  cover?: Media
  blocks: NoteBlock[]
  draft?: boolean
}

export const notes: Note[] = []

/** Published notes, newest first (drafts show only in dev). */
export function getNotes(): Note[] {
  return notes
    .filter((n) => import.meta.env.DEV || !n.draft)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)))
}

export function getNote(slug: string) {
  return getNotes().find((n) => n.slug === slug)
}

export function noteAuthors(note: Note): string[] {
  return Array.isArray(note.author) ? note.author : [note.author]
}

export function noteCover(note: Note): Media | undefined {
  if (note.cover) return note.cover
  for (const b of note.blocks) {
    if (b.type === 'image' || b.type === 'gif') return b
    if (b.type === 'gallery' && b.images[0]) return b.images[0]
  }
  return undefined
}

export function noteExcerpt(note: Note, max = 180): string {
  if (note.summary) return note.summary
  const text = note.blocks.find((b): b is TextBlock => b.type === 'text')?.text ?? ''
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`#>-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max).replace(/\s+\S*$/, '')}…` : plain
}

export function allTags(list: Note[] = getNotes()) {
  return [...new Set(list.flatMap((n) => n.tags))].sort()
}
