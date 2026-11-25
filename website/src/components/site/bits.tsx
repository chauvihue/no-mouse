import { statusInfo, type PartStatus } from '../../data/hardware'
import { getMember, type TeamMember } from '../../data/team'
import { asset, cx } from '../../lib/utils'

export function StatusBadge({ status }: { status: PartStatus }) {
  return (
    <span className={`status status--${status}`}>
      <span className="status__dot" aria-hidden="true" />
      {statusInfo[status].label}
    </span>
  )
}

export function Avatar({ member, size = 'md' }: { member: TeamMember; size?: 'sm' | 'md' | 'lg' }) {
  if (member.photo) {
    return <img className={cx('avatar', `avatar--${size}`)} src={asset(member.photo)} alt="" loading="lazy" />
  }
  return (
    <span className={cx('avatar', `avatar--${size}`, `avatar--${member.tint}`)} aria-hidden="true">
      {member.initials}
    </span>
  )
}

/** Avatar + name for a team id, or just the name for anyone else. */
export function Byline({ authors }: { authors: string[] }) {
  return (
    <span className="byline">
      <span className="byline__avatars">
        {authors.map((a) => {
          const m = getMember(a)
          return m ? <Avatar key={a} member={m} size="sm" /> : null
        })}
      </span>
      <span>{authors.map((a) => getMember(a)?.name ?? a).join(' & ')}</span>
    </span>
  )
}
