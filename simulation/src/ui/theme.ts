// Canvas drawing reads its colours from the CSS custom properties so the
// canvases follow the light/dark theme exactly like the HTML does.

export interface Theme {
  surface: string; surface2: string; ink: string; ink2: string; muted: string; grid: string; axis: string;
  s1: string; s2: string; s3: string; s5: string; s7: string;
  good: string; warn: string; crit: string; target: string; cursor: string; true: string; est: string;
}

let cached: Theme | null = null;

export function theme(): Theme {
  if (cached) return cached;
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  cached = {
    surface: v('--surface'), surface2: v('--surface-2'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'),
    grid: v('--grid'), axis: v('--axis'), s1: v('--s1'), s2: v('--s2'), s3: v('--s3'), s5: v('--s5'), s7: v('--s7'),
    good: v('--good'), warn: v('--warn'), crit: v('--crit'), target: v('--target'), cursor: v('--cursor'),
    true: v('--true'), est: v('--est'),
  };
  return cached;
}

export function invalidateTheme(): void { cached = null; }

export function fingerColor(f: 'index' | 'pinky' | null): string {
  const t = theme();
  return f === 'index' ? t.s7 : f === 'pinky' ? t.s5 : t.muted;
}

export function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
