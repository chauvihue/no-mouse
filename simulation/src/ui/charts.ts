// SVG charts for the A/B comparison, ablation sweep, classifier and test results.
// Colours come from CSS variables, so they follow the theme. Every mark carries
// a data-tip that the shared tooltip shows on hover.

import type { ABResult, StrokeRun, DriftRun } from '../harness/scenarios.ts';
import type { LabeledFeatures } from '../pipeline/classifier.ts';
import { FEATURE_NAMES, TapClassifier } from '../pipeline/classifier.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
export function fmtNum(v: number, unit = ''): string {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : a >= 0.01 ? v.toFixed(3) : a === 0 ? '0' : a >= 1e-4 ? v.toPrecision(2) : '< 0.0001';
  return unit ? `${s} ${unit}` : s;
}

/** One shared hover tooltip for every [data-tip] element on the page. */
export function installTooltip(): void {
  const tip = document.createElement('div');
  tip.className = 'tip hidden';
  document.body.appendChild(tip);
  document.addEventListener('mousemove', e => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]');
    if (!el) { tip.classList.add('hidden'); return; }
    tip.innerHTML = el.getAttribute('data-tip')!;
    tip.classList.remove('hidden');
    const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14);
    tip.style.left = x + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
}

// ───────────────────────── A/B small multiples ─────────────────────────

export function abChart(r: ABResult): string {
  const groups = [...new Set(r.metrics.map(m => m.group))];
  const W = 860, labelW = 230, valW = 120, barW = W - labelW - valW - 10;
  let html = `<div class="card chartcard"><h3>${esc(r.stepLabel)}: off (A) vs on (B)</h3>
    <div class="legend"><span><i style="background:var(--s2);height:9px"></i>A — step OFF</span><span><i style="background:var(--s1);height:9px"></i>B — step ON</span>
    <span>mean of ${r.repeats} seeded run${r.repeats > 1 ? 's' : ''}; whisker = ±1 SD; each metric has its own scale</span></div>`;
  for (const g of groups) {
    const ms = r.metrics.filter(m => m.group === g);
    const rowH = 46, H = ms.length * rowH + 8;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(g)}">`;
    ms.forEach((m, i) => {
      const y = 4 + i * rowH;
      const max = Math.max(m.a.mean + m.a.std, m.b.mean + m.b.std, 1e-9);
      const better = m.lowerIsBetter ? (m.b.mean < m.a.mean ? 'B' : m.b.mean > m.a.mean ? 'A' : '') : (m.b.mean > m.a.mean ? 'B' : m.b.mean < m.a.mean ? 'A' : '');
      svg += `<text x="0" y="${y + 17}">${esc(m.label)}</text>`;
      const ratio = m.lowerIsBetter && m.b.mean > 0 ? m.a.mean / m.b.mean : NaN;
      if (isFinite(ratio) && ratio >= 1.5) svg += `<text class="muted" x="0" y="${y + 34}">B is ${ratio >= 100 ? fmtNum(ratio) : ratio.toFixed(1)}× lower</text>`;
      else if (better) svg += `<text class="muted" x="0" y="${y + 34}">better: ${better}</text>`;
      ([['A', m.a, 'var(--s2)', y + 4], ['B', m.b, 'var(--s1)', y + 22]] as const).forEach(([name, a, col, by]) => {
        const w = Math.max(2, (a.mean / max) * barW);
        const tip = `<b>${esc(m.label)}</b><br>${name} (step ${name === 'A' ? 'off' : 'on'}): ${fmtNum(a.mean, m.unit)} ± ${fmtNum(a.std)}<br>runs: ${a.values.map(v => fmtNum(v)).join(', ')}`;
        svg += `<rect class="bar" x="${labelW}" y="${by}" width="${w}" height="16" rx="3" fill="${col}" data-tip="${esc(tip)}"/>`;
        if (a.std > 0) {
          const x1 = labelW + Math.max(0, (a.mean - a.std) / max * barW), x2 = labelW + Math.min(barW, (a.mean + a.std) / max * barW);
          svg += `<line x1="${x1}" x2="${x2}" y1="${by + 8}" y2="${by + 8}" stroke="var(--ink)" stroke-width="1.5" opacity=".55"/>`;
        }
        svg += `<text x="${labelW + barW + 8}" y="${by + 13}">${name}: ${fmtNum(a.mean, m.unit)}</text>`;
      });
    });
    svg += '</svg>';
    html += `<div class="subhead">${esc(g)}</div>${svg}`;
  }
  // table view
  html += `<details><summary class="hint">Table view</summary><table><tr><th>Metric</th><th>A (off)</th><th>B (on)</th><th>unit</th></tr>` +
    r.metrics.map(m => `<tr><td>${esc(m.label)}</td><td>${fmtNum(m.a.mean)} ± ${fmtNum(m.a.std)}</td><td>${fmtNum(m.b.mean)} ± ${fmtNum(m.b.std)}</td><td>${m.unit}</td></tr>`).join('') +
    `</table></details></div>`;
  return html;
}

