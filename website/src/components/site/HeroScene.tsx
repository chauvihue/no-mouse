import { HandSvg } from './HandSvg'

/**
 * Home-page animation, one 9 s loop (timings live in styles.css under "Hero scene"):
 * the hand drifts, the glowing cursor follows, an index tap left-clicks the
 * button and a pinky tap right-clicks to open a menu.
 * Cursor stops: A (90,80) → B (287,105) left click → C (165,165) right click → A.
 */
export function HeroScene() {
  return (
    <div
      className="hero-scene"
      role="img"
      aria-label="Animation: a hand wearing the NoMouse strap moves and taps. The cursor on a screen follows it, left-clicks a button on an index-finger tap and opens a menu on a pinky tap."
    >
      <svg className="hero-screen" viewBox="0 0 400 260" aria-hidden="true">
        <defs>
          <pattern id="hero-dots" width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.1" className="screen__dot" />
          </pattern>
          <filter id="hero-blur" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        <rect className="screen__frame" x="2" y="2" width="396" height="256" rx="22" />
        <rect x="12" y="38" width="376" height="210" rx="14" fill="url(#hero-dots)" />
        <circle className="screen__light" cx="24" cy="21" r="4.5" />
        <circle className="screen__light" cx="38" cy="21" r="4.5" />
        <circle className="screen__light screen__light--on" cx="52" cy="21" r="4.5" />
        <rect className="screen__ui" x="150" y="16" width="100" height="10" rx="5" />

        <rect className="screen__ui" x="34" y="52" width="150" height="14" rx="7" />
        <rect className="screen__ui screen__ui--soft" x="34" y="74" width="110" height="10" rx="5" />
        <rect className="screen__ui screen__ui--soft" x="34" y="90" width="130" height="10" rx="5" />

        <g className="screen__btn">
          <rect x="243" y="89" width="88" height="32" rx="16" />
          <text x="287" y="110" textAnchor="middle">
            Open
          </text>
        </g>

        <rect className="screen__card" x="108" y="140" width="150" height="62" rx="12" />
        <rect className="screen__ui" x="122" y="154" width="60" height="8" rx="4" />
        <rect className="screen__ui screen__ui--soft" x="122" y="170" width="112" height="6" rx="3" />
        <rect className="screen__ui screen__ui--soft" x="122" y="182" width="84" height="6" rx="3" />

        <path className="screen__trail" d="M90 80 L287 105 L165 165 Z" />

        <circle className="ripple ripple--hero-left" cx="287" cy="105" r="12" />
        <circle className="ripple ripple--hero-left ripple--late" cx="287" cy="105" r="12" />
        <circle className="ripple ripple--hero-right" cx="165" cy="165" r="12" />
        <circle className="ripple ripple--hero-right ripple--late" cx="165" cy="165" r="12" />

        <g transform="translate(173 172)">
          <g className="ctx-menu ctx-menu--hero">
            <rect className="ctx-menu__panel" width="104" height="70" rx="10" />
            <rect className="ctx-menu__hi" x="6" y="7" width="92" height="18" rx="6" />
            <rect className="ctx-menu__line ctx-menu__line--on" x="14" y="13" width="50" height="6" rx="3" />
            <rect className="ctx-menu__line" x="14" y="35" width="62" height="6" rx="3" />
            <rect className="ctx-menu__line" x="14" y="52" width="40" height="6" rx="3" />
          </g>
        </g>

        <g transform="translate(300 128)">
          <g className="click-chip click-chip--left">
            <rect width="84" height="24" rx="12" />
            <text x="42" y="16" textAnchor="middle">
              Left click
            </text>
          </g>
        </g>
        <g transform="translate(44 150)">
          <g className="click-chip click-chip--right">
            <rect width="92" height="24" rx="12" />
            <text x="46" y="16" textAnchor="middle">
              Right click
            </text>
          </g>
        </g>

        <g className="hero-cursor">
          <g className="hero-cursor__squish">
            <circle className="cursor-halo" cx="5" cy="9" r="15" filter="url(#hero-blur)" />
            <path className="cursor-arrow" d="M0 0V22l5.8-5.1 3.8 8.9 4-1.7-3.8-8.7h7.6z" />
          </g>
        </g>
      </svg>

      <div className="hero-hand" aria-hidden="true">
        <div className="hero-hand__shadow" />
        <div className="tilt tilt--hero">
          <div className="hero-hand__move">
            <div className="float">
              <HandSvg motion="hero" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
