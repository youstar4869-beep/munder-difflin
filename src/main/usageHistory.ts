/**
 * Token/cost usage over time, folded from `cost-ledger.jsonl` (the Usage tab).
 *
 * Each ledger row is a CUMULATIVE snapshot per (agent, session) — see usage.ts.
 * Spend in a time window is therefore the DIFF between consecutive rows of the
 * same (agent, session), credited to the later row's timestamp.
 *
 * The counter restarts near 0 when the app restarts (same session id, see
 * costLifetime.ts). A decrease is that reset: the new value itself is the spend
 * since the restart, so it is credited as-is.
 *
 * Tokens count everything: input + output + cache read + cache creation — the
 * same total fleet.json shows.
 *
 * Read-only: this module never writes to the ledger. Reading is incremental
 * (only bytes appended since the last pass), same shape as CostLedgerTotals.
 */

import { createReadStream, statSync } from 'fs';

const EPS = 1e-9;
const MAX_BYTES_PER_PASS = 8 * 1024 * 1024;
const HOUR_MS = 3_600_000;

interface LedgerRow {
  agent_id?: unknown;
  session_id?: unknown;
  ts?: unknown;
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_creation?: unknown;
  usd?: unknown;
}

/** Spend inside one bucket for one agent. */
export interface UsageAmount {
  tokens: number;
  usd: number;
}

/** One bar of a chart: its start time plus spend per agent. */
export interface UsageBucket {
  start: number;
  byAgent: Record<string, UsageAmount>;
}

/** What the Usage tab draws. */
export interface UsageHistorySummary {
  /** When this summary was built. */
  now: number;
  /** 24 hourly buckets for today (local time, 0:00 → 23:00). */
  today: UsageBucket[];
  /** 7 daily buckets for this week (local time, Monday → Sunday). */
  week: UsageBucket[];
  /** Agent ids seen in the ledger, in first-seen order. */
  agents: string[];
  /** True once the whole ledger has been read at least once. */
  ready: boolean;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Local midnight of the day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local Monday 0:00 of the week containing `ms`. */
export function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  const back = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** Local start of the hour containing `ms`. */
function startOfHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

export class UsageHistory {
  private offset = 0;
  private tail: Buffer = Buffer.alloc(0);
  /** `agent \t session` → last cumulative values. */
  private readonly last = new Map<string, { tokens: number; usd: number }>();
  /** hour start → agent → spend in that hour. */
  private readonly hours = new Map<number, Map<string, UsageAmount>>();
  private readonly agentOrder: string[] = [];
  private folding = false;
  private warm = false;

  get ready(): boolean {
    return this.warm;
  }

  /** Read whatever was appended since the last pass. Never throws. */
  refresh(ledgerPath: string): Promise<void> {
    if (this.folding) return Promise.resolve();
    this.folding = true;
    return this.fold(ledgerPath)
      .catch(() => { /* keep what we have */ })
      .finally(() => { this.folding = false; });
  }

  /** Read until caught up to the end of the file. */
  async refreshFully(ledgerPath: string): Promise<void> {
    for (let i = 0; i < 4096; i++) {
      await this.refresh(ledgerPath);
      if (this.warm) return;
    }
  }

  /** Feed ledger lines directly (tests). */
  ingestLines(lines: string[]): void {
    for (const line of lines) if (line) this.foldLine(line);
    this.warm = true;
  }

  /** Build today's hourly and this week's daily buckets relative to `now`. */
  summarize(now: number = Date.now()): UsageHistorySummary {
    const dayStart = startOfDay(now);
    const weekStart = startOfWeek(now);

    const today: UsageBucket[] = [];
    for (let h = 0; h < 24; h++) {
      const d = new Date(dayStart);
      d.setHours(h);
      today.push({ start: d.getTime(), byAgent: {} });
    }
    const week: UsageBucket[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      week.push({ start: d.getTime(), byAgent: {} });
    }
    const weekEnd = (() => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); return d.getTime(); })();

    for (const [hour, perAgent] of this.hours) {
      if (startOfDay(hour) === dayStart) add(today[new Date(hour).getHours()], perAgent);
      if (hour >= weekStart && hour < weekEnd) {
        const idx = Math.round((startOfDay(hour) - weekStart) / (24 * HOUR_MS));
        if (idx >= 0 && idx < 7) add(week[idx], perAgent);
      }
    }
    return { now, today, week, agents: [...this.agentOrder], ready: this.warm };
  }

  private async fold(ledgerPath: string): Promise<void> {
    let size: number;
    try { size = statSync(ledgerPath).size; } catch { this.warm = true; return; }
    if (size < this.offset) this.reset();
    if (size === this.offset) { this.warm = true; return; }

    const end = Math.min(size, this.offset + MAX_BYTES_PER_PASS) - 1;
    const from = this.offset;
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(ledgerPath, { start: from, end });
      stream.on('data', (chunk: string | Buffer) => {
        this.consume(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve());
    });
    this.offset = end + 1;
    if (this.offset >= size) this.warm = true;
  }

  private consume(chunk: Buffer): void {
    const buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const cut = buf.lastIndexOf(0x0a);
    if (cut === -1) { this.tail = buf; return; }
    this.tail = buf.subarray(cut + 1);
    for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) {
      if (line) this.foldLine(line);
    }
  }

  private foldLine(line: string): void {
    let row: LedgerRow;
    try { row = JSON.parse(line); } catch { return; }
    if (!row || typeof row.agent_id !== 'string') return;
    const ts = num(row.ts);
    if (!ts) return;
    const agent = row.agent_id;
    const tokens = num(row.input) + num(row.output) + num(row.cache_read) + num(row.cache_creation);
    const usd = num(row.usd);

    const key = `${agent}\t${typeof row.session_id === 'string' ? row.session_id : ''}`;
    const prev = this.last.get(key);
    let dTokens: number;
    let dUsd: number;
    if (!prev || tokens < prev.tokens - EPS || usd < prev.usd - EPS) {
      // First row of this session, or the counter restarted: all of it is new.
      dTokens = tokens;
      dUsd = usd;
    } else {
      dTokens = tokens - prev.tokens;
      dUsd = usd - prev.usd;
    }
    this.last.set(key, { tokens, usd });
    if (dTokens <= 0 && dUsd <= EPS) return;

    if (!this.agentOrder.includes(agent)) this.agentOrder.push(agent);
    const hour = startOfHour(ts);
    let perAgent = this.hours.get(hour);
    if (!perAgent) { perAgent = new Map(); this.hours.set(hour, perAgent); }
    const cur = perAgent.get(agent) ?? { tokens: 0, usd: 0 };
    cur.tokens += dTokens;
    cur.usd += dUsd;
    perAgent.set(agent, cur);
  }

  private reset(): void {
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.last.clear();
    this.hours.clear();
    this.agentOrder.length = 0;
    this.warm = false;
  }
}

function add(bucket: UsageBucket, perAgent: Map<string, UsageAmount>): void {
  for (const [agent, amt] of perAgent) {
    const cur = bucket.byAgent[agent] ?? { tokens: 0, usd: 0 };
    cur.tokens += amt.tokens;
    cur.usd += amt.usd;
    bucket.byAgent[agent] = cur;
  }
}
