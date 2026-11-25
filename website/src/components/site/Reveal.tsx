import { createElement, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { useInView } from '../../hooks/useInView'
import { cx } from '../../lib/utils'

type Tag = 'div' | 'section' | 'article' | 'li' | 'figure' | 'header' | 'p' | 'h1' | 'h2' | 'aside' | 'ul' | 'ol'

interface RevealProps extends HTMLAttributes<HTMLElement> {
  as?: Tag
  /** Position in a group; each step delays the entrance a little so items arrive one after another. */
  index?: number
  variant?: 'rise' | 'slide' | 'scale'
  children?: ReactNode
}

/** Fades and rises (or slides) its content in the first time it scrolls into view. */
export function Reveal({ as = 'div', index = 0, variant = 'rise', className, style, children, ...rest }: RevealProps) {
  const [ref, inView] = useInView<HTMLElement>()
  return createElement(
    as,
    {
      ref,
      className: cx('reveal', `reveal--${variant}`, inView && 'is-in', className),
      style: { '--i': index, ...style } as CSSProperties,
      ...rest,
    },
    children,
  )
}
