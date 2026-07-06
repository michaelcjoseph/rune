export interface SparklineOptions {
  width?: number;
  height?: number;
  ariaLabel?: string;
}

export function renderSparkline(
  values: ReadonlyArray<number | null | undefined> | null | undefined,
  options?: SparklineOptions,
): string;

export interface BarChartOptions {
  valueKey?: string;
  overlayKey?: string;
  ariaLabel?: string;
  width?: number;
  height?: number;
}

export function renderBarChart(
  points: ReadonlyArray<Record<string, unknown>> | null | undefined,
  options?: BarChartOptions,
): string;
