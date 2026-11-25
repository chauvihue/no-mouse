export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="10" className="logo-mark__bg" />
      <circle cx="19" cy="19" r="8" className="logo-mark__glow" />
      <path d="M11 7.5v14.2l3.6-3.1 2.4 5.6 2.5-1-2.4-5.5h4.7z" className="logo-mark__cursor" />
    </svg>
  )
}
