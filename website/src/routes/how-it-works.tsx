import { createFileRoute } from '@tanstack/react-router'
import { GestureScene, type GestureKind } from '../components/site/GestureScene'
import { Icon, type IconName } from '../components/site/Icon'
import { PageHeader, SectionHeading } from '../components/site/PageHeader'
import { PipelineDiagram } from '../components/site/PipelineDiagram'
import { Reveal } from '../components/site/Reveal'
import { pageTitle } from '../data/site'

export const Route = createFileRoute('/how-it-works')({
  head: () => ({
    meta: [
      { title: pageTitle('How it works') },
      { name: 'description', content: 'How NoMouse turns hand motion and finger taps into cursor movement and clicks over Bluetooth.' },
    ],
  }),
  component: HowItWorksPage,
})

const steps: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'hand',
    title: 'Move your hand',
    text: 'Wear the strap on the back of your hand and move it the way you’d move a mouse. No flat, smooth surface needed.',
  },
  {
    icon: 'imu',
    title: 'The strap reads the motion',
    text: 'The MPU-6050 measures acceleration and rotation. The ESP32 cleans up the signal, removes gravity and watches for finger taps.',
  },
  {
    icon: 'bluetooth',
    title: 'The cursor moves over Bluetooth',
    text: 'The ESP32 shows up as a Bluetooth LE mouse, so your laptop just sees an ordinary mouse moving and clicking.',
  },
]

const gestures: { kind: GestureKind; title: string; text: string; action: string }[] = [
  {
    kind: 'pan',
    title: 'Move to pan',
    text: 'Your hand is the cursor. Move it and the pointer follows; a speed curve keeps small moves precise and big sweeps quick.',
    action: 'Cursor moves',
  },
  {
    kind: 'left',
    title: 'Index tap',
    text: 'Tap your index finger down. The strap catches the sharp spike, holds the cursor still and sends a left click.',
    action: 'Left click',
  },
  {
    kind: 'right',
    title: 'Pinky tap',
    text: 'Tap your pinky instead. The tap classifier tells it apart from an index tap and sends a right click.',
    action: 'Right click',
  },
]

const stages = [
  {
    tone: 'shared',
    title: 'Shared clean-up',
    text: 'At boot the strap measures the gyro’s resting bias. Sensor fusion tracks how the wrist is tilted so gravity can be subtracted, leaving only real hand motion.',
  },
  {
    tone: 'cursor',
    title: 'Cursor path',
    text: 'When the hand is still, velocity snaps back to zero so drift can’t build up. Otherwise acceleration is integrated into velocity, and a speed curve turns it into dx, dy.',
  },
  {
    tone: 'click',
    title: 'Click path',
    text: 'A sharp spike means a tap. The cursor freezes so the tap doesn’t nudge it, the tap is classified as index or pinky, and a left or right click goes out.',
  },
]

function HowItWorksPage() {
  return (
    <>
      <PageHeader
        eyebrow="How it works"
        title="From a flick of the wrist to a click"
        lede="Wear the strap, move your hand, tap a finger. Here’s what happens in between."
        motion="both"
      />

      <section className="section section--tight">
        <div className="container">
          <SectionHeading eyebrow="Three steps" title="Hand, strap, cursor" />
          <ol className="steps">
            {steps.map((s, i) => (
              <Reveal as="li" key={s.title} index={i} variant="slide" className="step lift">
                <div className="step__art">
                  <span className="step__num">{i + 1}</span>
                  <span className="step__icon">
                    <Icon name={s.icon} size={34} />
                  </span>
                </div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionHeading
            eyebrow="Gestures"
            title="Three moves to learn"
            lede="Move to pan, as if your hand is the cursor. Tap with your index finger to left click, with your pinky to right click."
          />
          <div className="gestures">
            {gestures.map((g, i) => (
              <Reveal as="article" key={g.kind} index={i} className="gesture lift">
                <GestureScene kind={g.kind} />
                <div className="gesture__body">
                  <h3>{g.title}</h3>
                  <p>{g.text}</p>
                  <span className={`maps-to maps-to--${g.kind}`}>
                    <Icon name="arrowRight" size={16} /> {g.action}
                  </span>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionHeading
            eyebrow="Inside the strap"
            title="The signal pipeline"
            lede="After a shared clean-up, every sample takes two paths: one turns motion into cursor movement, the other turns sharp spikes into clicks."
          />
          <Reveal>
            <PipelineDiagram />
          </Reveal>
          <div className="stages">
            {stages.map((s, i) => (
              <Reveal key={s.title} index={i} className={`stage stage--${s.tone}`}>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </Reveal>
            ))}
          </div>
          <Reveal as="aside" className="callout callout--problem risk">
            <span className="callout__icon">
              <Icon name="alert" />
            </span>
            <div className="callout__body">
              <p className="callout__title">The risk we’re watching</p>
              <p>
                Gesture → cursor might not be precise, or might fail outright: integrating acceleration drifts quickly.
                That’s why the cursor path resets velocity whenever the hand is still and the click path freezes the
                cursor during a tap. If a gesture can’t be made reliable in time, we’ll fall back to a simpler one.
              </p>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  )
}
