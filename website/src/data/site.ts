export const site = {
  name: 'NoMouse',
  tagline: 'Your hand is the mouse.',
  pitch:
    'A wireless strap that reads your hand’s motion and finger taps, then moves your cursor over Bluetooth. No mouse to carry, no flat surface required.',
  /** The project description paragraph, exactly as the team wrote it. */
  description:
    'NoMouse is a wireless strap that captures your hand gestures and translates them to cursor movements, just like a mouse! NoMouse is a convenient mouse alternative that allows users to use their devices on the go without the need of carrying a mouse around and needing a flat, smooth surface to use the mouse on. It’s a plastic strap that attaches onboard an ESP32 microcontroller and an MPU6050 6-axis IMU that all runs on a 3.7V LiPo battery. NoMouse works by reading and processing the IMU sensor’s data to recognize hand gestures for panning, left and right clicks on its onboard microcontroller, then turns those gestures into real-time cursor movement and click actions to your devices over Bluetooth.',
  metaDescription:
    'NoMouse is a wireless hand strap that turns hand gestures into cursor movement and clicks over Bluetooth. A CICS 256 project by Devansh Mamoria, Ashutosh Mishra and Hue Chau.',
  course: {
    code: 'CICS 256',
    title: 'Make: A Hands-on Introduction to Physical Computing',
    school: 'UMass Amherst',
    term: 'Fall 2026',
  },
  facts: [
    { label: 'Brain', value: 'XIAO ESP32-S3' },
    { label: 'Sensor', value: 'MPU-6050 6-axis IMU' },
    { label: 'Power', value: '3.7 V LiPo, 330 mAh' },
    { label: 'Link', value: 'Bluetooth LE mouse' },
  ],
} as const

export function pageTitle(title?: string) {
  return title ? `${title} · NoMouse` : 'NoMouse · Your hand is the mouse'
}
