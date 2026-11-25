import type { CSSProperties } from 'react'

/** Soft shapes behind every page. Each drifts at its own speed as you scroll (see .shape in styles.css). */
const shapes: { kind: string; style: CSSProperties }[] = [
  { kind: 'blob', style: { '--speed': 0.32, top: '-4%', right: '-14%', width: 'min(62vw, 720px)' } as CSSProperties },
  { kind: 'glow', style: { '--speed': 0.18, top: '9%', left: '-18%', width: 'min(58vw, 640px)' } as CSSProperties },
  { kind: 'ring', style: { '--speed': 0.5, top: '22%', right: '7%', width: '170px' } as CSSProperties },
  { kind: 'dot', style: { '--speed': 0.62, top: '12%', left: '2.5%' } as CSSProperties },
  { kind: 'grid', style: { '--speed': 0.26, top: '38%', left: '3%', width: '220px' } as CSSProperties },
  { kind: 'blob blob--alt', style: { '--speed': 0.22, top: '52%', right: '-20%', width: 'min(55vw, 620px)' } as CSSProperties },
  { kind: 'ring ring--accent', style: { '--speed': 0.44, top: '64%', left: '12%', width: '110px' } as CSSProperties },
  { kind: 'glow glow--signal', style: { '--speed': 0.14, top: '74%', right: '6%', width: 'min(40vw, 420px)' } as CSSProperties },
  { kind: 'dot dot--cyan', style: { '--speed': 0.36, top: '86%', left: '46%' } as CSSProperties },
]

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      {shapes.map((s, i) => (
        <span key={i} className={`shape shape--${s.kind.split(' ')[0]} ${s.kind}`} style={s.style} />
      ))}
    </div>
  )
}

export function ScrollProgress() {
  return <div className="scroll-progress" aria-hidden="true" />
}
