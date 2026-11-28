// One place for the "i" help text of every adjustable control.
// Key = element id (fixed controls) or a generated key for the built controls:
//   step.<enableX>  pipeline step switches      p.<field>  pipeline parameters (algorithms/config.ts)
//   s.<field>       simulator settings (src/sim/imu.ts)   t.<field>  tap-signature settings
// Texts follow the field comments in algorithms/config.ts and how pipeline.ts / stroke.ts / gravity.ts use them.

export const INFO: Record<string, string> = {
  // ── section notes (moved out of the visible text) ──
  'h.live': 'Moves the cursor with the real MPU-6050 instead of the simulated one. The ESP32 must print t,ax,ay,az,gx,gy,gz lines at 921600 baud. Keep the IMU still for the first second while it calibrates. Needs Chrome or Edge. If the status says the port is busy, close anything else using it (for example the PlatformIO serial monitor) and try again. While receiving, the status shows the sample rate; the pipeline is tuned for 1 kHz, so at a low rate motion is coarse and tap detection is unreliable (untick Tap detection if hand motion triggers clicks). It also reports garbled lines and sensor warnings, which mean readings were lost or damaged.',
  'h.desk': 'Move your mouse over the pad to slide the simulated hand. Click to grab it (pointer lock: the real pointer disappears); Esc releases. Tap with J = index (left click), L = pinky (right click); mouse buttons do the same while grabbed.',
  'h.train': 'The finger is decided by a trained model (per-axis accel peak and RMS, gyro peaks, impact size, duration, gyro/accel ratio), not a hand-written rule.',
  'h.replay': 'Columns t, ax, ay, az, gx, gy, gz and an optional label. t in s (ms auto-detected), accel in g (m/s² auto-detected), gyro in °/s. Label index or pinky on a tap\'s rows.',
  'h.clicktest': 'Quiz: a LEFT or RIGHT prompt every 2.5 s; a click counts if it peaks within 1.5 s. Sensitivity 2× lowers the amplitude and tap-score thresholds; it never changes which finger a tap is assigned to. Teach takes about 40 s and keeps the result in this browser. The live pipeline keeps running underneath with its tap detection off.',

  recTool: 'Records every IMU reading and what the cursor did with it, saved as a CSV (up to 10 min). Free works in the simulator too; Guided needs the ESP32. While recording, click it (or the Stop pill in the header) to stop and save.',
  recMode: 'Free: record whatever you do and save the CSV when you stop (up to 10 min). Guided: a 3-2-1 countdown, then a timed script of moves or taps that is recorded and saved as a CSV labelled with each step. Guided needs the ESP32 connected.',
  'h.rezero': 'Hold the sensor still: resets the pipeline and re-learns gravity and gyro bias (the start-up calibration). Not the same as the 6-face accelerometer calibration under Live IMU, which corrects the sensor itself.',
  // ── fixed controls ──
  chkDebug: 'Shows the simulator\'s TRUE hand path next to the estimated path (Desk and the inset on the cursor view) so you can see the error. Display only; it is hidden automatically during the target test.',
  deskSens: 'Simulator desk in grab mode: millimetres the simulated hand moves per mouse count. Higher = bigger hand moves for the same mouse movement.',
  guideScript: 'Which guided recording to run (3-2-1, then the timed steps). Panning: left/right moves at 4 speeds. Clicks v1: index = left, pinky = right. Clicks v2: firm and soft taps plus non-click motions (negatives). Each saves a CSV labelled with every step.',
  guideSound: 'Beeps during a guided run: high at each move, a left or right tone for each click, mid for a non-click motion, low at each pause, rest or tilt, and a tick each second of the countdown. Off = silent; the screen prompts stay.',
  tN: 'Number of targets in the target test (3–60). More targets = a steadier hit-rate and throughput estimate, but a longer test.',
  rpSpeed: 'How fast a loaded CSV is replayed: 1×, 4×, 16× real time, or as fast as possible. The cursor result is the same, only the time it takes changes.',
  preset: 'Loads a whole set of sensor errors into the Simulator sliders: noise, offsets, drift and (for the measured preset) desk vibration, gyro warm-up. "MPU-6050 on the wrist (measured)" copies what the real board showed. Changing it recalibrates.',
  abStep: 'The pipeline step to test. Runs are headless (a second or two), use the current sensor preset and every other setting as it is now. A/B runs the same scripted tests and seeds with this step OFF (A) and ON (B), with every other setting as it is now.',
  abStrokes: 'Include the scripted stroke test (end-point and direction error of known hand strokes) in the A/B run.',
  abDrift: 'Include the drift test (hand perfectly still: how far the cursor wanders) in the A/B run.',
  abTaps: 'Include the tap test (finger accuracy and cursor jump per tap) in the A/B run.',
  abRepeats: 'Runs per test with different noise seeds, 1–20. More repeats = steadier averages but a longer run.',
  abDriftS: 'Length of the drift test in seconds (5–120). Longer shows slow drift but takes longer.',
  clfKind: 'Tap classifier model that decides index vs pinky from the tap features. Logistic regression learns a weighted boundary; nearest centroid compares to the average tap of each finger. Switching refits on the current training set.',
  clfN: 'Taps per finger collected by "Train" (3–50). More taps = a better-fitted classifier but a longer session.',
  ctSens: 'Click detector sensitivity, 0.5×–2×. Above 1× lowers the amplitude threshold and the tap-score threshold: lighter taps are found, but more false clicks. It never changes which finger a tap is assigned to.',
  ctQuiz: 'Quiz mode: a LEFT or RIGHT prompt every 2.5 s. A click counts for a prompt if it peaks within 1.5 s of it; the score shows accuracy, wrong side and missed.',
  ctSound: 'Beeps for quiz and Teach prompts (different pitch for left and right). Off = silent.',

  // ── pipeline steps (switches) ──
  'step.enableCalibration': 'Start-up calibration: averages gyro bias and gravity while the board is still. Off: nothing is measured at start, so gyro bias and tilt errors are not removed and the cursor drifts.',
  'step.enableFusion': 'Orientation filter that tracks wrist tilt so gravity can be removed. Off: orientation stays frozen at its start value, so any wrist tilt turns into false hand motion.',
  'step.enableGravityRemoval': 'Rotates the accelerometer reading into the level frame and subtracts 1 g to get hand acceleration. Off: gravity is not subtracted this way, so the cursor follows tilt instead of motion.',
  'step.enableZupt': 'Stillness detection: when the hand is judged still, velocity is reset to zero. Off: velocity errors are never cleared and the cursor keeps creeping after you stop.',
  'step.enableRestDetect': 'Rest test that a tilt error cannot fake (quiet gyro, steady accel, |a| ≈ 1 g). It lets the tilt be re-levelled and velocity reset even when a tilt error makes the normal stillness test fail. Off: such a tilt error can block resets and the cursor runs off.',
  'step.enableSlideDetect': 'Sliding detector: desk vibration (100–300 Hz) says the hand is moving, even at steady speed. While sliding the tilt filters do not learn, strokes only start, and may glide at steady speed. Off: motion is judged from acceleration alone.',
  'step.enableVelocityDecay': 'Small leak on the velocity integrator (rate set under Parameters). Off: velocity is never leaked, so drift only ends at a stillness reset.',
  'step.enableDeadzone': 'Ignores velocities below the deadzone value so the cursor does not creep. Off: even tiny velocities move the cursor.',
  'step.enableSpeedCurve': 'Cursor gain rises with hand speed: slow = fine control, fast = long reach. Off: one constant gain for all speeds.',
  'step.enableClickFreeze': 'On a detected tap, rolls the cursor back to just before the tap and holds it briefly, so the finger tap does not move the pointer. Off: taps can nudge the cursor.',
  'step.enableTaps': 'Tap detection and finger classification (index = left click, pinky = right click). Off by default in the app: a fast flick or sliding vibration can trigger it.',

  // ── pipeline modes ──
  fusionMode: 'How tilt (gravity) is tracked. "Accel" modes move the cursor from the accelerometer alone and ignore the gyro (Kalman or complementary filter). Madgwick fuses gyro and accel. Gyro only never corrects with the accel. Static freezes orientation at the start. Switching recalibrates.',
  motionModel: 'How acceleration becomes cursor motion. Stroke tracker: a stroke starts in the direction of the first push, only braking along it counts, and velocity is set to 0 when braking ends. Plain integration: velocity = integral of acceleration all the time. Stroke + rest correction: integrate each move from rest to rest, then remove its drift when the hand comes to rest.',
  adaptiveBeta: 'Madgwick fusion gain: trust the accelerometer more while the hand is still and the gyro more while it moves. Off: one fixed gain ("Madgwick β (non-adaptive)").',
  biasTracking: 'Keeps refining the gyro bias whenever the hand is still, so slow sensor warm-up drift is corrected. Off: the bias stays at its start-up value.',

  // ── pipeline parameters ──
  'p.calibrationMs': 'Time the board must stay still at start-up while gyro bias and gravity are averaged (200–3000 ms). Longer = a better estimate but a longer wait; shorter = faster start, noisier offsets.',
  'p.betaStill': 'Madgwick gain while the hand is still: how strongly the accelerometer corrects tilt. Higher = tilt errors vanish faster but accel noise leaks into the tilt; lower = steadier but slower to recover.',
  'p.betaMoving': 'Accelerometer tilt correction after long continuous motion. 0 = never correct while moving, so hand acceleration is not mistaken for tilt; higher lets tilt recover during long moves.',
  'p.betaFixed': 'Madgwick gain (rad/s) used only when "Adaptive β" is off. Higher = faster tilt correction, more accel noise in the tilt.',
  'p.motionGateG': 'While still, tilt correction pauses if sideways linear acceleration exceeds this (the start of a stroke). Lower = pauses earlier, protecting gentle strokes from being learned as tilt.',
  'p.fusionMovingDelayMs': 'While moving, the filter uses the gyro only; after motion has lasted this long the accelerometer slowly corrects tilt again. Longer = trusts the gyro longer.',
  'p.compTauS': 'Complementary filter: gravity = low-pass of the accelerometer with this time constant. Longer = steadier during strokes but slower to recover after a wrist tilt; shorter = quick recovery but strokes leak into tilt.',
  'p.kalmanTiltRate': 'Kalman filter process noise: how fast gravity may change. Higher = faster recovery after a tilt but more of each stroke is absorbed as tilt; lower = steadier gravity.',
  'p.kalmanMotionK': 'Kalman: measurement noise added per g of accel spread above the noise floor, i.e. how much hand motion lowers trust in the accelerometer as a gravity reading. Higher = ignores the accel more while moving.',
  'p.kalmanSpreadFloorG': 'Kalman: accel spread below this counts as sensor noise, not hand motion. Higher = treats more motion as noise and keeps trusting the accel.',
  'p.stillAccelG': 'Stillness test: mean horizontal linear acceleration must stay below this. Higher = declares "still" more easily (more velocity resets, may cut slow motion); lower = stricter.',
  'p.stillGyroDps': 'Stillness test: mean gyro magnitude must stay below this. Higher = declares "still" more easily; lower = stricter.',
  'p.stillWindowMs': 'Averaging window of the stillness test. Longer = smoother decisions but slower to notice you stopped or started.',
  'p.stillHoldMs': 'The still thresholds must hold this long before velocity is forced to 0. Longer = fewer false resets but the cursor stops a little later.',
  'p.stillHoldPerVel': 'Extra hold time added per unit of current speed (capped at 100 ms) so slow strokes are not cut short. Higher = more protection for slow strokes; 0 = fixed hold.',
  'p.restSpreadG': 'Tilt-proof rest test: accel spread over ~100 ms must stay below this. Higher = counts rest more easily even with slight motion; lower = stricter.',
  'p.restHoldMs': 'Quiet gyro + steady accel + |a| ≈ 1 g must last this long to count as rest. Shorter cuts slow strokes short; longer is slower to correct a stuck tilt error.',
  'p.betaRelevel': 'Madgwick gain used to remove a tilt error found at rest. Higher = a leftover tilt is removed faster.',
  'p.strokeOnsetG': 'A stroke starts when acceleration (relative to what the sensor reads at rest) passes this in a steady direction. Lower catches slower strokes but also noise.',
  'p.strokeBrakeG': 'Speeding up turns into slowing down once acceleration points back by this much; from then on only the stroke direction counts. Lower = braking recognised earlier.',
  'p.strokeEndFrac': 'The hand is judged stopped once braking has faded below this fraction of its peak: velocity is set to 0 and the cursor halts. Higher = stops sooner.',
  'p.strokeEndMs': 'Braking must stay faded for this long before the stroke ends. Longer = fewer early stops.',
  'p.strokeCruiseMs': 'Pushed, then neither pushing nor braking for this long = stopped (a hand does not glide). While the sliding detector says sliding, a longer glide limit applies instead.',
  'p.strokeSettleMs': 'After a stroke ends, this much quiet is required before a new stroke can start (ignores the wrist wobbling to a stop).',
  'p.strokeMaxSpeedupMs': 'Speeding up for longer than this is a wrist tilt, not a hand stroke: the movement is undone.',
  'p.strokeLpHz': 'The stroke phase decisions look at acceleration below this frequency. Sliding adds strong vibration above ~50 Hz while hand motion is below ~10 Hz, so a lower value rejects vibration but reacts slower.',
  'p.strokeRelFrac': 'Braking, pushing again or turning only counts above this fraction of the stroke\'s own strongest push or braking, so vibration cannot flip the phase. Higher = more robust, less sensitive.',
  'p.strokeLeakGain': 'Each time the hand stops, the leftover speed shows how much gravity leaked in; this fraction of it is learned and subtracted from later strokes. 0 = off.',
  'p.velocityDecayPerS': 'Velocity leak rate per second: v ← v·exp(−rate·dt). Higher = motion fades faster (less drift, less glide).',
  'p.deadzoneMps': 'Velocities below this (mm/s) are treated as zero. Higher = the cursor stays put for tiny movements but very slow motion is lost.',
  'p.gainMin': 'Cursor gain at very low hand speed (px per metre of hand movement). Higher = the cursor travels farther even for slow, fine moves.',
  'p.gainK': 'How much the gain grows with speed (px per metre): gain = gMin + k·ln(1 + speed/v0). Larger = fast flicks travel much farther than slow moves.',
  'p.gainV0': 'Speed scale of the gain curve (cm/s): the gain starts to rise around this hand speed. Lower = the speed boost kicks in earlier.',
  'p.gainLinear': 'Constant cursor gain (px per metre) used only when the speed curve is off.',
  'p.freezePreMs': 'Click freeze: on a tap, the cursor is rolled back this far before the tap onset, so the finger tap does not shift the pointer.',
  'p.freezePostMs': 'Click freeze: the cursor is held for this long after a tap. Longer = steadier clicks but the cursor is stuck longer.',
  'p.tapThresholdG': 'Tap detection: peak of the high-passed acceleration needed to trigger a tap. Lower = lighter taps found but more false triggers from motion.',
  'p.tapHighpassHz': 'High-pass cut-off that separates the sharp tap from slower hand motion. Higher = ignores more hand motion but may weaken soft taps.',
  'p.tapWindowMs': 'Window after the trigger from which tap features (peaks, RMS, duration) are taken for classifying index vs pinky.',

  // ── simulator settings ──
  's.accelNoiseUg': 'Accelerometer noise density (µg/√Hz); noise σ = density·√bandwidth (500 Hz). Higher = noisier readings, harder stillness and stroke detection.',
  's.gyroNoiseDps': 'Gyro noise density (°/s/√Hz). Higher = noisier gyro, so tilt estimates wander more.',
  's.accelOffsetMg': 'Each accel axis gets a random offset within ± this at power-on. Calibration removes it; left uncorrected it looks like tilt.',
  's.gyroOffsetDps': 'Each gyro axis gets a random offset within ± this at power-on. Calibration removes it; left uncorrected it makes the orientation, and so the cursor, drift.',
  's.accelDriftMg': 'Accel bias random walk (mg/√s): the offset slowly wanders over time. Higher = more slow drift.',
  's.gyroDriftDps': 'Gyro bias random walk (°/s/√s). Higher = the gyro offset wanders faster.',
  's.vibrationMg': 'Shaking at 100–300 Hz whenever the hand slides on the desk. The real sensor showed 60–85 mg on the horizontal axes and 2 mg at rest. Drives the sliding detector and adds noise to the accelerometer.',
  's.vibrationGyroDps': 'The same sliding vibration as seen by the gyro (the real board: 2–6 °/s).',
  's.gyroWarmupDps': 'How far each gyro axis drifts from its start-up bias as the sensor warms up (the real board: about 0.4 °/s).',
  's.gyroWarmupTauS': 'Time constant of that warm-up drift. Longer = the bias keeps changing for longer after power-on.',
  's.baseRollDeg': 'Mounting roll of the sensor. Around 180° = mounted upside down (z reads −1 g at rest, as on the real board).',
  's.basePitchDeg': 'Mounting pitch of the sensor in degrees.',
  's.wobbleDeg': 'Wrist tilt wobble while the hand strokes. It adds false acceleration; 0.8° matches the real wrist (about 0.3° RMS).',
  's.handOmega': 'How quickly the simulated hand follows your mouse (rad/s). Higher = snappier, with sharper accelerations.',

  // ── tap signatures ──
  't.tapSimilarity': 'How alike the index and pinky tap signatures are: 0 = each finger has its own, 100 % = identical (finger classification becomes a coin flip).',
  't.tapVariation': 'Tap-to-tap randomness of each simulated tap. Higher = taps vary more, so classification is harder.',
};

