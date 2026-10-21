import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * USAGE — today-by-hour and this-week-by-day token/cost spend, stacked per agent.
 * Data comes from main's `usage:history` (a read-only fold of cost-ledger.jsonl).
 * It refreshes on every live usage push plus a slow poll, so bars grow while the
 * floor works. Charts are plain SVG — no chart library.
 */

type UsageData = NonNullable<Awaited<ReturnType<typeof window.cth.usageHistory>>>;
type Bucket = UsageData['today'][number];

const POLL_MS = 10_000;
/** Live pushes can arrive several per second; don't refetch faster than this. */
const PUSH_THROTTLE_MS = 3_000;

/** Agent colours, assigned in ledger first-seen order. */
const PALETTE = [
  'var(--cth-coral)', 'var(--cth-sky)', 'var(--cth-mint)', 'var(--cth-lemon)',
  'var(--cth-lilac)', 'var(--cth-peach)', 'var(--cth-ink-700)'
];

function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 10 ? 2 : 1)}`;
}

function bucketTotal(b: Bucket): number {
  let s = 0;
  for (const a of Object.values(b.byAgent)) s += a.tokens;
  return s;
}

function sumFor(buckets: Bucket[], agent: string): { tokens: number; usd: number } {
  let tokens = 0;
  let usd = 0;
  for (const b of buckets) {
    const a = b.byAgent[agent];
    if (a) { tokens += a.tokens; usd += a.usd; }
  }
  return { tokens, usd };
}

function sumAll(buckets: Bucket[]): { tokens: number; usd: number } {
  let tokens = 0;
  let usd = 0;
  for (const b of buckets) for (const a of Object.values(b.byAgent)) { tokens += a.tokens; usd += a.usd; }
  return { tokens, usd };
}

const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0',
  display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap'
};
const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6
};
const mono: React.CSSProperties = {
  fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)'
};

/** Stacked bar chart. `labelFor` returns the x-axis label (or '' to skip). */
function StackedBars({ buckets, agents, colorOf, nameOf, labelFor, currentIdx }: {
  buckets: Bucket[];
  agents: string[];
  colorOf: (id: string) => string;
  nameOf: (id: string) => string;
  labelFor: (b: Bucket, i: number) => string;
  currentIdx: number;
}) {
  const W = 600;
  const H = 180;
  const padL = 44;
  const padB = 18;
  const padT = 6;
  const plotW = W - padL - 4;
  const plotH = H - padB - padT;
  const max = Math.max(1, ...buckets.map(bucketTotal));
  const slot = plotW / buckets.length;
  const barW = Math.max(2, slot * 0.7);
  const grid = [0, 0.5, 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" style={{ display: 'block' }}>
      {grid.map((g) => {
        const y = padT + plotH - g * plotH;
        return (
          <g key={g}>
            <line x1={padL} x2={W - 4} y1={y} y2={y} stroke="var(--cth-ink-100)" strokeWidth={1} />
            <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={10}
              fontFamily="var(--cth-font-mono)" fill="var(--cth-ink-700)">
              {fmtTokens(max * g)}
            </text>
          </g>
        );
      })}
      {buckets.map((b, i) => {
        const x = padL + i * slot + (slot - barW) / 2;
        let y = padT + plotH;
        const label = labelFor(b, i);
        return (
          <g key={b.start}>
            {i === currentIdx && (
              <rect x={padL + i * slot} y={padT} width={slot} height={plotH}
                fill="var(--cth-ink-100)" opacity={0.35} />
            )}
            {agents.map((id) => {
              const amt = b.byAgent[id];
              if (!amt || amt.tokens <= 0) return null;
              const h = (amt.tokens / max) * plotH;
              y -= h;
              return (
                <rect key={id} x={x} y={y} width={barW} height={Math.max(h, 0.5)} fill={colorOf(id)}>
                  <title>{`${nameOf(id)} · ${label || ''} ${fmtTokens(amt.tokens)} (${fmtUsd(amt.usd)})`}</title>
                </rect>
              );
            })}
            {label && (
              <text x={padL + i * slot + slot / 2} y={H - 4} textAnchor="middle" fontSize={10}
                fontFamily="var(--cth-font-mono)"
                fill={i === currentIdx ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}
                fontWeight={i === currentIdx ? 700 : 400}>
                {label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function UsageTab() {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<UsageData | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'nohive'>('loading');
  const lastFetch = useRef(0);

  const load = useCallback(async () => {
    lastFetch.current = Date.now();
    try {
      const d = await window.cth.usageHistory();
      if (!d) { setState('nohive'); return; }
      setData(d);
      setState('ok');
    } catch { /* keep the last good chart */ }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    const off = window.cth.onTelemetryEvent?.((e) => {
      if (e.kind !== 'usage') return;
      if (Date.now() - lastFetch.current < PUSH_THROTTLE_MS) return;
      void load();
    });
    return () => { clearInterval(timer); off?.(); };
  }, [load]);

  if (state === 'loading' && !data) return <div style={mono}>{t('usageTab.loading')}</div>;
  if (state === 'nohive' || !data) return <div style={mono}>{t('usageTab.noHive')}</div>;

  const colorOf = (id: string) => PALETTE[Math.max(0, data.agents.indexOf(id)) % PALETTE.length];
  const nameOf = (id: string) => data.names[id] ?? id;
  const weekAgents = data.agents.filter((id) => sumFor(data.week, id).tokens > 0);
  const todayTotal = sumAll(data.today);
  const weekTotal = sumAll(data.week);
  const now = new Date(data.now);
  const hourIdx = now.getHours();
  const dayIdx = (now.getDay() + 6) % 7;
  const weekdayFmt = new Intl.DateTimeFormat(i18n.language, { weekday: 'short' });
  const timeFmt = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 2 }}>
      <div style={{ ...mono, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>{t('usageTab.tokensNote')}</span>
        <span>{t('usageTab.updated', { time: timeFmt.format(now) })}</span>
      </div>

      {weekAgents.length === 0 ? (
        <div style={card}><span style={mono}>{t('usageTab.empty')}</span></div>
      ) : (
        <>
          <div style={card}>
            <div style={sectionHead}>
              <span>{t('usageTab.today')}</span>
              <span style={mono}>{fmtTokens(todayTotal.tokens)} · {fmtUsd(todayTotal.usd)}</span>
            </div>
            <StackedBars buckets={data.today} agents={data.agents} colorOf={colorOf} nameOf={nameOf}
              currentIdx={hourIdx} labelFor={(_b, i) => (i % 3 === 0 ? String(i) : '')} />
          </div>

          <div style={card}>
            <div style={sectionHead}>
              <span>{t('usageTab.week')}</span>
              <span style={mono}>{fmtTokens(weekTotal.tokens)} · {fmtUsd(weekTotal.usd)}</span>
            </div>
            <StackedBars buckets={data.week} agents={data.agents} colorOf={colorOf} nameOf={nameOf}
              currentIdx={dayIdx} labelFor={(b) => weekdayFmt.format(new Date(b.start))} />
          </div>

          <div style={card}>
            <div style={sectionHead}>
              <span>{t('usageTab.byAgent')}</span>
            </div>
            <table style={{ ...mono, borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ color: 'var(--cth-ink-900)' }}>
                  <th style={{ textAlign: 'start', padding: '2px 4px' }}>{t('usageTab.agent')}</th>
                  <th style={{ textAlign: 'end', padding: '2px 4px' }}>{t('usageTab.today')}</th>
                  <th style={{ textAlign: 'end', padding: '2px 4px' }}>{t('usageTab.week')}</th>
                </tr>
              </thead>
              <tbody>
                {weekAgents
                  .slice()
                  .sort((a, b) => sumFor(data.week, b).tokens - sumFor(data.week, a).tokens)
                  .map((id) => {
                    const d = sumFor(data.today, id);
                    const w = sumFor(data.week, id);
                    return (
                      <tr key={id} style={{ boxShadow: 'inset 0 -1px 0 var(--cth-ink-100)' }}>
                        <td style={{ padding: '3px 4px' }}>
                          <span style={{
                            display: 'inline-block', width: 10, height: 10, marginInlineEnd: 6,
                            background: colorOf(id), verticalAlign: 'middle'
                          }} />
                          {nameOf(id)}
                        </td>
                        <td style={{ textAlign: 'end', padding: '3px 4px' }}>
                          {fmtTokens(d.tokens)} · {fmtUsd(d.usd)}
                        </td>
                        <td style={{ textAlign: 'end', padding: '3px 4px' }}>
                          {fmtTokens(w.tokens)} · {fmtUsd(w.usd)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
