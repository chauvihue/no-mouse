import type { ReactNode } from 'react'
import { HandSvg, type HandMotion } from './HandSvg'
import { Reveal } from './Reveal'

interface PageHeaderProps {
  eyebrow: string
  title: ReactNode
  lede?: ReactNode
  motion?: HandMotion
  children?: ReactNode
}

export function PageHeader({ eyebrow, title, lede, motion = 'both', children }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="container page-header__inner">
        <div className="page-header__text">
          <Reveal as="p" className="eyebrow">
            {eyebrow}
          </Reveal>
          <Reveal as="h1" index={1} className="page-title">
            {title}
          </Reveal>
          {lede && (
            <Reveal as="p" index={2} className="lede">
              {lede}
            </Reveal>
          )}
          {children && <Reveal index={3}>{children}</Reveal>}
        </div>
        <div className="page-header__art" aria-hidden="true">
          <span className="page-header__halo" />
          <div className="tilt tilt--header">
            <div className="float">
              <HandSvg motion={motion} />
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = 'start',
}: {
  eyebrow: string
  title: ReactNode
  lede?: ReactNode
  align?: 'start' | 'center'
}) {
  return (
    <div className={`section-heading section-heading--${align}`}>
      <Reveal as="p" className="eyebrow">
        {eyebrow}
      </Reveal>
      <Reveal as="h2" index={1}>
        {title}
      </Reveal>
      {lede && (
        <Reveal as="p" index={2} className="section-heading__lede">
          {lede}
        </Reveal>
      )}
    </div>
  )
}
