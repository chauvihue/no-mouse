import type { IconName } from '../components/site/Icon'

export type PartStatus = 'have' | 'ordered' | 'unknown'

export const statusInfo: Record<PartStatus, { label: string; description: string }> = {
  have: {
    label: 'Already have',
    description: 'In hand: from the MakerBag, the lab, or already delivered.',
  },
  ordered: {
    label: 'Ordered',
    description: 'Ordered and waiting for it to arrive.',
  },
  unknown: {
    label: 'Don’t know yet',
    description: 'Not sure yet whether or where we will get it.',
  },
}

export const statusOrder: PartStatus[] = ['have', 'ordered', 'unknown']

export interface Part {
  id: string
  name: string
  qty: string
  kind: string
  role: string
  status: PartStatus
  icon: IconName
  /** Approximate price from the proposal, if we bought it. */
  price?: string
}

/** Date the statuses below were last checked (YYYY-MM-DD). */
export const hardwareUpdated = '2026-11-24'

export const coreParts: Part[] = [
  {
    id: 'xiao',
    name: 'Seeed XIAO ESP32-S3',
    qty: '1',
    kind: 'Microcontroller',
    role: 'The brain of the strap. Reads the IMU, runs the gesture code and connects to your computer as a Bluetooth LE mouse. Its built-in charger tops up the battery over USB-C.',
    status: 'have',
    icon: 'chip',
    price: '≈ $11',
  },
  {
    id: 'imu',
    name: 'MPU-6050 6-axis IMU',
    qty: '1',
    kind: 'Motion sensor',
    role: 'Accelerometer and gyroscope that feel every slide and finger tap. Talks to the ESP32 over I²C (SDA/SCL), plus an interrupt pin.',
    status: 'have',
    icon: 'imu',
  },
  {
    id: 'switch',
    name: 'Slide switch',
    qty: '1',
    kind: 'Power',
    role: 'Connects the battery to the board. Off for storage; on to use the strap and to charge it.',
    status: 'have',
    icon: 'switch',
    price: '≈ $6',
  },
  {
    id: 'lipo',
    name: 'LiPo battery, 3.7 V 330 mAh',
    qty: '1',
    kind: 'Power',
    role: 'Small protected cell that makes the strap wireless. Recharges through the XIAO’s USB-C port.',
    status: 'have',
    icon: 'battery',
    price: '≈ $7',
  },
  {
    id: 'strap',
    name: 'Elastic strap',
    qty: '1',
    kind: 'Wearable',
    role: 'Holds the electronics snugly on the back of the hand so the IMU moves exactly with it.',
    status: 'have',
    icon: 'strap',
    price: '≈ $5',
  },
  {
    id: 'plate',
    name: 'Mounting plate / PCB',
    qty: '1',
    kind: 'Structure',
    role: 'Through-hole board the parts are soldered onto before everything goes on the strap.',
    status: 'have',
    icon: 'board',
    price: '≈ $6',
  },
]

export const supportingParts: Part[] = [
  {
    id: 'res',
    name: '100 kΩ resistor',
    qty: '2',
    kind: 'Battery monitor',
    role: 'Voltage divider that halves the battery voltage for the ADC pin (D0).',
    status: 'have',
    icon: 'resistor',
  },
  {
    id: 'cap',
    name: '0.1 µF capacitor',
    qty: '1',
    kind: 'Battery monitor',
    role: 'Sits from the divider to ground to steady the battery reading.',
    status: 'have',
    icon: 'capacitor',
  },
  {
    id: 'jumpers',
    name: 'Jumper wires',
    qty: 'Assorted',
    kind: 'Prototyping',
    role: 'Breadboard wiring while we test before soldering.',
    status: 'have',
    icon: 'wire',
  },
  {
    id: 'headers',
    name: 'Pin headers',
    qty: '1 set',
    kind: 'Assembly',
    role: 'Connect the IMU and the XIAO to the mounting plate.',
    status: 'have',
    icon: 'header',
  },
  {
    id: 'solder',
    name: 'Solder',
    qty: '—',
    kind: 'Assembly',
    role: 'For the through-hole build on the mounting plate.',
    status: 'have',
    icon: 'solder',
  },
  {
    id: 'usbc',
    name: 'USB-C cable',
    qty: '1',
    kind: 'Power & data',
    role: 'Charges the battery and flashes new firmware.',
    status: 'have',
    icon: 'cable',
  },
  {
    id: 'makerbag',
    name: 'CICS 256 MakerBag board (ESP32-S3)',
    qty: '1',
    kind: 'Prototyping',
    role: 'The course dev board. We prototype on it before moving to the XIAO.',
    status: 'have',
    icon: 'devboard',
  },
]

export const allParts = [...coreParts, ...supportingParts]

export function countByStatus(parts: Part[] = allParts) {
  const counts: Record<PartStatus, number> = { have: 0, ordered: 0, unknown: 0 }
  for (const p of parts) counts[p.status] += 1
  return counts
}
