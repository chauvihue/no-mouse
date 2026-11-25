import type {
  CalloutBlock as CalloutData,
  GalleryBlock as GalleryData,
  GifBlock as GifData,
  ImageBlock as ImageData,
  NoteBlock,
  TextBlock as TextData,
  VideoBlock as VideoData,
} from '../../../data/notes'
import { asset, cx, youtubeId } from '../../../lib/utils'
import { Icon, type IconName } from '../Icon'
import { useLightbox } from './Lightbox'
import { RichText } from './RichText'

export function TextBlock({ block }: { block: TextData }) {
  return (
    <div className="prose">
      <RichText text={block.text} />
    </div>
  )
}

export function ImageBlock({ block }: { block: ImageData }) {
  const { open, dialog } = useLightbox([block])
  return (
    <figure className={cx('note-media', block.wide && 'note-media--wide')}>
      <button type="button" className="note-media__frame" onClick={() => open(0)} aria-label={`Enlarge: ${block.alt}`}>
        <img src={asset(block.src)} alt={block.alt} loading="lazy" decoding="async" />
      </button>
      {block.caption && <figcaption>{block.caption}</figcaption>}
      {dialog}
    </figure>
  )
}

export function GifBlock({ block }: { block: GifData }) {
  const { open, dialog } = useLightbox([block])
  return (
    <figure className="note-media">
      <button type="button" className="note-media__frame" onClick={() => open(0)} aria-label={`Enlarge: ${block.alt}`}>
        <img src={asset(block.src)} alt={block.alt} loading="lazy" decoding="async" />
        <span className="note-media__badge">GIF</span>
      </button>
      {block.caption && <figcaption>{block.caption}</figcaption>}
      {dialog}
    </figure>
  )
}

export function VideoBlock({ block }: { block: VideoData }) {
  const title = block.title ?? block.caption ?? 'Project video'
  return (
    <figure className="note-media">
      <div className="note-media__frame note-media__frame--video">
        {'youtube' in block ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${youtubeId(block.youtube)}`}
            title={title}
            loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        ) : (
          <video controls playsInline preload="metadata" poster={block.poster ? asset(block.poster) : undefined}>
            <source src={asset(block.src)} />
            <a href={asset(block.src)}>Download the video</a>
          </video>
        )}
      </div>
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  )
}

export function GalleryBlock({ block }: { block: GalleryData }) {
  const { open, dialog } = useLightbox(block.images)
  return (
    <figure className="note-gallery">
      <div className={cx('note-gallery__grid', block.images.length === 2 && 'note-gallery__grid--two')}>
        {block.images.map((img, i) => (
          <button key={img.src} type="button" className="note-gallery__item" onClick={() => open(i)} aria-label={`Enlarge: ${img.alt}`}>
            <img src={asset(img.src)} alt={img.alt} loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
      {block.caption && <figcaption>{block.caption}</figcaption>}
      {dialog}
    </figure>
  )
}

const calloutIcon: Record<NonNullable<CalloutData['tone']>, IconName> = {
  note: 'info',
  win: 'sparkle',
  problem: 'alert',
}

export function CalloutBlock({ block }: { block: CalloutData }) {
  const tone = block.tone ?? 'note'
  return (
    <aside className={`callout callout--${tone}`}>
      <span className="callout__icon">
        <Icon name={calloutIcon[tone]} />
      </span>
      <div className="callout__body">
        {block.title && <p className="callout__title">{block.title}</p>}
        <div className="prose">
          <RichText text={block.text} />
        </div>
      </div>
    </aside>
  )
}

/** Renders a note's blocks in order, picking the component for each block type. */
export function NoteBlocks({ blocks }: { blocks: NoteBlock[] }) {
  return (
    <div className="note-blocks">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'text':
            return <TextBlock key={i} block={block} />
          case 'image':
            return <ImageBlock key={i} block={block} />
          case 'gif':
            return <GifBlock key={i} block={block} />
          case 'video':
            return <VideoBlock key={i} block={block} />
          case 'gallery':
            return <GalleryBlock key={i} block={block} />
          case 'callout':
            return <CalloutBlock key={i} block={block} />
        }
      })}
    </div>
  )
}
