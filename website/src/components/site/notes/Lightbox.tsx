import { useCallback, useRef, useState, type KeyboardEvent } from 'react'
import type { Media } from '../../../data/notes'
import { asset } from '../../../lib/utils'
import { Icon } from '../Icon'

/** Click-to-enlarge for note images; arrow keys step through a gallery, Esc closes. */
export function useLightbox(items: Media[]) {
  const ref = useRef<HTMLDialogElement>(null)
  const [index, setIndex] = useState(0)
  const many = items.length > 1

  const open = useCallback((i: number) => {
    setIndex(i)
    ref.current?.showModal()
  }, [])
  const close = () => ref.current?.close()
  const step = (d: number) => setIndex((i) => (i + d + items.length) % items.length)

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (!many) return
    if (e.key === 'ArrowRight') step(1)
    if (e.key === 'ArrowLeft') step(-1)
  }

  const item = items[index]
  const dialog = (
    <dialog
      ref={ref}
      className="lightbox"
      aria-label={item?.alt ?? 'Image'}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      {item && (
        <figure className="lightbox__figure">
          <img src={asset(item.src)} alt={item.alt} />
          {(item.caption || many) && (
            <figcaption>
              {many && (
                <span className="lightbox__count">
                  {index + 1} / {items.length}
                </span>
              )}
              {item.caption}
            </figcaption>
          )}
        </figure>
      )}
      <button type="button" className="lightbox__btn lightbox__close" onClick={close} aria-label="Close">
        <Icon name="close" />
      </button>
      {many && (
        <>
          <button type="button" className="lightbox__btn lightbox__prev" onClick={() => step(-1)} aria-label="Previous image">
            <Icon name="chevronLeft" />
          </button>
          <button type="button" className="lightbox__btn lightbox__next" onClick={() => step(1)} aria-label="Next image">
            <Icon name="chevronRight" />
          </button>
        </>
      )}
    </dialog>
  )

  return { open, dialog }
}
