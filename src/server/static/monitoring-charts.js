// Pure string-returning inline-SVG chart builders for the cockpit monitoring
// panel. Design constraints (dataviz skill):
// - every color is a CSS variable so charts inherit the app theme (no hex here);
// - minimal ink: a baseline, the marks, and at most three sparse labels;
// - NaN-safe: empty, single-point, and flat series degrade to a flat/empty
//   state — no NaN ever reaches an SVG attribute;
// - every <svg> carries role="img" and an aria-label.

function escAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteSeries(values) {
  return (Array.isArray(values) ? values : [])
    .map(value => Number(value))
    .filter(value => Number.isFinite(value));
}

/**
 * Tiny trend line for a KPI tile. Empty input renders a muted baseline;
 * a single sample or a flat series renders a flat line at mid-height.
 */
export function renderSparkline(values, { width, height, ariaLabel } = {}) {
  const w = positiveOr(width, 120);
  const h = positiveOr(height, 24);
  const pad = 2;
  const series = finiteSeries(values);
  const open = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" ` +
    `aria-label="${escAttr(ariaLabel || 'trend sparkline')}" preserveAspectRatio="none">`;
  if (series.length === 0) {
    return `${open}<line x1="${pad}" y1="${round2(h - pad)}" x2="${round2(w - pad)}" y2="${round2(h - pad)}" ` +
      `stroke="var(--border)" stroke-width="1"/></svg>`;
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;
  if (series.length === 1 || range === 0) {
    // No trend to draw — a flat line at mid-height, never a divide-by-zero.
    return `${open}<line x1="${pad}" y1="${round2(h / 2)}" x2="${round2(w - pad)}" y2="${round2(h / 2)}" ` +
      `stroke="var(--accent-2)" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  const points = series.map((value, index) => {
    const x = pad + (index / (series.length - 1)) * (w - pad * 2);
    const y = (h - pad) - ((value - min) / range) * (h - pad * 2);
    return `${round2(x)},${round2(y)}`;
  }).join(' ');
  return `${open}<polyline fill="none" stroke="var(--accent-2)" stroke-width="1.5" ` +
    `stroke-linejoin="round" stroke-linecap="round" points="${points}"/></svg>`;
}

function shortDateLabel(label) {
  const text = String(label || '');
  // 2026-07-04 → 07-04; anything else passes through untouched.
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(5, 10) : text;
}

/**
 * Baseline-anchored bar chart (e.g. calls/day) with an optional overlay series
 * (e.g. errors) drawn from the same baseline in the error color. Points are
 * objects; `valueKey`/`overlayKey` pick the numeric fields and `date` labels
 * the x axis sparsely (first / middle / last only).
 */
export function renderBarChart(points, { valueKey = 'calls', overlayKey, ariaLabel, width, height } = {}) {
  const w = positiveOr(width, 280);
  const h = positiveOr(height, 72);
  const labelBand = 12;
  const pad = 2;
  const plotH = h - labelBand - pad;
  const baselineY = round2(pad + plotH);
  const rows = (Array.isArray(points) ? points : [])
    .filter(point => point && typeof point === 'object')
    .map(point => ({
      label: typeof point.date === 'string' ? point.date : '',
      value: Math.max(0, Number.isFinite(Number(point[valueKey])) ? Number(point[valueKey]) : 0),
      overlay: overlayKey
        ? Math.max(0, Number.isFinite(Number(point[overlayKey])) ? Number(point[overlayKey]) : 0)
        : 0,
    }));
  const open = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" ` +
    `aria-label="${escAttr(ariaLabel || 'bar chart')}">`;
  const baseline = `<line x1="0" y1="${baselineY}" x2="${w}" y2="${baselineY}" ` +
    `stroke="var(--border)" stroke-width="1"/>`;
  if (rows.length === 0) return `${open}${baseline}</svg>`;

  const max = Math.max(...rows.map(row => Math.max(row.value, row.overlay)));
  const slot = w / rows.length;
  const gap = Math.min(2, slot * 0.2);
  const barW = round2(Math.max(1, slot - gap));
  const barHeight = value => {
    if (!(max > 0) || value <= 0) return 0;
    // Keep any non-zero value visible at panel width.
    return Math.max(1, round2((value / max) * plotH));
  };
  const bars = rows.map((row, index) => {
    const x = round2(index * slot + gap / 2);
    const valueH = barHeight(row.value);
    const overlayH = barHeight(row.overlay);
    const title = `<title>${escAttr(`${row.label || `#${index + 1}`}: ${row.value} ${valueKey}` +
      (overlayKey ? `, ${row.overlay} ${overlayKey}` : ''))}</title>`;
    const valueRect = valueH > 0
      ? `<rect x="${x}" y="${round2(baselineY - valueH)}" width="${barW}" height="${valueH}" rx="1" fill="var(--accent)"/>`
      : '';
    const overlayRect = overlayH > 0
      ? `<rect x="${x}" y="${round2(baselineY - overlayH)}" width="${barW}" height="${overlayH}" rx="1" fill="var(--error)"/>`
      : '';
    return `<g>${title}${valueRect}${overlayRect}</g>`;
  }).join('');

  const labelIndexes = new Set([0, rows.length - 1]);
  if (rows.length > 4) labelIndexes.add(Math.floor((rows.length - 1) / 2));
  const labels = rows.map((row, index) => {
    if (!labelIndexes.has(index) || !row.label) return '';
    const anchor = index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle';
    const x = index === 0 ? 0 : index === rows.length - 1 ? w : round2(index * slot + slot / 2);
    return `<text x="${x}" y="${h - 2}" text-anchor="${anchor}" font-size="8" ` +
      `fill="var(--text2)">${escAttr(shortDateLabel(row.label))}</text>`;
  }).join('');

  return `${open}${baseline}${bars}${labels}</svg>`;
}
