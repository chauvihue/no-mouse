import type { CSSProperties } from 'react'
import { useInView } from '../../hooks/useInView'
import { cx } from '../../lib/utils'

type Tone = 'hw' | 'shared' | 'cursor' | 'click'

interface Box {
  id: string
  x: number
  y: number
  h?: number
  title: string
  sub: string
  tone: Tone
}

const W = 200
const H = 64
const col = [20, 270, 520, 770]

const boxes: Box[] = [
  { id: 'hand', x: col[0], y: 24, title: 'Hand', sub: 'Slide or tap', tone: 'hw' },
  { id: 'imu', x: col[1], y: 24, title: 'IMU', sub: 'Accel + gyro', tone: 'hw' },
  { id: 'cal', x: col[2], y: 24, title: 'Calibrate', sub: 'Gyro bias at boot', tone: 'shared' },
  { id: 'fusion', x: col[3], y: 24, title: 'Sensor fusion', sub: 'Wrist tilt', tone: 'shared' },
  { id: 'gravity', x: col[3], y: 134, title: 'Remove gravity', sub: 'Real hand motion', tone: 'shared' },
  { id: 'still', x: col[3], y: 254, title: 'Still?', sub: 'Reset velocity', tone: 'cursor' },
  { id: 'integrate', x: col[2], y: 254, title: 'Integrate', sub: 'Accel → velocity', tone: 'cursor' },
  { id: 'speed', x: col[1], y: 254, title: 'Speed curve', sub: 'Velocity → dx, dy', tone: 'cursor' },
  { id: 'tap', x: col[3], y: 374, title: 'Tap spike?', sub: 'Freeze + capture', tone: 'click' },
  { id: 'classify', x: col[2], y: 374, title: 'Classify tap', sub: 'Index vs pinky', tone: 'click' },
  { id: 'click', x: col[1], y: 374, title: 'Click', sub: 'Index L · pinky R', tone: 'click' },
  { id: 'bt', x: col[0], y: 254, h: 184, title: 'Bluetooth', sub: 'to laptop', tone: 'hw' },
]

const arrows: { d: string; tone: 'shared' | 'cursor' | 'click' }[] = [
  { d: 'M220 56H264', tone: 'shared' },
  { d: 'M470 56H514', tone: 'shared' },
  { d: 'M720 56H764', tone: 'shared' },
  { d: 'M870 88V128', tone: 'shared' },
  { d: 'M870 198V248', tone: 'cursor' },
  { d: 'M970 166H988V406H976', tone: 'click' },
  { d: 'M770 286H726', tone: 'cursor' },
  { d: 'M520 286H476', tone: 'cursor' },
  { d: 'M270 286H226', tone: 'cursor' },
  { d: 'M770 406H726', tone: 'click' },
  { d: 'M520 406H476', tone: 'click' },
  { d: 'M270 406H226', tone: 'click' },
]

export const pipelineLegend: { tone: Tone; label: string }[] = [
  { tone: 'hw', label: 'Hardware' },
  { tone: 'shared', label: 'Shared processing' },
  { tone: 'cursor', label: 'Cursor path' },
  { tone: 'click', label: 'Click path' },
]

export function PipelineDiagram() {
  const [ref, inView] = useInView<HTMLDivElement>()
  return (
    <figure className="diagram">
      <p className="diagram__hint" aria-hidden="true">
        Swipe to see the whole diagram →
      </p>
      <div ref={ref} className={cx('diagram__scroll', inView && 'is-in')}>
        <svg className="diagram__svg diagram__svg--pipeline" viewBox="0 0 1000 462" role="img" aria-labelledby="pipeline-title pipeline-desc">
          <title id="pipeline-title">NoMouse software pipeline</title>
          <desc id="pipeline-desc">
            The hand moves or taps. The IMU measures acceleration and rotation. The ESP32 calibrates gyro bias at boot,
            fuses the sensors to know the wrist tilt, and removes gravity to get real hand motion. The cursor path checks
            whether the hand is still to reset velocity, integrates acceleration into velocity, and applies a speed curve
            to get dx and dy. The click path watches for a tap spike, freezes the cursor and captures the tap, classifies
            it as index or pinky, and sends a left or right click. Both paths go to the laptop over Bluetooth.
          </desc>
          <defs>
            {(['shared', 'cursor', 'click'] as const).map((tone) => (
              <marker
                key={tone}
                id={`arrow-${tone}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M1 1.5 8.5 5 1 8.5z" className={`marker marker--${tone}`} />
              </marker>
            ))}
          </defs>

          {arrows.map((a, i) => (
            <path key={i} d={a.d} className={`flow flow--${a.tone}`} markerEnd={`url(#arrow-${a.tone})`} />
          ))}

          {boxes.map((b, i) => {
            const h = b.h ?? H
            return (
              <g key={b.id} className={`node node--${b.tone}`} style={{ '--i': i } as CSSProperties}>
                <rect x={b.x} y={b.y} width={W} height={h} rx="16" />
                <text className="node__title" x={b.x + W / 2} y={b.y + h / 2 - 3} textAnchor="middle">
                  {b.title}
                </text>
                <text className="node__sub" x={b.x + W / 2} y={b.y + h / 2 + 17} textAnchor="middle">
                  {b.sub}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <figcaption className="diagram__legend">
        {pipelineLegend.map((l) => (
          <span key={l.tone} className="legend-item">
            <span className={`legend-swatch legend-swatch--${l.tone}`} aria-hidden="true" />
            {l.label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