for (const f of ['tapIndex', 'tapPinky'] as const) {
  const name = f === 'tapIndex' ? 'index' : 'pinky';
  for (const ax of ['x', 'y', 'z']) {
    INFO[`t.${f}.accel.${ax}`] = `Peak acceleration along sensor ${ax} (g) of the simulated ${name} tap. Together with the other axes it sets the tap's direction and size, which the classifier uses to tell the fingers apart.`;
    INFO[`t.${f}.gyro.${ax}`] = `Peak rotation rate around sensor ${ax} (°/s) of the simulated ${name} tap. It shapes the tap's twist signature that the classifier uses.`;
  }
  INFO[`t.${f}.freqHz`] = `Ring frequency (Hz) of the simulated ${name} tap's oscillation.`;
  INFO[`t.${f}.decayMs`] = `How fast the simulated ${name} tap's ring dies away (ms time constant). Longer = a longer ring.`;
}

// ── "i" button + popover ──

let pop: HTMLElement | null = null;
let openBtn: HTMLButtonElement | null = null;

function ensurePop(): HTMLElement {
  if (pop) return pop;
  pop = document.createElement('div');
  pop.id = 'infoPop';
  pop.className = 'infopop hidden';
  pop.setAttribute('role', 'tooltip');
  document.body.appendChild(pop);
  return pop;
}