// ───────────────────────── Ablation sweep ─────────────────────────

export interface AblationRow { label: string; endErrCm: number; driftCm: number; jumpPx: number; acc: number }

export function ablationChart(rows: AblationRow[], repeats: number, driftS: number): string {
  const W = 900, labelW = 190, panelGap = 18;
  const panels: { key: keyof AblationRow; title: string; unit: string }[] = [
    { key: 'endErrCm', title: 'Stroke end-point error', unit: 'cm' },
    { key: 'driftCm', title: `Drift, ${driftS} s still`, unit: 'cm' },
    { key: 'jumpPx', title: 'Cursor jump per tap', unit: 'px' },
  ];
  const pw = (W - labelW - panelGap * (panels.length - 1)) / panels.length;
  const rowH = 26, top = 34, H = top + rows.length * rowH + 22;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ablation sweep">`;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    if (i === 0) svg += `<rect x="0" y="${y - 3}" width="${W}" height="${rowH}" fill="var(--surface-2)" rx="4"/>`;
    svg += `<text x="4" y="${y + 14}" ${i === 0 ? 'font-weight="600"' : ''}>${esc(r.label)}</text>`;
  });
  panels.forEach((p, pi) => {
    const x0 = labelW + pi * (pw + panelGap);
    const vals = rows.map(r => r[p.key] as number).filter(v => isFinite(v));
    const lo = Math.max(1e-3, Math.min(...vals.filter(v => v > 0), 0.01));
    const hi = Math.max(...vals, lo * 10);
    const l0 = Math.log10(lo) - 0.2, l1 = Math.log10(hi) + 0.1;
    const sx = (v: number) => x0 + ((Math.log10(Math.max(v, lo)) - l0) / (l1 - l0)) * (pw - 54);
    svg += `<text x="${x0}" y="14" font-weight="600">${p.title}</text><text class="muted" x="${x0}" y="27">${p.unit}, log scale</text>`;
    // decade gridlines
    const decades = Math.floor(l1) - Math.ceil(l0) + 1;
    const every = Math.max(1, Math.ceil(decades / 4));
    for (let d = Math.ceil(l0); d <= Math.floor(l1); d += every) {
      const gx = sx(10 ** d);
      svg += `<line x1="${gx}" x2="${gx}" y1="${top - 4}" y2="${H - 18}" stroke="var(--grid)"/><text class="muted" x="${gx}" y="${H - 5}" text-anchor="middle" font-size="10">${d >= 0 && d <= 4 ? 10 ** d : d < 0 && d >= -2 ? (10 ** d).toFixed(-d) : `1e${d}`}</text>`;
    }
    rows.forEach((r, i) => {
      const v = r[p.key] as number;
      const y = top + i * rowH;
      const base = rows[0][p.key] as number;
      const worse = i > 0 && v > base * 1.5 + 1e-6;
      const col = i === 0 ? 'var(--s1)' : worse ? 'var(--s2)' : 'var(--muted)';
      const w = Math.max(2, sx(v) - x0);
      const tip = `<b>${esc(r.label)}</b><br>${p.title}: ${fmtNum(v, p.unit)}${i > 0 && base > 0 ? `<br>${(v / base).toFixed(v / base >= 10 ? 0 : 1)}× the all-on value` : ''}`;
      svg += `<rect class="bar" x="${x0}" y="${y}" width="${w}" height="16" rx="3" fill="${col}" data-tip="${esc(tip)}"/>`;
      svg += `<text x="${x0 + w + 4}" y="${y + 13}" font-size="11">${fmtNum(v)}</text>`;
    });
  });
  svg += '</svg>';
  return `<div class="card chartcard"><h3>Ablation: what each pipeline step buys you</h3>
  <div class="legend"><span><i style="background:var(--s1);height:9px"></i>all steps on</span><span><i style="background:var(--s2);height:9px"></i>step off — ≥1.5× worse</span><span><i style="background:var(--muted);height:9px"></i>step off — no clear effect</span><span>mean of ${repeats} seeded run${repeats > 1 ? 's' : ''}</span></div>
  ${svg}
  <details><summary class="hint">Table view</summary><table><tr><th>Configuration</th><th>end-point err (cm)</th><th>drift (cm)</th><th>jump/tap (px)</th><th>finger acc. (%)</th></tr>
  ${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${fmtNum(r.endErrCm)}</td><td>${fmtNum(r.driftCm)}</td><td>${fmtNum(r.jumpPx)}</td><td>${fmtNum(r.acc)}</td></tr>`).join('')}</table></details></div>`;
}

// ───────────────────────── Classifier ─────────────────────────

export function confusionHTML(cm: number[][], extra?: { missedI?: number; missedP?: number; falseN?: number }): string {
  const n = cm.flat().reduce((s, v) => s + v, 0);
  const acc = n ? ((cm[0][0] + cm[1][1]) / n * 100).toFixed(1) + ' %' : '—';
  const cell = (v: number, diag: boolean, row: number[]) => {
    const tot = row.reduce((s, x) => s + x, 0);
    const pct = tot ? v / tot : 0;
    const bg = diag ? `color-mix(in srgb, var(--s1) ${Math.round(pct * 70)}%, transparent)` : `color-mix(in srgb, var(--s2) ${Math.round(pct * 70)}%, transparent)`;
    return `<td class="${diag ? 'diag' : ''}" style="background:${bg}">${v}</td>`;
  };
  const showMiss = extra && (extra.missedI !== undefined);
  return `<table class="cm"><tr><th>truth ↓ / predicted →</th><th><span class="dot" style="background:var(--s7)"></span>index</th><th><span class="dot" style="background:var(--s5)"></span>pinky</th>${showMiss ? '<th>missed</th>' : ''}</tr>
    <tr><th>index</th>${cell(cm[0][0], true, cm[0])}${cell(cm[0][1], false, cm[0])}${showMiss ? `<td>${extra!.missedI}</td>` : ''}</tr>
    <tr><th>pinky</th>${cell(cm[1][0], false, cm[1])}${cell(cm[1][1], true, cm[1])}${showMiss ? `<td>${extra!.missedP}</td>` : ''}</tr></table>
    <div class="kpis"><div class="kpi"><div class="k">accuracy</div><div class="v">${acc}</div></div><div class="kpi"><div class="k">classified taps</div><div class="v">${n}</div></div>
    ${extra?.falseN !== undefined ? `<div class="kpi"><div class="k">false detections</div><div class="v">${extra.falseN}</div></div>` : ''}</div>`;
}

export function scatterSVG(data: LabeledFeatures[]): string {
  if (data.length < 4) return '';
  const fs = TapClassifier.fisherScores(data);
  const order = fs.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const [fx, fy] = [order[0][1], order[1][1]];
  const W = 420, H = 300, m = 40;
  const xs = data.map(d => d.x[fx]), ys = data.map(d => d.x[fy]);
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const sx = (v: number) => m + (v - x0) / (x1 - x0) * (W - m - 10), sy = (v: number) => H - m + 10 - (v - y0) / (y1 - y0) * (H - m - 10);
  let svg = `<svg class="fixed" viewBox="0 0 ${W} ${H}" role="img" aria-label="Training taps scatter">`;
  svg += `<line x1="${m}" x2="${W - 10}" y1="${H - m + 10}" y2="${H - m + 10}" stroke="var(--axis)"/><line x1="${m}" x2="${m}" y1="10" y2="${H - m + 10}" stroke="var(--axis)"/>`;
  svg += `<text x="${W / 2}" y="${H - 6}" text-anchor="middle" class="muted">${FEATURE_NAMES[fx]}</text>`;
  svg += `<text x="12" y="${H / 2}" transform="rotate(-90 12 ${H / 2})" text-anchor="middle" class="muted">${FEATURE_NAMES[fy]}</text>`;
  svg += `<text x="${m}" y="${H - m + 24}" class="muted" font-size="10">${fmtNum(x0)}</text><text x="${W - 10}" y="${H - m + 24}" class="muted" font-size="10" text-anchor="end">${fmtNum(x1)}</text>`;
  svg += `<text x="${m - 4}" y="${H - m + 10}" class="muted" font-size="10" text-anchor="end">${fmtNum(y0)}</text><text x="${m - 4}" y="16" class="muted" font-size="10" text-anchor="end">${fmtNum(y1)}</text>`;
  data.forEach(d => {
    const col = d.y === 'index' ? 'var(--s7)' : 'var(--s5)';
    svg += `<circle cx="${sx(d.x[fx])}" cy="${sy(d.x[fy])}" r="5" fill="${col}" stroke="var(--surface)" stroke-width="2" data-tip="${d.y}: ${FEATURE_NAMES[fx]} ${fmtNum(d.x[fx])}, ${FEATURE_NAMES[fy]} ${fmtNum(d.x[fy])}"/>`;
  });
  svg += '</svg>';
  return `<div class="chartcard"><div class="legend"><span><i style="background:var(--s7);height:9px"></i>index</span><span><i style="background:var(--s5);height:9px"></i>pinky</span><span>2 most separating features (Fisher score)</span></div>${svg}</div>`;
}

function pad(a: number, b: number): [number, number] {
  const s = (b - a) || Math.abs(a) || 1;
  return [a - s * 0.08, b + s * 0.08];
}

// ───────────────────────── Test results ─────────────────────────

export function strokePathSVG(run: StrokeRun): string {
  const W = 520, H = 300, m = 30;
  const pts = run.path;
  const xs = pts.flatMap(p => [p.tx, p.ex]), ys = pts.flatMap(p => [p.ty, p.ey]);
  let [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  // equal aspect
  const sc = Math.min((W - 2 * m) / (x1 - x0), (H - 2 * m) / (y1 - y0));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const sx = (v: number) => W / 2 + (v - cx) * sc, sy = (v: number) => H / 2 - (v - cy) * sc;
  const line = (f: (p: typeof pts[0]) => [number, number], col: string, dash = '') =>
    `<polyline fill="none" stroke="${col}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ''} points="${pts.map(p => { const [x, y] = f(p); return `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`; }).join(' ')}"/>`;
  // 1 cm scale bar
  const bar = `<line x1="${W - m - sc * 0.01}" x2="${W - m}" y1="${H - 12}" y2="${H - 12}" stroke="var(--ink)" stroke-width="2"/><text x="${W - m}" y="${H - 18}" text-anchor="end" class="muted" font-size="11">1 cm</text>`;
  void x0; void x1; void y0; void y1;
  return `<div class="chartcard"><div class="legend"><span><i style="background:var(--true);height:3px"></i>true hand path</span><span><i style="background:var(--est);height:3px"></i>estimated path</span></div>
    <svg class="fixed" viewBox="0 0 ${W} ${H}" role="img" aria-label="True vs estimated stroke path">${line(p => [p.tx, p.ty], 'var(--true)')}${line(p => [p.ex, p.ey], 'var(--est)', '6 3')}${bar}</svg></div>`;
}

