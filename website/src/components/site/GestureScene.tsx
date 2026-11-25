import { HandSvg } from './HandSvg'

export type GestureKind = 'pan' | 'left' | 'right'

/** Small looping demo for a gesture card: the hand on the left, what the cursor does on the right. */
export function GestureScene({ kind }: { kind: GestureKind }) {
  const motion = kind === 'left' ? 'index' : kind === 'right' ? 'pinky' : 'none'
  return (
    <div className={`gesture-scene gesture-scene--${kind}`} aria-hidden="true">
      <div className="gesture-scene__hand">
        <div className="gesture-scene__move">
          <HandSvg motion={motion} />
        </div>
      </div>
      <svg className="gesture-scene__screen" viewBox="0 0 160 112">
        <rect className="screen__frame" x="2" y="2" width="156" height="108" rx="14" />
        <circle className="screen__light" cx="14" cy="13" r="3" />
        <circle className="screen__light" cx="24" cy="13" r="3" />
        <circle className="screen__light screen__light--on" cx="34" cy="13" r="3" />

        {kind === 'pan' && <rect className="screen__trail" x="36" y="40" width="84" height="38" rx="10" />}

        {kind === 'left' && (
          <>
            <g className="screen__btn screen__btn--mini">
              <rect x="46" y="44" width="68" height="28" rx="14" />
              <text x="80" y="62.5" textAnchor="middle">
                Open
              </text>
            </g>
            <circle className="ripple ripple--mini-left" cx="84" cy="60" r="8" />
          </>
        )}

        {kind === 'right' && (
          <>
            <rect className="screen__card" x="22" y="30" width="78" height="44" rx="9" />
            <rect className="screen__ui" x="32" y="40" width="36" height="6" rx="3" />
            <rect className="screen__ui screen__ui--soft" x="32" y="52" width="52" height="5" rx="2.5" />
            <circle className="ripple ripple--mini-right" cx="70" cy="56" r="8" />
            <g transform="translate(76 60)">
              <g className="ctx-menu ctx-menu--mini">
                <rect className="ctx-menu__panel" width="66" height="44" rx="8" />
                <rect className="ctx-menu__hi" x="4" y="5" width="58" height="12" rx="4" />
                <rect className="ctx-menu__line ctx-menu__line--on" x="9" y="9" width="32" height="4" rx="2" />
                <rect className="ctx-menu__line" x="9" y="24" width="40" height="4" rx="2" />
                <rect className="ctx-menu__line" x="9" y="34" width="26" height="4" rx="2" />
              </g>
            </g>
          </>
        )}

        <g className={`mini-cursor mini-cursor--${kind}`}>
          <g className="mini-cursor__squish">
            <circle className="cursor-halo cursor-halo--soft" cx="3" cy="6" r="9" />
            <path className="cursor-arrow" d="M0 0V15l4-3.5 2.6 6 2.7-1.2-2.6-5.9h5.2z" />
          </g>
        </g>
      </svg>
    </div>
  )
}
