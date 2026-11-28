# Wrist Mouse Lab

Interactive browser simulation of a wrist-worn IMU gesture mouse: an MPU-6050 on the back of the wrist, read by an ESP32 at 1 kHz. Cursor motion comes from integrating acceleration. Index taps are left clicks and pinky taps are right clicks; a trained classifier tells them apart.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 — live-reloading dev server
npm run build      # → dist/index.html, ONE self-contained file (open it by double-click, no server)
npm run verify     # headless checks of the physics + pipeline (prints the measured numbers)
```

For the presentation, copy `dist/index.html` to the laptop. It has no dependencies and no network access.

> The algorithms (pipeline, fusion, stroke tracker, click detector, calibration) live in the sibling folder `../algorithms/`. See `../algorithms/README.md`.

## Using it

| Action | How |
|---|---|
| Move the **true** hand | Move the mouse over the **Desk** pad, or **click** the pad to grab the hand with pointer lock (the real pointer disappears and your mouse slides the hand). <kbd>Esc</kbd> releases it. |
| Index tap (left click) | <kbd>J</kbd>, or the left mouse button while the hand is grabbed |
| Pinky tap (right click) | <kbd>L</kbd>, or the right mouse button while the hand is grabbed |
| Pause / recalibrate | <kbd>Space</kbd> / <kbd>R</kbd> |
| True path | Shows the true path vs the estimated path (desk pad + inset). It is hidden automatically during the target test. |

**Tests** (right panel)
- **Target test**: Fitts-style targets in 3 sizes × 3 distances. Steer the *estimated* cursor and click with an index tap. It records hit rate, time per target, error at click, throughput, wrong-finger clicks, false clicks and missed taps.
- **Stroke test**: six scripted, repeatable strokes (5 cm right, 10 cm diagonal, 1 cm slow, …) for estimated vs true distance and direction.
- **Drift test**: the hand is held perfectly still for 30 s.

**A/B compare tab**: runs the same seeded tests headless with one pipeline step **off (A)** and **on (B)**, for N repeats. **Ablation sweep** turns each step off in turn against "all on". These are the presentation charts.

**Tap classifier tab**: training mode (tap N times per finger), auto-train from simulated taps, leave-one-out confusion matrix, feature scatter, live confusion matrix and a tap log.

**Results & export tab**: all metrics, *Export results CSV*, and *Export IMU data CSV* (last 120 s of raw simulated readings plus labels and truth).

**Replay real data** (right panel): import a CSV from your hardware and run it through the same pipeline.

## Live IMU (real hardware)

The **Live IMU** card (top of the right panel) swaps the simulated sensor for the real MPU-6050 on the ESP32. It reads the board's USB serial port straight from the browser (Web Serial), so it needs **Chrome or Edge**; Safari and Firefox stay on the simulation.

1. Plug in the ESP32 running the `imu_testing` sketch. It streams the MPU-6050 at 1 kHz from the sensor's FIFO as `t,ax,ay,az,gx,gy,gz` lines at 921600 baud (±8 g, ±1000 °/s, 188 Hz low-pass, matching the simulated sensor). Close any other serial monitor, since only one program can hold the port.
2. `npm run dev`, open the page in Chrome, click **Connect ESP32** and pick the USB serial port (`cu.wchusbserial…` on this board).
3. Keep the IMU still for about a second while it measures the board's sample rate and calibrates. The cursor then follows the real sensor.

After the first connection, reloading the page reconnects to the same board on its own. **R** recalibrates; **Back to simulation** (or unplugging the board) returns to the simulator. Starting a precision test or tap training also switches back, since those need the simulated ground truth. *Export IMU data CSV* records the real readings too.

The pipeline takes its sample rate from the board's timestamps, so it runs at the 1 kHz it was designed for. Nothing else may use the I2C bus while streaming: refreshing an OLED on the same bus corrupted the FIFO reads, so the sketch no longer drives one.

### Accelerometer calibration

Each MPU-6050 reads a little off at rest (about +0.08 g on x here, where it should read 0), and the scale differs per axis. That error looked like tilt and leaked gravity into hand-motion estimates. The **Accel calibration** tool (Live IMU card → Tools) measures it:

1. Rest the board on one of its six faces and keep it still for 2 s. Any order works. The card shows which faces are done (`+X ✓ −X … `).
2. Repeat on the other five faces until all six show ✓.
3. For each axis, bias = (up + down) / 2 and scale = 2 / (up − down). The pipeline then uses (raw − bias) · scale before anything else.

If a bias is over 150 mg or a scale is outside 90–110 %, the result is rejected and nothing changes. The result is saved in this browser and restored on the next load; **Reset** clears it back to no correction. The raw columns in a recording stay raw, and the recording's header line records the calibration that was active.

### Click tester

In the Live IMU card, the **Click tester** tool (enabled while the ESP32 is connected) opens a panel that checks left and right clicks live, without touching the cursor pipeline:

- **LEFT · index** and **RIGHT · pinky** pads flash and count each detected click. Below them: the last click's peak (g) and its confidence, and a strip of the last 3 s of the 20 Hz high-passed accel magnitude (the tap band) with the detection threshold (dashed) and each detected tap coloured by side.
- Start-up takes about 1.5 s (history for the detector and a noise estimate). **Recalibrate** measures the noise level again. **Sensitivity** (0.5×–2×) lowers (above 1×) or raises the amplitude threshold and the tap test: 2× finds lighter taps and also more false ones. It never changes which finger a tap is assigned to.
- **Teach…** (about 40 s) adapts the detector to you: 5 index taps, 5 pinky taps (a beep with each prompt, high for index, low for pinky), 3 s of a completely still hand and 3 s of moving, lifting and sliding the hand without tapping. The class centres move towards your own taps, the tap test is adjusted so your softest tap passes and the strongest non-tap is refused, and the amplitude floor drops to 0.6× your softest tap if that is below the default. The result is kept in this browser's localStorage (`wml.clickProfile.v1`) and applied every time the tester opens; **Forget teaching** returns to the trained default. If fewer than 3 taps of a kind are heard, nothing changes.
- **Quiz mode** prompts LEFT or RIGHT every 2.5 s with a beep (high for LEFT, low for RIGHT; **Sound** turns it off) and scores each prompt: a click that peaks within 1.5 s of the prompt is correct or a wrong side; no click is missed. Extra clicks outside the windows are counted separately. **Reset** clears the counts and the quiz.

How it works (`../algorithms/clicks/detector.ts`; `../algorithms/README.md` has the full description):

1. Filters on every reading: accel 20 Hz high-pass (the tap band), 5 Hz high-pass, 1–10 Hz band (slow motion); gyro 2 Hz high-pass magnitude (motion) and 20 Hz high-pass.
2. A candidate is the largest tap-band accel peak within ±150 ms, above max(0.05 g, 8 × noise) / sensitivity, where the noise is the median of 10 ms maxima over the last 6 s (a still hand sets it; a brief movement does not).
3. 150 ms after the peak a logistic **tap test** looks at the quiet before the peak, the 1 s of history, how long the ring lasts and whether it has died away 100–150 ms later. Sliding, lifting and rotating leave sustained vibration or slow motion and fail it.
4. A linear discriminant on the tap's peak amplitude and its 5 Hz / 20 Hz band ratio decides index (L) or pinky (R). Neither stage depends on the sensitivity setting for the finger decision.

Check the live path without hardware: `npm run replay:clicks` feeds recordings through the same parser, rate probe and detector construction the page uses and checks the result against the offline numbers (also lost lines, a moving hand during start-up, sensitivity and the teach step).

To retrain after recording new guided clicks takes (`npm run train:clicks`, or pass the CSV paths after `--`; `--dry` prints without rewriting): the script reads every `clicks_*`, `clicks2_*` and `panning_*` recording in `../data`, finds candidates with the same detector, labels click windows from `guide_click`, treats clicks v2 non-click windows and the panning takes as negatives, reports leave-one-recording-out numbers (detection, side accuracy, events per minute on panning and in pauses, a 0.5× softer tap simulation, sensitivity 0.75 / 1.5), then rewrites `../algorithms/clicks/model.ts`. Do not edit that file by hand. `npm run analyze:clicks` is the older offline analysis of the click takes.

### Recording a session

The **Recorder** tool (Live IMU card → Tools, mode **Free**) saves every sample from Start to Stop (up to 10 minutes) as `imu_session_<time>.csv`: the raw reading (`t, ax…gz`), what the pipeline made of it (`lin_x/y` hand acceleration, `vel_x/y`, `pos_x/y`), the cursor (`cursor_x/y_px`), the `still` / `frozen` flags and any `tap_detected`. A comment line at the top names the input and cursor mode. It works for live, simulated and replayed data; simulated runs also fill `true_x_m, true_y_m`.

A recording loads straight back into **Replay real data**. **Compare cursor modes** runs the file through each mode and reports how long the cursor sat on a screen edge, how far it ended from where it started, and its top speed. End a recording with your hand back where it started and *start→end* becomes a drift measure.

### Guided panning recording

Open the **Recorder** tool (Live IMU card → Tools), choose **Guided**, pick a script, then **Start**. Guided mode needs the ESP32 connected. A 3-2-1 countdown runs (ticks), then the script plays on a full-screen panel with a countdown for each step, the section and progress, the next step, and (for moves) a pacing dot that travels from the left mark to the right mark over the move. Beeps: high at each move, L/R pitches at each click, low at each pause, rest, still or tilt step. **Sound** turns them off. Recording starts when step 1 begins and stops (and saves) when the script ends. **Stop guide** (or the ● Stop pill in the top bar) ends it early; an early stop is saved as `_aborted`.

Two scripts:

**panning v1** (hand slides between two marks 10 cm apart on paper):

| Section | Steps |
|---|---|
| start | still 5 s, "Hold still on the LEFT mark" |
| quick / normal / slow / very-slow | 6 moves of 0.3 / 0.6 / 1.5 / 3.5 s, alternating L→R and R→L, each followed by a 1.5 s pause; then a 4 s rest |
| tilt | 8 s, "Rock your wrist slowly … do NOT slide" |
| end | still 5 s, "Hold still — finishing" |

**clicks v1** (hand stays still on the paper; tap with the index finger = left click, pinky = right click):

| Section | Steps |
|---|---|
| start | still 5 s, "Rest your hand still" |
| left | 10 × [tap LEFT (index) 1.0 s, pause 1.5 s]; then a 4 s rest |
| right | 10 × [tap RIGHT (pinky) 1.0 s, pause 1.5 s]; then a 4 s rest |
| mixed | 20 taps, 10 L + 10 R in a shuffled order (fixed seed, so every run has the same order), each followed by a 1.5 s pause; then a 4 s rest |
| end | still 5 s, "Hold still — finishing" |

**clicks v2** (`clicks2`; the same hand position; collects what the tap test and soft taps need):

| Section | Steps |
|---|---|
| start | still 5 s |
| firm | 20 taps, 10 L + 10 R shuffled (seed 11), each 1.0 s + 1.5 s pause; then a 4 s rest |
| soft | 20 SOFT taps, 10 L + 10 R shuffled (seed 12), same timing; then a 4 s rest |
| lift, slide, rotate, palm, thumb, otherfinger | 6 × [non-click motion 2.0 s (lift 2 s, slide 1 s, rotate 2 s, palm 1 s, thumb 1 s, middle/ring finger 1 s), pause 1.5 s]. Labelled `guide_step` = `neg`, the section names the motion |
| rest | still 8 s |
| end | still 5 s |

About 3.8 minutes. `scripts/train-clicks.ts` uses these files automatically when they are in `../data` (named `clicks2_take..._….csv`); v1 stays selectable and unchanged.

The scripts are data in `src/ui/guide.ts` (`panningSteps`, `clicksSteps`, `clicks2Steps`).

**Files.** A guided run saves `<script>_take<NN>_<YYYY-MM-DD>_<HH-MM-SS>.csv`, for example `panning_take01_2026-11-27_14-05-33.csv`. The take number is counted separately for each script and kept in this browser's localStorage; the next number is shown next to the script menu, and **reset count** sets both back to 01. The time is the local time when the run started. A run that was stopped early is saved with `_aborted` before `.csv`. The take counter only moves on when a file is actually saved. Free recordings keep the `imu_session_<time>.csv` name.

**CSV columns.** Guided rows add `guide_section` (start, quick, … / left, right, mixed / firm, soft, lift, slide, rotate, palm, thumb, otherfinger, rest / tilt, end), `guide_step` (`still`, `move`, `pause`, `tilt`, `click`, `neg`), `guide_move` (the move index for panning moves, the click index for clicks, the repeat for non-click motions; empty otherwise), `guide_dir` (`+1` / `-1` for panning moves, `0` otherwise) and `guide_click` (`L` / `R` for clicks, empty otherwise). Each sample is labelled with the step active when it was processed. Rows from ordinary recordings leave these columns empty. The first comment lines name the script, its timings, the take number and the local start time. The columns are added at the end of the header, so the importers and the bench scripts still find the other columns by name.

### Cursor modes (Pipeline steps → Fusion mode)

The app starts in **Accel only: Kalman**: cursor motion comes from the accelerometer alone, and the gyro is ignored (it is still used for tap classification).

| Mode | How gravity is separated from hand motion |
|---|---|
| Accel only: Kalman | Gravity is a slowly drifting state; the accelerometer measures it, trusted when the accel is steady (hand still, even if tilted) and distrusted while it varies (hand moving). |
| Accel only: complementary | Gravity = low-pass of the accelerometer (time constant `compTauS`, 2 s); hand motion = the rest. |
| Madgwick (gyro + accel) | Orientation from the gyro, corrected by the accelerometer while the hand is still (and re-levelled by step 4b at rest). |

**Why the cursor got stuck in a corner (Madgwick, now fixed).** While the hand moves, Madgwick tracks tilt with the gyro alone. A real gyro's few-percent scale error leaves a tilt error after a wrist rotation, and 1–2° of tilt error leaks 0.02–0.035 g of gravity into "hand acceleration". The stillness test (which judges that horizontal acceleration) then never passed. Without stillness there was no tilt correction and no zero-velocity reset, so the velocity grew without limit and the cursor stayed pinned to an edge. On a real at-rest recording, 2° of tilt the gyro never reported kept Madgwick at an edge for the full 24 s, with the hand never seen as still again.

**The fix: step 4b, a tilt-proof rest test** (gyro modes). The hand counts as at rest when the gyro is quiet, the accelerometer reading is steady over ~100 ms, and its magnitude is ≈ 1 g, for 500 ms. None of these depend on the tilt estimate. At rest the velocity is reset, and if the normal stillness test still sees sideways acceleration (a tilt error), Madgwick re-levels at `betaRelevel` (0.1 rad/s) and the cursor movement integrated during the 500 ms hold is undone (it came from the tilt error, since the hand was at rest all along). With it, the same 2° case moves the cursor 5 px and is seen as still 91 % of the time; a 5° hidden tilt moves it 225 px and then it stops, and a push 10 s later moves it normally (without 4b the push just flings it into another corner). Stroke accuracy in the simulator is unchanged (0.20 cm, 2°). The hold is 500 ms because a shorter one cuts slow strokes short. The accel-only modes don't use 4b: without a gyro a slow stroke looks like rest, and their gravity filters can't get stuck this way anyway. Untick **4b** in Pipeline steps (or A/B it) to see the old behaviour.

**What no-gyro costs.** The accelerometer can't tell a wrist tilt from a sideways push. In the simulator (3° of wrist wobble per stroke) the stroke end-point error is ~1.6–1.7 cm and the direction error 15–28°, against 0.2 cm and 2° for Madgwick. With no wobble the Kalman mode is close to Madgwick (0.4 cm, 4°). Complementary handles wobble a little better but takes several seconds to recover from a tilt; Kalman recovers in well under a second.

The screen edges also act as a wall: velocity pushing further out is dropped, so moving back takes effect immediately.

### Motion model (Pipeline steps → Motion model)

The app starts with the **stroke tracker**. **Plain double integration** is the old behaviour. Taps (**8. Click freeze** and **9. Tap detection**) start switched off while the motion is being worked on, and the simulator adds no tap jolts while they are off. Tick them under Pipeline steps to bring them back.

**Is double integration lossy?** Not in itself. Integrating the *true* hand acceleration twice at 1 kHz reproduces the path exactly (0.0000 mm error over 34 cm of strokes). Adding MPU-6050 white noise (400 µg/√Hz) costs under 2 mm per stroke. The real loss is upstream: any tilt error leaks gravity into "hand acceleration", and integrating twice turns 0.02 g into centimetres within half a second. Without a gyro, wrist wobble during a stroke is exactly such a tilt error.

**The stroke tracker** (`../algorithms/motion/stroke.ts`) uses what a mouse stroke looks like instead of integrating forever:

1. **Start**: acceleration (measured against what the sensor reads at rest, so a steady tilt offset doesn't count) passes 6 mg in a steady direction for 10 ms. That first push sets the direction; the few ms before the threshold are integrated back in.
2. **Speeding up**: acceleration is integrated into velocity (2-D, so the direction can still settle).
3. **Slowing down**: once acceleration points backwards, the direction is locked and only acceleration along it counts, so sideways wobble is ignored. Speed can't go below zero. A sideways push means a turn and goes back to step 2; if the hand keeps pushing back hard after the speed is used up, it's reversing and a new stroke starts the other way.
4. **Halt**: once the braking has faded (below 20 % of its peak for 8 ms), the hand has stopped and velocity is set to exactly 0, so integration error can't carry on as drift. A push followed by 120 ms of neither pushing nor braking also halts (a hand doesn't glide).
5. **Settle**: the wobble as the wrist comes to rest is ignored until it has been quiet for 40 ms. Running head-on into a screen edge also ends the stroke, and its braking is ignored, so the cursor doesn't bounce back off the edge. The same happens while the cursor is frozen around a tap.
6. **Not a stroke**: speeding up in one direction for over 600 ms is a wrist tilt, not a hand stroke. The movement is undone, and in accel-only modes what the accelerometer reads becomes the new gravity estimate.

The status pill shows the phase (*speeding up*, *slowing down*, *stroke over*, *at rest*).

**Tuned on a real recording** (`npm run bench:real`, see *Real recordings* below). Real strokes carry strong vibration that the simulator doesn't have: while the hand slides on the desk, acceleration above 50 Hz is about twice as strong as the hand motion itself, and it flipped the tracker between phases every few ms. So:

- the phase decisions look at a 12 Hz low-pass of the acceleration (`strokeLpHz`; the integration still uses the raw signal, where vibration averages out);
- braking, pushing again and turning only count above 25 % of the stroke's own strongest push or braking (`strokeRelFrac`), not a fixed few mg;
- each time the hand goes quiet after a stroke, the speed left over (which should be zero) says how much gravity leaked in; 20 % of it is learned and subtracted from later strokes (`strokeLeakGain`). At a reversal only the sideways part is learned. On the one real recording so far this helps a little (accel-only score 17.5 → 15.8); in the simulator it is neutral.

Simulator results (MPU-6050 noise, 3° wrist wobble, 5 seeds; `npm run verify` section 6):

| | Madgwick, integrate | Madgwick, stroke | Accel-only Kalman, integrate | Accel-only Kalman, stroke |
|---|---|---|---|---|
| Stroke end-point error | 0.20 cm | 0.09 cm | 1.68 cm | 0.99 cm |
| Direction error (excluding the 1 cm slow stroke) | ~2° | ~1° | up to 55° | mostly ≤ 5° |
| Back-and-forth strokes | 0.17 cm | 0.06 cm | 1.68 cm | 0.86 cm |
| 2 m of mousing with pauses | 1.4 cm | 0.3 cm | 9.0 cm | 2.8 cm |
| 6 s nonstop mousing | 15.8 cm | 7.4 cm | 36.8 cm | 8.4 cm |
| 2° wrist tilt at rest | 1 px | 0 px | 210 px | 0 px (peaks ~115 px, then undone) |
| Hand still 30 s | 0 px | 0 px | 0 px | 0 px |
| 5 cm stroke into the screen edge, bounce back | 570–760 px | 0 px | 540–650 px | 0 px |

Very slow strokes (1 cm over 0.5–0.8 s, peak acceleration ≈ 0.01–0.02 g) are still unreliable in both models, and often come out backwards. Everything that learns "rest" (the fusion's still-mode correction, the tracker's rest reference) slowly absorbs a push that weak, leaving only the braking. The sliders under **5b · Stroke tracker** tune all of this.

#### Rest-to-rest correction (optional)

Motion model **Stroke + rest-to-rest correction (gyro mode)** (`motionModel: 'segment'`, `../algorithms/pipeline.ts`, `segment*` settings in `config.ts`). The cursor moves live from the stroke tracker (`segLive: 'stroke'`). When the hand is at rest again (quiet gyro and a steady accelerometer), the move's acceleration is re-integrated with velocity forced to zero at both ends, and the cursor is corrected to that end point. A tilt gate skips the correction if the wrist rotated more than 6° during the move (a tilt, not a slide). It is opt-in: the default stays *plain double integration* until chosen, and the app keeps the stroke tracker. Accel-only modes are not supported well.

Results on recording 2 (settled reading, gyro mode, true 10 cm):

| | Stroke tracker | Rest-to-rest correction |
|---|---|---|
| Normal L/R | 2.4 cm | 7.3 cm |
| Slow L/R | 2.1 cm | 5.1 cm |
| Slow F/B | 5.4 cm | 10.7 cm |
| Quick F/B | 10.2 cm | 10.9 cm |
| Tilts (should be 0) | 2.4 cm | 4.9 cm |

Trade-off: the correction is visible as a snap after the hand stops (mean 1.8 cm, max about 15 cm).

### Sliding detector (4c) and steady pans

**Symptom (live):** the cursor moved when the sensor was tilted, but not when it was panned. Two causes, both reproduced in the simulator:

- **Steady pans were erased.** The stroke tracker assumed a hand never glides: 120 ms with no push and no braking meant "stopped", and the braking at the end of the pan then read as a push the other way. A 10 cm pan with a steady middle came out 0.2 cm, a 20 cm one −3 cm.
- **Slow pushes were learned as tilt.** In the ~0.13 s before a slow pan is clearly under way, the tilt-proof rest test (4b) still passed and re-levelled the push away, leaking ~15 mg into the rest of the pan (gyro mode).
- **Tilt moving the cursor** is the accelerometer-only limit: without the gyro, a tilt *is* a sideways acceleration. Gyro (Madgwick) mode tracks tilt and doesn't move.

**Fixes.** 4b now re-levels only after the normal stillness test has failed for 200 ms (a tilt error lasts; a push turns into sliding). And a **sliding detector**: when the hand slides on the desk the board vibrates (60–85 mg at 100–300 Hz on the real one, ~4 mg at rest), so the high-passed accelerometer RMS says "moving" even at steady speed. Used for: no tilt learning while sliding, strokes start only while sliding, a stroke may glide up to 1.5 s while sliding, and the "it's a tilt, undo it" rule counts only time spent pushing. On in the app; `enableSlideDetect`.

| Simulated pan (measured sensor) | Gyro mode, before | Gyro mode, now | Accel-only, now |
|---|---|---|---|
| 10 cm, steady middle | −1.7 cm | 9.8 cm | 9.8 cm |
| 20 cm, 1.2 s steady middle | 0.0 cm | 19.1 cm | −3.4 cm |
| 10 cm over 1.5 s | 1.1 cm | 5.1 cm | 4.4 cm |
| 10 cm in 0.4 s | 9.9 cm | 9.8 cm | 9.6 cm |

Costs and limits: on the real recording the score is about the same (gyro 15.8 → 14.3, accel-only 18.7 → 19.6, complementary worse); nonstop back-and-forth drifts more in simulation (4 → 12–16 cm), because the tilt filters never correct while the hand never stops sliding. Tried and dropped: ending strokes when the vibration stops. On the real data the hand vibrates ~90% of the time in back-and-forth and rolling the wrist on the desk vibrates too, so that made drift much worse.

### Real recordings

Recordings made with the **Recorder** go in `Final_Project/data/`. `npm run bench:real` replays each one through the stroke-tracker and plain-integration setups and scores the phases where the hand swung back and forth between two marks: the number of swings, the mean swing against the true length, the swing-to-swing scatter, the sideways spread and the drift. The phase times of each recording are listed at the top of `scripts/bench-real.ts`.

Recording 1 (Nov 25, 74 s): plain integration runs away by 11–50 m. The stroke tracker measures the real 10 cm swings as 10.4 ± 4.7 cm (accel-only Kalman) and 10.6 ± 4.1 cm (Madgwick) right/left, and 9.4 ± 4.9 / 11.1 ± 3.8 cm forward/back. Still weak: 15–18 cm of sideways spread in forward/back, and up to 77 cm of drift during fast nonstop back-and-forth with no pause.

### A simulator that behaves like the real sensor

The app's default sensor preset is now **MPU-6050 on the wrist (measured)**: the datasheet MPU-6050 plus what recording 1 showed. **MPU-6050** (datasheet only) is still there, and `npm run verify` sections 1–6 keep using it, so their numbers don't move.

| Real effect (recording 1) | Measured | In the simulator |
|---|---|---|
| Vibration while the hand slides on the desk | 60–85 mg on the horizontal axes, ~30 mg vertical, mostly 100–300 Hz; 2 mg at rest | band-passed noise around 200 Hz, 70 mg (`vibrationMg`), on from ~0.5 cm/s |
| The same vibration in the gyro | 2–6 °/s, most on the vertical (yaw) axis | 4 °/s (`vibrationGyroDps`) |
| Gyro bias moves after start-up | ~0.4 °/s off its start-up value | ±0.4 °/s per axis, 10 s time constant (`gyroWarmupDps`, `gyroWarmupTauS`) |
| Wrist tilt during swings | 0.3–0.4° RMS, not following the acceleration | wobble 0.8° (was 3°, about 4× too much) |
| Board mounted upside down | z reads −1 g at rest | base roll ≈ 180° (verify checks it) |

What it now reproduces: plain integration runs away by 2–3 m during nonstop swings (real: 11–15 m), while the stroke tracker drifts 4 cm. What it doesn't yet: accel-only swings come out 15.5 ± 6.6 cm for 10 cm in simulation against 10.2 ± 4.8 cm on the real recording.

Building it found a real bug: when the tracker undoes a "stroke" that was really a wrist tilt, accel-only mode took gravity from that one reading. With vibration, one reading can be 0.1 g off, which leaked up to 1 m/s² into the motion (22.8 cm of sideways spread in simulated swings). It now takes the last ~100 ms average (2.1 cm).

It also showed that this vibration alone sets off the tap detector (25 Hz high-pass, 0.2 g), and the click freeze then swallows the motion. Taps stay off until tap detection learns to tell them apart.

`runSwingTest` in `src/harness/scenarios.ts` scripts back-and-forth swings with no pause and scores them with the same `swingShape` as `npm run bench:real`, so simulated and real numbers compare directly.

## CSV format (import)

`t, ax, ay, az, gx, gy, gz[, label]`. A header row is optional; common column names are recognised.

- `t` in seconds (ms / µs are auto-detected)
- accel in **g** (m/s² and raw ±2 g LSB are auto-detected)
- gyro in **°/s**
- `label`: `index` / `pinky` (also `i`/`p`, `1`/`2`, `left`/`right`) on the rows of each tap, empty otherwise. Each contiguous labelled run counts as one ground-truth tap.

The exported IMU CSV uses the same columns plus `true_x_m, true_y_m, …`, so it re-imports directly. Labelled files can train the classifier (**Train on labels**).

Axes: x = hand right, y = forward (toward the fingers), z = up out of the back of the hand.

## Code layout

```
../algorithms/   ← the device algorithms, pure TS, no DOM — port this to C++ (see ../algorithms/README.md)
  pipeline.ts     Pipeline.step(sample) → cursor, state, tap events
  config.ts       every tunable parameter in ONE object (+ step toggles)
  fusion/         madgwick.ts, gravity.ts (accel-only gravity tracking)
  motion/stroke.ts  stroke tracker: speed-up → slow-down → halt, velocity exactly 0 between strokes
  taps/classifier.ts  tap features + classifier
  clicks/         left/right click detector, trained models, live feed and teach step
  calibration/    six-face accelerometer calibration maths
  shared/math.ts  quaternion helpers
