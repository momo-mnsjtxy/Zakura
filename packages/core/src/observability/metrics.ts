/** Cardinality-safe in-process metrics. Labels must be coarse enums, never ids. */

export type LabelSet = Record<string, string>;

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export const HTTP_DURATION_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15_000, 60_000,
];
const DEFAULT_MAX_SERIES = 1000;

function assertName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid metric name: ${name}`);
  }
}

function sanitizeLabelValue(value: string): string {
  const trimmed = value.trim().slice(0, 64);
  return trimmed.length > 0 ? trimmed : "unknown";
}

function fingerprint(labels: LabelSet): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${sanitizeLabelValue(labels[k] ?? "")}`).join(",");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: LabelSet): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const inner = keys
    .map((k) => `${k}="${escapeLabel(sanitizeLabelValue(labels[k] ?? ""))}"`)
    .join(",");
  return `{${inner}}`;
}

export class Counter {
  private readonly series = new Map<string, { labels: LabelSet; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly maxSeries = DEFAULT_MAX_SERIES,
  ) {
    assertName(name);
  }

  inc(labels: LabelSet = {}, by = 1): void {
    if (by < 0) return;
    const key = fingerprint(labels);
    const cur = this.series.get(key);
    if (cur) cur.value += by;
    else if (this.series.size < this.maxSeries) this.series.set(key, { labels: { ...labels }, value: by });
  }

  get(labels: LabelSet = {}): number {
    return this.series.get(fingerprint(labels))?.value ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.series.size === 0) {
      lines.push(`${this.name} 0`);
      return lines.join("\n");
    }
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Gauge {
  private readonly series = new Map<string, { labels: LabelSet; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly maxSeries = DEFAULT_MAX_SERIES,
  ) {
    assertName(name);
  }

  set(value: number, labels: LabelSet = {}): void {
    if (!Number.isFinite(value)) return;
    const key = fingerprint(labels);
    if (this.series.has(key) || this.series.size < this.maxSeries) {
      this.series.set(key, { labels: { ...labels }, value });
    }
  }

  inc(labels: LabelSet = {}, by = 1): void {
    this.set(this.get(labels) + by, labels);
  }

  dec(labels: LabelSet = {}, by = 1): void {
    this.set(this.get(labels) - by, labels);
  }

  get(labels: LabelSet = {}): number {
    return this.series.get(fingerprint(labels))?.value ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.series.size === 0) {
      lines.push(`${this.name} 0`);
      return lines.join("\n");
    }
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

type HistogramSeries = {
  labels: LabelSet;
  buckets: number[];
  sum: number;
  count: number;
};

export class Histogram {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = HTTP_DURATION_BUCKETS_MS,
    private readonly maxSeries = DEFAULT_MAX_SERIES,
  ) {
    assertName(name);
  }

  observe(value: number, labels: LabelSet = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = fingerprint(labels);
    let cur = this.series.get(key);
    if (!cur) {
      if (this.series.size >= this.maxSeries) return;
      cur = {
        labels: { ...labels },
        buckets: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, cur);
    }
    cur.sum += value;
    cur.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      const le = this.buckets[i];
      if (le !== undefined && value <= le) cur.buckets[i] += 1;
    }
  }

  get count(): number {
    let n = 0;
    for (const s of this.series.values()) n += s.count;
    return n;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    if (this.series.size === 0) {
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
      return lines.join("\n");
    }
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const le = this.buckets[i];
        const labels = { ...s.labels, le: String(le) };
        lines.push(`${this.name}_bucket${formatLabels(labels)} ${s.buckets[i] ?? 0}`);
      }
      const inf = { ...s.labels, le: "+Inf" };
      lines.push(`${this.name}_bucket${formatLabels(inf)} ${s.count}`);
      const base = formatLabels(s.labels);
      lines.push(`${this.name}_sum${base} ${s.sum}`);
      lines.push(`${this.name}_count${base} ${s.count}`);
    }
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly families = new Map<string, { type: "counter" | "gauge" | "histogram"; help: string; buckets?: readonly number[] }>();

  constructor(private readonly maxSeriesPerFamily = DEFAULT_MAX_SERIES) {}

  private claim(name: string, type: "counter" | "gauge" | "histogram", help: string, buckets?: readonly number[]): void {
    const existing = this.families.get(name);
    if (!existing) {
      this.families.set(name, { type, help, buckets: buckets ? [...buckets] : undefined });
      return;
    }
    const sameBuckets = type !== "histogram" || JSON.stringify(existing.buckets ?? HTTP_DURATION_BUCKETS_MS) === JSON.stringify(buckets ?? HTTP_DURATION_BUCKETS_MS);
    if (existing.type !== type || existing.help !== help || !sameBuckets) {
      throw new Error(`conflicting metric family metadata: ${name}`);
    }
  }

  counter(name: string, help: string): Counter {
    this.claim(name, "counter", help);
    const existing = this.counters.get(name);
    if (existing) return existing;
    const created = new Counter(name, help, this.maxSeriesPerFamily);
    this.counters.set(name, created);
    return created;
  }

  gauge(name: string, help: string): Gauge {
    this.claim(name, "gauge", help);
    const existing = this.gauges.get(name);
    if (existing) return existing;
    const created = new Gauge(name, help, this.maxSeriesPerFamily);
    this.gauges.set(name, created);
    return created;
  }

  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    this.claim(name, "histogram", help, buckets);
    const existing = this.histograms.get(name);
    if (existing) return existing;
    const created = new Histogram(name, help, buckets, this.maxSeriesPerFamily);
    this.histograms.set(name, created);
    return created;
  }

  renderPrometheus(): string {
    const parts: string[] = [];
    for (const m of this.counters.values()) parts.push(m.render());
    for (const m of this.gauges.values()) parts.push(m.render());
    for (const m of this.histograms.values()) parts.push(m.render());
    return parts.join("\n\n") + (parts.length ? "\n" : "");
  }
}
