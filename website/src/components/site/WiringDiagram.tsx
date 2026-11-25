import type { CSSProperties } from 'react'
import { useInView } from '../../hooks/useInView'
import { cx } from '../../lib/utils'

type Wire = 'power' | 'ground' | 'signal' | 'radio'

interface Block {
  id: string
  x: number
  y: number
  w: number
  h: number
  title: string
  sub?: string
  tone: 'host' | 'mcu' | 'sensor' | 'power'
  /** Title near the top (tall boxes) instead of centered. */
  top?: boolean
}

const blocks: Block[] = [
  { id: 'usb', x: 360, y: 24, w: 190, h: 68, title: 'USB-C port', sub: 'Charges at ~50 mA', tone: 'host' },
  { id: 'laptop', x: 740, y: 24, w: 196, h: 68, title: 'Laptop', sub: 'BLE HID mouse', tone: 'host' },
  { id: 'esp', x: 330, y: 150, w: 250, h: 330, title: 'XIAO ESP32-S3', sub: 'Charger · 3.3 V · BLE', tone: 'mcu', top: true },
  { id: 'imu', x: 740, y: 150, w: 196, h: 330, title: 'MPU-6050 IMU', sub: '6-axis', tone: 'sensor', top: true },
  { id: 'mon', x: 24, y: 196, w: 220, h: 80, title: 'Battery monitor', sub: '2 × 100 kΩ, 0.1 µF to GND', tone: 'power' },
  { id: 'sw', x: 24, y: 350, w: 220, h: 80, title: 'Slide switch', sub: 'On to charge', tone: 'power' },
  { id: 'lipo', x: 24, y: 500, w: 220, h: 80, title: 'LiPo battery', sub: 'Protected · 3.7 V 330 mAh', tone: 'power' },
]

const wires: { d: string; kind: Wire }[] = [
  { d: 'M455 92V150', kind: 'power' },
  { d: 'M566 150V58H740', kind: 'radio' },
  { d: 'M244 236H330', kind: 'signal' },
  { d: 'M134 276V312H290V390', kind: 'power' },
  { d: 'M244 390H330', kind: 'power' },
  { d: 'M134 500V430', kind: 'power' },
  { d: 'M244 540H300V432H330', kind: 'ground' },
  { d: 'M580 236H740', kind: 'power' },
  { d: 'M580 284H740', kind: 'ground' },
  { d: 'M580 332H740', kind: 'signal' },
  { d: 'M580 380H740', kind: 'signal' },
  { d: 'M580 428H740', kind: 'signal' },
]

const espLeft = [
  { y: 236, label: 'D0 / ADC' },
  { y: 390, label: 'BAT+' },
  { y: 432, label: 'BAT−' },
]
const espRight = [
  { y: 236, label: '3V3' },
  { y: 284, label: 'GND' },
  { y: 332, label: 'D4 / SDA' },
  { y: 380, label: 'D5 / SCL' },
  { y: 428, label: 'D1 / INT' },
]
const imuLeft = [
  { y: 236, label: 'VCC' },
  { y: 284, label: 'GND' },
  { y: 332, label: 'SDA' },
  { y: 380, label: 'SCL' },
  { y: 428, label: 'INT' },
]

export const wiringLegend: { kind: Wire; label: string }[] = [
  { kind: 'power', label: 'Power' },
  { kind: 'ground', label: 'Ground' },
  { kind: 'signal', label: 'Signal' },
  { kind: 'radio', label: 'Bluetooth' },
]

export function WiringDiagram() {
  const [ref, inView] = useInView<HTMLDivElement>()
  return (
    <figure className="diagram">
      <p className="diagram__hint" aria-hidden="true">
        Swipe to see the whole diagram →
      </p>
      <div ref={ref} className={cx('diagram__scroll', inView && 'is-in')}>
        <svg className="diagram__svg diagram__svg--wiring" viewBox="0 0 960 604" role="img" aria-labelledby="wiring-title wiring-desc">
          <title id="wiring-title">NoMouse wiring diagram</title>
          <desc id="wiring-desc">
            The LiPo battery goes through the slide switch to BAT+ on the XIAO ESP32-S3; its negative lead goes to BAT−.
            A battery monitor (two 100 kΩ resistors and a 0.1 µF capacitor to ground) feeds the battery voltage into pin
            D0, the ADC. USB-C charges the battery through the XIAO at about 50 mA. The XIAO powers the MPU-6050 from 3V3
            and GND, and talks to it over D4 (SDA), D5 (SCL) and D1 (INT). The XIAO connects to the laptop over Bluetooth
            as a BLE HID mouse.
          </desc>

          {wires.map((w, i) => (
            <path key={i} d={w.d} className={`wire wire--${w.kind}`} />
          ))}
          <circle className="wire-junction" cx="290" cy="390" r="5" />

          {blocks.map((b, i) => (
            <g key={b.id} className={`node node--${b.tone}`} style={{ '--i': i } as CSSProperties}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="16" />
              <text className="node__title" x={b.x + b.w / 2} y={b.top ? b.y + 40 : b.y + b.h / 2 - 3} textAnchor="middle">
                {b.title}
              </text>
              {b.sub && (
                <text className="node__sub" x={b.x + b.w / 2} y={b.top ? b.y + 62 : b.y + b.h / 2 + 18} textAnchor="middle">
                  {b.sub}
                </text>
              )}
            </g>
          ))}

          <g className="pins">
            {espLeft.map((p) => (
              <g key={`el-${p.y}`}>
                <circle className="pin" cx="330" cy={p.y} r="4.5" />
                <text className="pin__label" x="344" y={p.y + 5}>
                  {p.label}
                </text>
              </g>
            ))}
            {espRight.map((p) => (
              <g key={`er-${p.y}`}>
                <circle className="pin" cx="580" cy={p.y} r="4.5" />
                <text className="pin__label" x="566" y={p.y + 5} textAnchor="end">
                  {p.label}
                </text>
              </g>
            ))}
            {imuLeft.map((p) => (
              <g key={`il-${p.y}`}>
                <circle className="pin" cx="740" cy={p.y} r="4.5" />
                <text className="pin__label" x="754" y={p.y + 5}>
                  {p.label}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>
      <figcaption className="diagram__legend">
        {wiringLegend.map((l) => (
          <span key={l.kind} className="legend-item">
            <span className={`legend-wire legend-wire--${l.kind}`} aria-hidden="true" />
            {l.label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
