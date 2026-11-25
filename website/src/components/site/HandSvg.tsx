import { cx } from '../../lib/utils'

/**
 * Which fingers tap. 'hero' follows the 9 s home-page loop, synced with the
 * cursor in HeroScene (index tap → left click, pinky tap → right click).
 */
export type HandMotion = 'none' | 'index' | 'pinky' | 'both' | 'hero'

/** Back of a right hand, fingers up, wearing the NoMouse strap. Same shapes are drawn twice: a thick ink pass for the outline, then the skin fill on top. */
function Silhouette() {
  return (
    <>
      <rect x="80" y="196" width="84" height="80" rx="30" />
      <rect x="58" y="126" width="128" height="120" rx="46" />
      <rect x="30" y="138" width="28" height="92" rx="14" transform="rotate(-27 44 184)" />
      <rect className="finger--index" x="62" y="56" width="28" height="104" rx="14" />
      <rect className="finger--middle" x="93" y="38" width="29" height="118" rx="14.5" />
      <rect className="finger--ring" x="125" y="48" width="28" height="110" rx="14" />
      <rect className="finger--pinky" x="156" y="76" width="25" height="84" rx="12.5" />
    </>
  )
}

export function HandSvg({ motion = 'none', className }: { motion?: HandMotion; className?: string }) {
  return (
    <svg className={cx('hand', `hand--${motion}`, className)} viewBox="0 26 240 270" aria-hidden="true" focusable="false">
      <g className="hand__outline">
        <Silhouette />
      </g>
      <g className="hand__skin">
        <Silhouette />
      </g>

      <g className="hand__details">
        <g className="finger--index">
          <rect className="hand__nail" x="68" y="62" width="16" height="18" rx="8" />
          <path className="hand__crease" d="M69 104q7 4 14 0" />
        </g>
        <g className="finger--middle">
          <rect className="hand__nail" x="99.5" y="44" width="16" height="19" rx="8" />
          <path className="hand__crease" d="M100 94q7.5 4 15 0" />
        </g>
        <g className="finger--ring">
          <rect className="hand__nail" x="131" y="54" width="16" height="18" rx="8" />
          <path className="hand__crease" d="M132 100q7 4 14 0" />
        </g>
        <g className="finger--pinky">
          <rect className="hand__nail" x="161" y="82" width="15" height="16" rx="7.5" />
          <path className="hand__crease" d="M162 118q6.5 3.5 13 0" />
        </g>
      </g>

      <g className="hand__sleeve">
        <rect x="68" y="252" width="108" height="40" rx="16" />
        <path d="M76 265h92" />
      </g>

      <g className="strap">
        <rect className="strap__band" x="50" y="166" width="144" height="46" rx="12" />
        <path className="strap__stitch" d="M58 172H186M58 206H186" />
        <rect className="strap__lipo" x="60" y="173" width="32" height="32" rx="5" />
        <path className="strap__lipo-mark" d="M70 189h12M76 183v12" />
        <rect className="strap__xiao" x="100" y="158" width="46" height="58" rx="6" />
        <rect className="strap__shield" x="107" y="170" width="32" height="27" rx="3" />
        <rect className="strap__usb" x="114" y="152" width="18" height="9" rx="4" />
        <circle className="strap__led-glow" cx="137" cy="207" r="8" />
        <circle className="strap__led" cx="137" cy="207" r="3.2" />
        <circle className="strap__led strap__led--right" cx="137" cy="207" r="3.2" />
        <rect className="strap__imu" x="152" y="174" width="30" height="30" rx="4" />
        <rect className="strap__imu-chip" x="161" y="183" width="12" height="12" rx="1.5" />
      </g>
    </svg>
  )
}