src/sim/        ← the physics: true hand → simulated MPU-6050 readings
  imu.ts          accel = R(q)ᵀ(p̈ + g), gyro from orientation, wobble, taps, noise, offsets, drift, ADC,
                  + the measured preset: sliding vibration and gyro bias warm-up
  hand.ts         mouse-driven hand model (accel-limited) + scripted min-jerk strokes
src/harness/    ← shared by the UI and the headless tests
  session.ts      sim + pipeline + ground-truth tap matching
  scenarios.ts    stroke / drift / tap tests, A/B runner
src/ui/         ← browser front end (canvas plots, SVG charts, CSV)
  serial.ts       live input: reads the ESP32 over Web Serial and parses its readings
scripts/verify.ts       headless checks on the simulator (npm run verify)
scripts/bench-real.ts   scores the pipeline on real recordings (npm run bench:real)
```

## The pipeline (`../algorithms/pipeline.ts`)

Each step has a toggle so its effect can be shown.

1. **Calibration**: averages ~1 s of stillness to get the gyro bias and the gravity vector, and initialises orientation from it. Any accelerometer offset is absorbed into the reference "down". While the hand is still, the gyro bias keeps being refined slowly (gated so the start of a stroke is never learned as bias).
2. **Sensor fusion**: Madgwick filter. It is **adaptive**: the accelerometer corrects tilt only while the hand is still, and is skipped at the onset of a stroke, during taps, and when |a| ≠ 1 g. During strokes the filter trusts the gyro alone (optionally a slow correction after long continuous motion).
3. **Gravity removal**: rotates accel to a level frame, subtracts the reference gravity, and expresses the result in the hand's heading. The heading is latched at the last stillness, so yaw drift can't skew direction.
4. **Stillness + ZUPT**: windowed mean linear accel (relative to a slow, calm-only baseline, so a small tilt error can't block it) and gyro below thresholds for 55 ms (longer at higher estimated speed). Velocity is then forced to 0. On leaving stillness, the last window is re-integrated so the start of a stroke isn't lost.
   **4b. Tilt-proof rest test** (gyro modes): quiet gyro + steady accel + |a| ≈ 1 g for 500 ms also counts as still, and re-levels Madgwick if a tilt error is blocking the test above (see *Cursor modes*).
5. **Integration**: accel → velocity → position, with a slight velocity decay.
   **5b. Stroke tracker** (motion model *stroke*, the app's default): velocity only exists inside a stroke, which starts on a sustained push and ends at exactly zero once the braking is over (see *Motion model*).
6. **Deadzone** on tiny velocities.
7. **Speed curve**: `gain = gMin + k·ln(1 + speed/v0)` px per metre.
8. **Click freeze**: when a tap triggers, the cursor, velocity and position roll back 20 ms and hold for 80 ms.
9. **Taps**: a 2nd-order 25 Hz high-pass on accel triggers detection. A 45 ms baseline-removed window yields 12 features (signed per-axis accel peaks, gyro peaks, RMS, impact size, duration, gyro/accel ratio). A trained model (logistic regression or nearest centroid) classifies it; there is no hand-written rule.

Porting notes: the per-sample path does no allocation (except when a tap is classified). All state is fixed-size ring buffers, and all units are explicit. `PipelineConfig` maps directly to a C struct.

## Verified behaviour (`npm run verify`)

See the console output for the exact numbers. In summary:

1. **Ideal preset**: the estimated path matches the true path (≈1.6 mm mean end-point error, ≈3.5 mm RMS over 34 cm of strokes).
2. **MPU-6050, hand still for 30 s**: drift ≈ 0.003 cm with ZUPT on, ≈ 15 cm with it off.
3. **1° tilt, gravity subtraction off**: runaway of ≈ 7 m in 10 s, against 0 cm with gravity subtraction on.
4. **Tap classification**: 100 % with distinct signatures. It degrades monotonically to chance (≈ 45 %) as the similarity slider goes to 100 %.
5. **Regression check**: about 2 m of vigorous mouse-driven motion with brief pauses stays within a few cm.
6. **Motion model**: the stroke tracker beats plain double integration on stroke end-points and back-and-forth strokes in both Madgwick and accel-only Kalman modes, stays put with the hand still, and doesn't bounce off the screen edge.
7. **Measured sensor model**: with vibration, gyro warm-up and real wobble, the stroke tracker survives 12 nonstop swings (drift ~4 cm, sideways ~2 cm) where plain integration runs away by 2–3 m, and it works the same with the sensor upside down.

## Known, real limitations the simulation shows

- An accelerometer can't tell constant velocity from rest. Very slow or very steady moves are shortened by the zero-velocity reset; for example, the "1 cm slow" stroke comes out about 15–20 % short.
- With no pause at all, pure dead-reckoning error grows quickly: several cm to tens of cm over 6 s of nonstop vigorous motion with MPU-6050 noise and drift.
- A fast flick (≳ 1 g, e.g. 3 cm in 0.12 s) sets off the tap detector, so the cursor freezes instead of moving. Tap detection doesn't yet tell flicks from finger taps.
- If the gyro is not calibrated (MPU-6050 offsets up to ±20 °/s), the device is unusable. The ablation sweep makes this obvious.
