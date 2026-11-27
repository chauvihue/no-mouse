// Live input: read the real MPU-6050 from the ESP32 over USB serial with the
// Web Serial API (Chrome / Edge only). The firmware prints one reading per line,
//
//   t,ax,ay,az,gx,gy,gz        t in s, accel in g, gyro in °/s
//
// after a header line with those names. Lines starting with '#' are status
// messages from the firmware; anything else (boot text) is skipped.

import type { ImuSample } from '../../../algorithms/pipeline.ts';

// Anything beyond the largest MPU-6050 ranges (±16 g, ±2000 °/s) can't be a real reading.
const MAX_ACCEL_G = 16.5;
const MAX_GYRO_DPS = 2050;

/** Parses one serial line into a reading, or returns null if the line isn't a valid one. */
export function parseSerialLine(line: string): ImuSample | null {
  const cells = line.trim().split(',');
  if (cells.length !== 7 || cells.some(c => c.trim() === '')) return null;
  const v = cells.map(Number);
  if (v.some(x => !Number.isFinite(x))) return null;
  if (Math.abs(v[1]) > MAX_ACCEL_G || Math.abs(v[2]) > MAX_ACCEL_G || Math.abs(v[3]) > MAX_ACCEL_G) return null;
  if (Math.abs(v[4]) > MAX_GYRO_DPS || Math.abs(v[5]) > MAX_GYRO_DPS || Math.abs(v[6]) > MAX_GYRO_DPS) return null;
  return { t: v[0], ax: v[1], ay: v[2], az: v[3], gx: v[4], gy: v[5], gz: v[6] };
}

/**
 * Turns raw serial text into readings, dropping anything damaged in transit.
 *
 * When the computer falls behind (a busy browser tab), the operating system drops
 * serial bytes. Where a run of bytes is lost, the start of one line gets glued to
 * the end of a later one. If the glued line still has 7 numbers it parses fine but
 * carries wrong values, and those showed up as multi-g spikes on a sensor at rest.
 * A glued line keeps the timestamp of the first line, so the reading after it
 * always jumps forward in time. So each reading is held back by one sample and
 * dropped if the next one doesn't follow it at the normal sample interval.
 * (A genuine gap, e.g. the firmware restarting its FIFO, also drops one reading.)
 */
export class SerialStreamParser {
  received = 0;      // readings passed on
  badLines = 0;      // damaged lines dropped (unparseable, out of range, or glued)
  sensorNotes = 0;   // '#' status lines from the firmware (bad I2C read, FIFO overflow)
  lastSensorNote = '';
  private readonly emit: (s: ImuSample) => void;
  private pending = '';
  private held: ImuSample | null = null;
  private nominalDt = 0; // the sample interval, learned from the stream

  constructor(emit: (s: ImuSample) => void) { this.emit = emit; }

  /** Feeds the next piece of decoded serial text. */
  push(text: string): void {
    this.pending += text;
    let nl: number;
    while ((nl = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.line(line);
    }
    if (this.pending.length > 1024) this.pending = ''; // no line breaks at all: wrong baud rate
  }

  /** Data was lost (a receive error): nothing on either side of the gap can be trusted. */
  dataLost(): void {
    this.pending = '';
    if (this.held) { this.held = null; this.badLines++; }
  }

  private line(line: string): void {
    const s = parseSerialLine(line);
    if (s) { this.accept(s); return; }
    if (line.startsWith('#')) { this.sensorNotes++; this.lastSensorNote = line.slice(1).trim(); return; }
    // boot text and the header aren't damage; count only once the stream has started
    if ((this.received > 0 || this.held) && line.trim() && !line.startsWith('t,')) this.badLines++;
  }

  private accept(s: ImuSample): void {
    const h = this.held;
    this.held = s;
    if (!h) return;
    const dt = s.t - h.t;
    if (this.nominalDt === 0) { // first pair: learn the interval
      if (dt > 0) this.nominalDt = dt;
      this.pass(h);
      return;
    }
    if (dt > 0 && Math.abs(dt - this.nominalDt) <= 0.5 * this.nominalDt) {
      this.nominalDt += (dt - this.nominalDt) * 0.05;
      this.pass(h);
    } else {
      this.badLines++; // h sits right before a jump in time: likely glued from a lost chunk
    }
  }

  private pass(s: ImuSample): void { this.received++; this.emit(s); }
}

// The parts of the Web Serial API used here (TypeScript's DOM types don't include it).
export interface WebSerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
}
interface WebSerial {
  requestPort(): Promise<WebSerialPort>;
  getPorts(): Promise<WebSerialPort[]>;
}
const webSerial = (): WebSerial | undefined => (navigator as Navigator & { serial?: WebSerial }).serial;

