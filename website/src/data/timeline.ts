export interface Task {
  text: string
  done: boolean
}

export interface Milestone {
  id: string
  /** First and last day of the milestone (YYYY-MM-DD). */
  start: string
  end: string
  label: string
  title: string
  note?: string
  groups: { name?: string; tasks: Task[] }[]
  /** The finish line: drawn larger on the timeline. */
  finale?: boolean
}

export const milestones: Milestone[] = [
  {
    id: 'nov-10',
    start: '2026-11-10',
    end: '2026-11-16',
    label: 'Week of Nov 10',
    title: 'Parts & research',
    groups: [
      {
        tasks: [
          { text: 'Order parts', done: true },
          { text: 'Research the prototype', done: true },
          { text: 'Test out the strap / glove hardware', done: true },
        ],
      },
    ],
  },
  {
    id: 'nov-17',
    start: '2026-11-17',
    end: '2026-11-23',
    label: 'Week of Nov 17',
    title: 'Parts in, first prototype',
    groups: [
      {
        name: 'Hardware',
        tasks: [
          { text: 'All parts received', done: true },
          { text: 'Assemble the prototype: connect components', done: true },
        ],
      },
      {
        name: 'Software',
        tasks: [
          { text: 'Primitive movement gesture', done: false },
          { text: 'Connection with the computer', done: false },
          { text: 'Basic left and right click gestures', done: false },
          { text: 'Collect left and right click gesture data', done: false },
        ],
      },
    ],
  },
  {
    id: 'nov-24',
    start: '2026-11-24',
    end: '2026-11-30',
    label: 'Week of Nov 24',
    title: 'Refine (Thanksgiving week)',
    groups: [
      {
        name: 'Software',
        tasks: [
          { text: 'Refine gestures in a simulated environment', done: false },
          { text: 'Align left and right clicking with the collected data', done: false },
        ],
      },
      {
        name: 'Hardware',
        tasks: [{ text: 'Refine and secure the strap / glove hardware', done: false }],
      },
    ],
  },
  {
    id: 'dec-1',
    start: '2026-12-01',
    end: '2026-12-03',
    label: 'Week of Dec 1',
    title: 'Finalize',
    groups: [
      {
        tasks: [
          { text: 'Finalize all gestures (fall back if needed)', done: false },
          { text: 'Make sure the laptop connection works', done: false },
          { text: 'Finalize the strap / glove', done: false },
        ],
      },
    ],
  },
  {
    id: 'dec-4',
    start: '2026-12-04',
    end: '2026-12-04',
    label: 'Friday, Dec 4',
    title: 'Final presentation & demo',
    finale: true,
    groups: [{ tasks: [{ text: 'Present NoMouse and demo it live', done: false }] }],
  },
]

export type MilestoneState = 'done' | 'now' | 'progress' | 'upcoming'

export const milestoneStateLabel: Record<MilestoneState, string> = {
  done: 'Done',
  now: 'This week',
  progress: 'In progress',
  upcoming: 'Upcoming',
}

/** Local date as YYYY-MM-DD. */
export function todayISO(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function milestoneState(m: Milestone, today = todayISO()): MilestoneState {
  const tasks = m.groups.flatMap((g) => g.tasks)
  const done = tasks.filter((t) => t.done).length
  if (tasks.length > 0 && done === tasks.length) return 'done'
  if (today >= m.start && today <= m.end) return 'now'
  if (done > 0) return 'progress'
  return 'upcoming'
}

export function currentMilestone(today = todayISO()) {
  return (
    milestones.find((m) => today >= m.start && today <= m.end) ??
    milestones.find((m) => today < m.start) ??
    milestones[milestones.length - 1]
  )
}