function closeInfo(): void {
  if (!openBtn) return;
  openBtn.setAttribute('aria-expanded', 'false');
  openBtn.removeAttribute('aria-describedby');
  openBtn = null;
  pop?.classList.add('hidden');
}

function openInfo(btn: HTMLButtonElement): void {
  const p = ensurePop();
  closeInfo();
  openBtn = btn;
  p.textContent = INFO[btn.dataset.info!] ?? '';
  p.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  btn.setAttribute('aria-describedby', 'infoPop');
  const r = btn.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 24);
  p.style.width = `${w}px`;
  const left = Math.max(12, Math.min(window.innerWidth - 12 - w, r.left + r.width / 2 - w / 2));
  p.style.left = `${left}px`;
  const h = p.offsetHeight;
  const below = r.bottom + 8;
  p.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - 8 - h) : below}px`;
}

/** Puts an "i" button right after the label text of a control. */
export function addInfo(label: HTMLElement, key: string, detached = false): HTMLButtonElement | null {
  if (!INFO[key]) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'i';
  b.textContent = 'i';
  b.dataset.info = key;
  const name = (label.textContent ?? '').trim();
  b.setAttribute('aria-label', `About ${name || key}`);
  b.setAttribute('aria-expanded', 'false');
  if (detached) return b;
  const t = Array.from(label.childNodes).find(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim());
  if (t) t.after(b); else label.appendChild(b);
  return b;
}

/** Adds the button to every fixed control whose id has an entry. */
export function initInfo(): void {
  document.querySelectorAll<HTMLElement>('[data-info-after]').forEach(el => {
    const b = addInfo(el, el.dataset.infoAfter!, true);
    if (b) el.after(b);
  });
  document.querySelectorAll<HTMLElement>('[data-info]:not(button)').forEach(h => { const k = h.dataset.info!; delete h.dataset.info; addInfo(h, k); });
  for (const key of Object.keys(INFO)) {
    const el = document.getElementById(key);
    const lab = el?.closest('label');
    if (lab && !lab.querySelector(`button.i[data-info="${key}"]`)) addInfo(lab, key);
  }
  document.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const b = t.closest?.('button.i') as HTMLButtonElement | null;
    if (b) { e.preventDefault(); if (b === openBtn) closeInfo(); else openInfo(b); return; }
    if (!t.closest?.('#infoPop')) closeInfo();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && openBtn) { const b = openBtn; closeInfo(); b.focus(); }
  });
  window.addEventListener('resize', closeInfo);
  window.addEventListener('scroll', closeInfo, true);
}
