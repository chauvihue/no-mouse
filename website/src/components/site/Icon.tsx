import type { ReactNode } from 'react'

const dot = (cx: number, cy: number) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r=".9" fill="currentColor" stroke="none" />

const icons = {
  chip: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" />
    </>
  ),
  imu: (
    <>
      <path d="M12 13V3.5M12 13l7.5 4.5M12 13l-7.5 4.5" />
      <path d="M9.6 5.8 12 3.4l2.4 2.4M16.8 19.1l2.9-.8-.8-2.9M5.1 15.4l-.8 2.9 2.9.8" />
      <circle cx="12" cy="13" r="1.4" fill="currentColor" />
    </>
  ),
  switch: (
    <>
      <rect x="2.5" y="7.5" width="19" height="9" rx="4.5" />
      <rect x="12.5" y="9.5" width="7" height="5" rx="2.5" fill="currentColor" />
    </>
  ),
  battery: (
    <>
      <rect x="2.5" y="7" width="17" height="10" rx="2.5" />
      <path d="M22 10.5v3M11.8 9l-2.2 3.2h3.2L10.6 15.5" />
    </>
  ),
  strap: (
    <>
      <path d="M2.5 9.5c3.5-2.2 15.5-2.2 19 0v5c-3.5 2.2-15.5 2.2-19 0z" />
      <rect x="9" y="7.5" width="6" height="9" rx="1.5" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      {[7, 12, 17].flatMap((x) => [8, 12, 16].map((y) => dot(x, y)))}
    </>
  ),
  resistor: <path d="M2 12h4l1.6-3.5 3 7 3-7 3 7L18 12h4" />,
  capacitor: <path d="M2 12h8M14 12h8M10 6v12M14 6v12" />,
  wire: (
    <>
      <path d="M4.5 18c4 0 3.5-12 7.5-12s3.5 12 7.5 12" />
      <circle cx="4" cy="18" r="1.8" fill="currentColor" />
      <circle cx="20" cy="18" r="1.8" fill="currentColor" />
    </>
  ),
  header: (
    <>
      <rect x="2.5" y="13" width="19" height="5.5" rx="1.2" />
      <path d="M6 13V5M10 13V5M14 13V5M18 13V5" />
    </>
  ),
  solder: (
    <>
      <circle cx="9" cy="12" r="6" />
      <circle cx="9" cy="12" r="2" />
      <path d="M15 12c3 0 4.5 2.5 6 6.5" />
    </>
  ),
  cable: (
    <>
      <rect x="8" y="2.5" width="8" height="9" rx="2" />
      <path d="M10.5 5.5h3M12 11.5V15c0 3.5-2.5 5.5-6 6.5" />
    </>
  ),
  devboard: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <rect x="5.5" y="8" width="6.5" height="4.5" rx="1" />
      <rect x="14.5" y="8.5" width="4" height="4" rx=".8" />
      <path d="M5.5 16h13" />
    </>
  ),
  bluetooth: <path d="m6.5 7 11 10-5.5 4.5v-19L17.5 7l-11 10" />,
  cursor: <path d="M5 3.5v15l4.2-3.7 2.9 6.2 2.8-1.2-2.8-6h5.6z" />,
  waves: <path d="M2.5 12h3l2.2-5.5 3.3 11 3.2-9 2.1 3.5h5.2" />,
  hand: (
    <>
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13" />
      <path d="M17 11.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a6.5 6.5 0 0 1-5.4-2.9L4 15.5a1.6 1.6 0 0 1 2.6-1.8L8 15.5" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 4.2 2.6 17.8A2 2 0 0 0 4.3 20.8h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.5" />
      <circle cx="12" cy="17.2" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  sparkle: <path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7zM19 16.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5z" />,
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="16" rx="3" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </>
  ),
  notes: (
    <>
      <path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12.5A1 1 0 0 1 5 19.5V4.5a1 1 0 0 1 1-1z" />
      <path d="M14.5 3.5V8h4.5M8.5 12h7M8.5 16h5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" />
      <path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.9.8 3.1 2.5 3.5 5.2" />
    </>
  ),
  github: (
    <>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.1-1.3-.3-2.5-1-3.5.3-1.2.3-2.4 0-3.5 0 0-1 0-3 1.5-2.6-.5-5.4-.5-8 0C6 2 5 2 5 2c-.3 1.2-.3 2.4 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.4.5-.7 1-.9 1.7-.2.6-.2 1.2-.1 1.8v4" />
      <path d="M9 18c-4.5 2-5-2-7-2" />
    </>
  ),
  linkedin: (
    <>
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof icons

export function Icon({ name, size = 24, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icons[name]}
    </svg>
  )
}
