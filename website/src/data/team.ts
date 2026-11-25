export type TeamId = 'devansh' | 'ashutosh' | 'hue'

export interface TeamMember {
  id: TeamId
  name: string
  /** What teammates call each other; used in compact places. */
  short: string
  initials: string
  role: string
  responsibilities: string[]
  tint: 'cyan' | 'amber' | 'signal'
  /** Path inside public/, e.g. 'team/hue.jpg'. Leave out to show initials. */
  photo?: string
  /** Only links that are filled in are shown. */
  links?: { linkedin?: string; github?: string; website?: string; email?: string }
}

export const team: TeamMember[] = [
  {
    id: 'devansh',
    name: 'Devansh Mamoria',
    short: 'Dev',
    initials: 'DM',
    role: 'Hardware & data collection',
    responsibilities: [
      'Wiring, assembly and the strap build',
      'Collecting the gesture data the team tunes against',
    ],
    tint: 'cyan',
    // photo: 'team/devansh.jpg',
    // links: { linkedin: 'https://www.linkedin.com/in/…', github: 'https://github.com/…' },
  },
  {
    id: 'ashutosh',
    name: 'Ashutosh Mishra',
    short: 'Ash',
    initials: 'AM',
    role: 'Movement gesture',
    responsibilities: [
      'Turning hand motion into smooth cursor movement',
      'Aligning movement with the left and right click gestures',
    ],
    tint: 'amber',
    // photo: 'team/ashutosh.jpg',
    // links: { linkedin: 'https://www.linkedin.com/in/…', github: 'https://github.com/…' },
  },
  {
    id: 'hue',
    name: 'Hue Chau',
    short: 'Hue',
    initials: 'HC',
    role: 'Click gestures & website',
    responsibilities: [
      'Detecting index taps (left click) and pinky taps (right click)',
      'This project site',
    ],
    tint: 'signal',
    // photo: 'team/hue.jpg',
    // links: { linkedin: 'https://www.linkedin.com/in/…', github: 'https://github.com/…' },
  },
]

/** Who does what, from the project proposal. */
export const duties: { task: string; owners: TeamId[] }[] = [
  { task: 'Hardware & strap build', owners: ['devansh'] },
  { task: 'Gesture data collection', owners: ['devansh'] },
  { task: 'Cursor movement gesture', owners: ['ashutosh'] },
  { task: 'Aligning movement with clicks', owners: ['ashutosh'] },
  { task: 'Left / right click gestures', owners: ['hue'] },
  { task: 'Project website', owners: ['hue'] },
]

export function getMember(id: string) {
  return team.find((m) => m.id === id)
}
