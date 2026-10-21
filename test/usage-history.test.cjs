'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { UsageHistory, startOfWeek } = loadTs('src/main/usageHistory.ts');

/** Local time helper: a fixed Wednesday so the week has days on both sides. */
function at(day, hour, minute = 0) {
  return new Date(2026, 9, day, hour, minute).getTime(); // Oct 2026; the 21st is a Wednesday
}

/** One ledger row in the exact shape appendCostLedger writes (cumulative). */
function row(agent, session, ts, tokens, usd) {
  return JSON.stringify({
    agent_id: agent, session_id: session, ts,
    input: tokens, output: 0, cache_read: 0, cache_creation: 0, model: 'm', usd
  });
}

function summarize(lines, now) {
  const h = new UsageHistory();
  h.ingestLines(lines);
  return h.summarize(now);
}

test('spend in a bucket is the diff of cumulative rows', () => {
  const s = summarize([
    row('a', 's1', at(21, 9, 0), 100, 1),
    row('a', 's1', at(21, 9, 30), 150, 1.5),
    row('a', 's1', at(21, 10, 5), 400, 4)
  ], at(21, 12));
  assert.equal(s.today[9].byAgent.a.tokens, 150);
  assert.equal(s.today[10].byAgent.a.tokens, 250);
  assert.ok(Math.abs(s.today[10].byAgent.a.usd - 2.5) < 1e-9);
});

test('a restart (counter drops) credits the new value, never a negative', () => {
  const s = summarize([
    row('a', 's1', at(21, 9), 1000, 10),
    row('a', 's1', at(21, 11), 50, 0.5), // app restarted
    row('a', 's1', at(21, 11, 30), 80, 0.8)
  ], at(21, 12));
  assert.equal(s.today[9].byAgent.a.tokens, 1000);
  assert.equal(s.today[11].byAgent.a.tokens, 80);
});

test('duplicate rows add nothing', () => {
  const s = summarize([
    row('a', 's1', at(21, 9), 100, 1),
    row('a', 's1', at(21, 9, 1), 100, 1),
    row('a', 's1', at(21, 9, 2), 100, 1)
  ], at(21, 12));
  assert.equal(s.today[9].byAgent.a.tokens, 100);
});

test('agents and sessions are kept apart; all token kinds are counted', () => {
  const s = summarize([
    JSON.stringify({ agent_id: 'a', session_id: 's1', ts: at(21, 8), input: 1, output: 2, cache_read: 3, cache_creation: 4, usd: 0.1 }),
    row('b', 's9', at(21, 8, 10), 500, 2),
    row('a', 's2', at(21, 8, 20), 30, 0.3)
  ], at(21, 12));
  assert.equal(s.today[8].byAgent.a.tokens, 10 + 30);
  assert.equal(s.today[8].byAgent.b.tokens, 500);
  assert.deepEqual(s.agents, ['a', 'b']);
});

test('week buckets run Monday to Sunday and skip last week', () => {
  const s = summarize([
    row('a', 's1', at(18, 9), 100, 1),   // Sunday of LAST week
    row('a', 's1', at(19, 9), 300, 3),   // Monday
    row('a', 's1', at(21, 9), 600, 6)    // Wednesday (today)
  ], at(21, 12));
  assert.equal(s.week.length, 7);
  assert.equal(s.week[0].start, startOfWeek(at(21, 12)));
  assert.equal(new Date(s.week[0].start).getDay(), 1);
  assert.equal(s.week[0].byAgent.a.tokens, 200);
  assert.equal(s.week[2].byAgent.a.tokens, 300);
  // today's chart only holds today
  assert.equal(s.today[9].byAgent.a.tokens, 300);
});

test('reads the ledger file incrementally, including a half-written last line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-'));
  const p = path.join(dir, 'cost-ledger.jsonl');
  const second = row('a', 's1', at(21, 10), 150, 1.5);
  const cut = Math.floor(second.length / 2);
  fs.writeFileSync(p, `${row('a', 's1', at(21, 9), 100, 1)}\n${second.slice(0, cut)}`);
  const h = new UsageHistory();
  await h.refreshFully(p);
  assert.equal(h.summarize(at(21, 12)).today[10].byAgent.a, undefined);
  fs.appendFileSync(p, `${second.slice(cut)}\n`);
  await h.refreshFully(p);
  const s = h.summarize(at(21, 12));
  assert.equal(s.today[9].byAgent.a.tokens, 100);
  assert.equal(s.today[10].byAgent.a.tokens, 50);
  assert.equal(s.ready, true);
});

test('a missing ledger is an empty, ready summary', async () => {
  const h = new UsageHistory();
  await h.refreshFully(path.join(os.tmpdir(), 'md-usage-does-not-exist.jsonl'));
  const s = h.summarize(at(21, 12));
  assert.equal(s.ready, true);
  assert.deepEqual(s.agents, []);
});
