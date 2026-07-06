import { describe, expect, it } from 'vitest';
import { renderBarChart, renderSparkline } from './monitoring-charts.js';

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;

function expectSafeSvg(svg: string, ariaLabel?: string) {
  expect(svg).toMatch(/^<svg /);
  expect(svg).toMatch(/<\/svg>$/);
  expect(svg).not.toContain('NaN');
  expect(svg).not.toContain('Infinity');
  expect(svg).not.toContain('undefined');
  expect(svg).toMatch(/role="img"/);
  expect(svg).toMatch(/aria-label="[^"]+"/);
  if (ariaLabel) expect(svg).toContain(`aria-label="${ariaLabel}"`);
  // Theme rule: chart colors are CSS variables only — never hardcoded hex.
  expect(svg).not.toMatch(HEX_COLOR);
}

describe('renderSparkline', () => {
  it('renders a normal series as a themed polyline with no NaN attributes', () => {
    const svg = renderSparkline([0, 4, 2, 9, 5], { ariaLabel: 'Hourly MCP calls' });
    expectSafeSvg(svg, 'Hourly MCP calls');
    expect(svg).toContain('<polyline');
    expect(svg).toContain('stroke="var(--accent-2)"');
  });

  it('renders an empty series as a muted baseline instead of NaN coordinates', () => {
    const svg = renderSparkline([], { ariaLabel: 'empty series' });
    expectSafeSvg(svg, 'empty series');
    expect(svg).toContain('<line');
    expect(svg).toContain('var(--border)');
    expect(svg).not.toContain('<polyline');
  });

  it('renders a single-point series as a flat line', () => {
    const svg = renderSparkline([7], { ariaLabel: 'single point' });
    expectSafeSvg(svg, 'single point');
    expect(svg).toContain('<line');
    expect(svg).toContain('var(--accent-2)');
  });

  it('renders a flat series (zero range) without dividing by zero', () => {
    const svg = renderSparkline([3, 3, 3, 3], { ariaLabel: 'flat series' });
    expectSafeSvg(svg, 'flat series');
    expect(svg).toContain('<line');
  });

  it('drops non-finite values and still renders', () => {
    const svg = renderSparkline([1, NaN, Infinity, null, 4], { ariaLabel: 'dirty series' });
    expectSafeSvg(svg, 'dirty series');
  });

  it('tolerates missing values and options entirely', () => {
    expectSafeSvg(renderSparkline(undefined));
    expectSafeSvg(renderSparkline([1, 2, 3]));
  });

  it('escapes the aria-label', () => {
    const svg = renderSparkline([1, 2], { ariaLabel: 'a "quoted" <label>' });
    expect(svg).toContain('aria-label="a &quot;quoted&quot; &lt;label&gt;"');
  });
});

describe('renderBarChart', () => {
  const days = Array.from({ length: 14 }, (_, index) => ({
    date: `2026-06-${String(16 + index).padStart(2, '0')}`,
    calls: (index * 7) % 23,
    errors: index % 3,
  }));

  it('renders bars in the accent token with an error overlay in the error token', () => {
    const svg = renderBarChart(days, { valueKey: 'calls', overlayKey: 'errors', ariaLabel: 'calls per day' });
    expectSafeSvg(svg, 'calls per day');
    expect(svg).toContain('fill="var(--accent)"');
    expect(svg).toContain('fill="var(--error)"');
  });

  it('renders sparse date labels in the muted text token', () => {
    const svg = renderBarChart(days, { valueKey: 'calls', ariaLabel: 'labels' });
    const labels = svg.match(/<text /g) || [];
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThanOrEqual(3);
    expect(svg).toContain('fill="var(--text2)"');
    expect(svg).toContain('06-16');
    expect(svg).toContain('06-29');
  });

  it('renders an empty series as a bare baseline with no NaN', () => {
    const svg = renderBarChart([], { ariaLabel: 'no data yet' });
    expectSafeSvg(svg, 'no data yet');
    expect(svg).not.toContain('<rect');
  });

  it('renders an all-zero (flat) series without zero-height artifacts or NaN', () => {
    const svg = renderBarChart(
      [{ date: '2026-07-01', calls: 0 }, { date: '2026-07-02', calls: 0 }],
      { valueKey: 'calls', ariaLabel: 'flat zero' },
    );
    expectSafeSvg(svg, 'flat zero');
    expect(svg).not.toContain('<rect');
  });

  it('renders a single point without NaN', () => {
    const svg = renderBarChart([{ date: '2026-07-04', calls: 5, errors: 1 }], {
      valueKey: 'calls',
      overlayKey: 'errors',
      ariaLabel: 'single day',
    });
    expectSafeSvg(svg, 'single day');
    expect(svg).toContain('fill="var(--accent)"');
  });

  it('coerces malformed points to zero instead of emitting NaN', () => {
    const svg = renderBarChart(
      [{ date: '2026-07-01', calls: 'oops' }, null, { calls: 12 }] as unknown as Array<Record<string, unknown>>,
      { valueKey: 'calls', ariaLabel: 'dirty points' },
    );
    expectSafeSvg(svg, 'dirty points');
  });
});