export const BAUD_RATE = 921600; // 1000 lines/s of ~48 characters needs more than 115200 baud
// The browser's default receive buffer is 255 bytes, about 5 ms of this stream: any hiccup
// on the page overflows it and the operating system drops data. 64 KB covers over a second.
const BUFFER_SIZE = 1 << 16;
const MAX_QUEUE = 20000; // readings kept if the UI stops draining the queue

export class SerialImuLink {
  /** Parsed readings waiting to be fed to the pipeline; the UI drains it every frame. */
  readonly queue: ImuSample[] = [];
  lastDataAt = 0; // performance.now() of the last reading
  serialErrors = 0; // receive errors such as a buffer overrun (data was lost)
  /** Called once the port has closed: error is null when disconnect() closed it. */
  onClose: ((error: string | null) => void) | null = null;
  private parser = this.newParser();
  private port: WebSerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;

  static get supported(): boolean { return !!webSerial(); }

  /** The port this page was already allowed to use, so it can reconnect without the chooser. */
  static async rememberedPort(): Promise<WebSerialPort | null> {
    const ports = (await webSerial()?.getPorts()) ?? [];
    return ports.length === 1 ? ports[0] : null;
  }

  get connected(): boolean { return this.port !== null; }
  // health counters, so lost or damaged data is visible instead of silently skipped
  get received(): number { return this.parser.received; }
  get badLines(): number { return this.parser.badLines; }
  get sensorNotes(): number { return this.parser.sensorNotes; }
  get lastSensorNote(): string { return this.parser.lastSensorNote; }

  private newParser(): SerialStreamParser {
    return new SerialStreamParser(s => {
      this.queue.push(s);
      if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
      this.lastDataAt = performance.now();
    });
  }

  /** Opens `port`, or asks the user to pick one (only allowed from a click). */
  async connect(port?: WebSerialPort): Promise<void> {
    const api = webSerial();
    if (!api) throw new Error('this browser has no Web Serial support (use Chrome or Edge)');
    const p = port ?? (await api.requestPort());
    await p.open({ baudRate: BAUD_RATE, bufferSize: BUFFER_SIZE });
    // ESP32 dev boards wire DTR/RTS to the chip's boot and reset pins. Release both so
    // the board runs its sketch instead of sitting in reset or in the bootloader.
    await p.setSignals({ dataTerminalReady: false, requestToSend: false });
    this.port = p;
    this.closing = false;
    this.queue.length = 0;
    this.parser = this.newParser();
    this.serialErrors = 0;
    this.lastDataAt = performance.now();
    void this.readLoop(p);
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* already closed */ }
  }

  private async readLoop(p: WebSerialPort): Promise<void> {
    const decoder = new TextDecoder();
    let error: string | null = null;
    // A non-fatal error (framing, overrun) replaces p.readable and reading carries on;
    // unplugging the board sets it to null and ends the loop.
    while (p.readable && !this.closing) {
      const reader = p.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.parser.push(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        error = (e as Error).message;
        this.serialErrors++;
        this.parser.dataLost();
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
    }
    try { await p.close(); } catch { /* already gone */ }
    this.port = null;
    this.onClose?.(this.closing ? null : (error ?? 'the serial port closed'));
  }
}
