export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

/** Resolve a path inside public/ against the site's base URL. Full URLs pass through. */
export function asset(path: string) {
  if (/^([a-z]+:)?\/\//i.test(path) || /^(data|blob):/.test(path)) return path
  return import.meta.env.BASE_URL + path.replace(/^\/+/, '')
}

function parseISODate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
}

const long = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const parts = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "Nov 24, 2026" */
export function formatDate(iso: string) {
  return long.format(parseISODate(iso))
}

/** { month: 'Nov', day: '24' } */
export function dateParts(iso: string) {
  const p = parts.formatToParts(parseISODate(iso))
  return {
    month: p.find((x) => x.type === 'month')?.value ?? '',
    day: p.find((x) => x.type === 'day')?.value ?? '',
  }
}

/** Accepts a YouTube URL or a bare video ID. */
export function youtubeId(input: string) {
  const m = /(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/.exec(input)
  return m ? m[1] : input.trim()
}