export function driftSVG(run: DriftRun): string {
  const W = 520, H = 200, m = 40;
  const s = run.series;
  if (s.length < 2) return '';
  const ymax = Math.max(0.1, ...s.map(p => p.cm)) * 1.1, tmax = s[s.length - 1].t || 1;
  const sx = (t: number) => m + t / tmax * (W - m - 10), sy = (v: number) => H - 24 - v / ymax * (H - 34);
  return `<div class="chartcard"><svg class="fixed" viewBox="0 0 ${W} ${H}" role="img" aria-label="Drift over time">
    <line x1="${m}" x2="${W - 10}" y1="${H - 24}" y2="${H - 24}" stroke="var(--axis)"/>
    <text x="${m - 4}" y="${sy(ymax / 1.1) + 4}" text-anchor="end" class="muted" font-size="10">${fmtNum(ymax / 1.1)}</text>
    <text x="${m - 4}" y="${H - 24}" text-anchor="end" class="muted" font-size="10">0</text>
    <text x="${W - 10}" y="${H - 8}" text-anchor="end" class="muted" font-size="11">${tmax.toFixed(0)} s</text>
    <text x="${m}" y="12" class="muted" font-size="11">estimated drift (cm) while the hand is perfectly still</text>
    <polyline fill="none" stroke="var(--s1)" stroke-width="2" points="${s.map(p => `${sx(p.t).toFixed(1)},${sy(p.cm).toFixed(1)}`).join(' ')}"/></svg></div>`;
}
