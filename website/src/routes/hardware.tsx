import { createFileRoute } from '@tanstack/react-router'
import type { CSSProperties } from 'react'
import { StatusBadge } from '../components/site/bits'
import { Icon } from '../components/site/Icon'
import { PageHeader, SectionHeading } from '../components/site/PageHeader'
import { Reveal } from '../components/site/Reveal'
import { WiringDiagram } from '../components/site/WiringDiagram'
import {
  allParts,
  coreParts,
  countByStatus,
  hardwareUpdated,
  statusInfo,
  statusOrder,
  supportingParts,
} from '../data/hardware'
import { pageTitle } from '../data/site'
import { asset, formatDate } from '../lib/utils'

export const Route = createFileRoute('/hardware')({
  head: () => ({
    meta: [
      { title: pageTitle('Hardware') },
      { name: 'description', content: 'Every hardware component NoMouse needs, its role and its status, plus the wiring diagram.' },
    ],
  }),
  component: HardwarePage,
})

function HardwarePage() {
  const counts = countByStatus()
  const total = allParts.length

  return (
    <>
      <PageHeader
        eyebrow="Hardware"
        title="What’s on the strap"
        lede={`Every part NoMouse needs, what it does, and where it stands. Statuses last checked ${formatDate(hardwareUpdated)}.`}
        motion="none"
      />

      <section className="section section--tight">
        <div className="container">
          <Reveal className="inventory">
            <div className="inventory__count">
              <p className="inventory__big">
                {counts.have}
                <span>/ {total}</span>
              </p>
              <p className="inventory__label">parts in hand</p>
            </div>
            <div className="inventory__main">
              <div className="inventory__bar" role="img" aria-label={`${counts.have} of ${total} parts in hand, ${counts.ordered} ordered, ${counts.unknown} unknown`}>
                {statusOrder.map((s) =>
                  counts[s] ? <span key={s} className={`inventory__seg inventory__seg--${s}`} style={{ '--w': counts[s] / total } as CSSProperties} /> : null,
                )}
              </div>
              <ul className="status-legend" aria-label="Status legend">
                {statusOrder.map((s) => (
                  <li key={s}>
                    <StatusBadge status={s} />
                    <span className="status-legend__count">{counts[s]}</span>
                    <p>{statusInfo[s].description}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section section--tight">
        <div className="container">
          <SectionHeading eyebrow="Main components" title="The six core parts" />
          <div className="parts">
            {coreParts.map((p, i) => (
              <Reveal as="article" key={p.id} index={i} className="part lift">
                <div className="part__top">
                  <span className="part__icon">
                    <Icon name={p.icon} size={26} />
                  </span>
                  <StatusBadge status={p.status} />
                </div>
                <h3>{p.name}</h3>
                <p className="part__spec">
                  {p.kind} · ×{p.qty}
                  {p.price && <> · {p.price}</>}
                </p>
                <p>{p.role}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--tight">
        <div className="container">
          <SectionHeading
            eyebrow="Supporting parts"
            title="The small stuff that holds it together"
            lede="Parts from the wiring diagram and the build itself."
          />
          <Reveal className="table-card">
            <table className="parts-table">
              <caption className="sr-only">Supporting parts, what they are for, and their status</caption>
              <thead>
                <tr>
                  <th scope="col">Part</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Used for</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {supportingParts.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">
                      <span className="parts-table__part">
                        <span className="parts-table__icon">
                          <Icon name={p.icon} size={20} />
                        </span>
                        <span>
                          <strong>{p.name}</strong>
                          <small>{p.kind}</small>
                        </span>
                      </span>
                    </th>
                    <td data-label="Qty">{p.qty}</td>
                    <td data-label="Used for">{p.role}</td>
                    <td data-label="Status">
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionHeading
            eyebrow="Wiring"
            title="How it’s wired"
            lede="The battery feeds the XIAO through the slide switch; the XIAO powers the IMU and reads it over I²C, then talks to the laptop over Bluetooth."
          />
          <Reveal>
            <WiringDiagram />
          </Reveal>
          <Reveal as="figure" className="photo">
            <img
              src={asset('images/prototype-breadboard.jpg')}
              alt="An MPU-6050 breakout wired with jumper wires to the ESP32-S3 on the blue CICS 256 MakerBag board, with a USB-C cable on the table."
              width={1600}
              height={1200}
              loading="lazy"
              decoding="async"
            />
            <figcaption>
              <span className="photo__tag">Prototype</span>
              The first prototype on the bench: the MPU-6050 (left) jumpered to the MakerBag’s ESP32-S3 board.
            </figcaption>
          </Reveal>
        </div>
      </section>
    </>
  )
}
