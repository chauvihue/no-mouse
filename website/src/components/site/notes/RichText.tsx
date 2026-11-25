import { createElement, type ReactNode } from 'react'

/**
 * Tiny Markdown subset for note text: paragraphs (blank line between),
 * "- " / "1. " lists, "## " / "### " headings, **bold**, *italic*, `code`, [links](url).
 */
export function RichText({ text }: { text: string }) {
  const chunks = text.trim().split(/\n\s*\n/)
  return (
    <>
      {chunks.map((chunk, i) => {
        const lines = chunk.split('\n').map((l) => l.trim())
        if (lines.every((l) => /^[-*]\s+/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^[-*]\s+/, ''))}</li>
              ))}
            </ul>
          )
        }
        if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\d+[.)]\s+/, ''))}</li>
              ))}
            </ol>
          )
        }
        const heading = /^(#{2,3})\s+(.+)$/.exec(chunk.trim())
        if (heading && lines.length === 1) {
          return createElement(heading[1].length === 2 ? 'h2' : 'h3', { key: i }, inline(heading[2]))
        }
        return <p key={i}>{inline(lines.join(' '))}</p>
      })}
    </>
  )
}

const token = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of text.matchAll(token)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    if (m[1]) out.push(<strong key={key++}>{m[1]}</strong>)
    else if (m[2]) out.push(<em key={key++}>{m[2]}</em>)
    else if (m[3]) out.push(<code key={key++}>{m[3]}</code>)
    else if (m[4]) {
      const external = /^https?:\/\//.test(m[5])
      out.push(
        <a key={key++} href={m[5]} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
          {m[4]}
        </a>,
      )
    }
    last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
