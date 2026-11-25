import { useEffect, useRef } from 'react'
import { milestones, milestoneState, milestoneStateLabel } from '../../data/timeline'
import { cx } from '../../lib/utils'
import { Icon } from './Icon'
import { Reveal } from './Reveal'

/** Vertical timeline whose line fills in, and whose nodes light up, as you scroll past. */
export function TimelineTrack() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const update = () => {
      frame = 0
      const rect = el.getBoundingClientRect()
      const anchor = window.innerHeight * 0.6
      const fill = Math.min(1, Math.max(0, (anchor - rect.top) / rect.height))
      el.style.setProperty('--fill', fill.toFixed(4))
      el.querySelectorAll<HTMLElement>('[data-node]').forEach((node) => {
        const r = node.getBoundingClientRect()
        node.classList.toggle('is-reached', r.top + 14 < anchor)
      })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [])

  return (
    <div ref={ref} className="timeline">
      <span className="timeline__track" aria-hidden="true">
        <span className="timeline__fill" />
        <span className="timeline__head">
          <svg viewBox="0 0 20 26">
            <path d="M2 1.5v19.5l5.2-4.6 3.4 7.9 3.6-1.5-3.4-7.7h6.8z" />
          </svg>
        </span>
      </span>
      <ol className="timeline__list">
        {milestones.map((m) => {
          const state = milestoneState(m)
          const tasks = m.groups.flatMap((g) => g.tasks)
          const done = tasks.filter((t) => t.done).length
          return (
            <li key={m.id} className={cx('milestone', `milestone--${state}`, m.finale && 'milestone--finale')}>
              <span className="milestone__node" data-node aria-hidden="true">
                {m.finale ? <Icon name="sparkle" size={16} /> : state === 'done' ? <Icon name="check" size={14} /> : null}
              </span>
              <p className="milestone__when">{m.label}</p>
              <Reveal variant="slide" className="milestone__card">
                <div className="milestone__top">
                  <h3>{m.title}</h3>
                  <span className={`state state--${state}`}>{milestoneStateLabel[state]}</span>
                </div>
                {m.groups.map((g, gi) => (
                  <div key={gi} className="milestone__group">
                    {g.name && <p className="milestone__group-name">{g.name}</p>}
                    <ul className="checklist">
                      {g.tasks.map((t) => (
                        <li key={t.text} className={cx(t.done && 'is-done')}>
                          <span className="checklist__box" aria-hidden="true">
                            {t.done && <Icon name="check" size={13} />}
                          </span>
                          <span>{t.text}</span>
                          <span className="sr-only">{t.done ? ' (done)' : ' (not done yet)'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {!m.finale && (
                  <div className="milestone__progress">
                    <span className="milestone__bar">
                      <span style={{ width: `${(done / tasks.length) * 100}%` }} />
                    </span>
                    <span>
                      {done}/{tasks.length} done
                    </span>
                  </div>
                )}
              </Reveal>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
