#!/usr/bin/env node
'use strict';
/*
 * ascend.cjs — a crash-safe autonomous task-runner loop.
 *
 * Each cycle: SELECT a task with a UCB1 bandit (exploit proven winners, explore under-tried ones)
 * -> RUN it through a runner you inject (a shell command, an agent CLI, any async fn) under a hard
 * timeout -> RECORD the outcome + reward and update the task's stats so the next pick is smarter.
 * A pid-liveness lock keeps exactly one loop alive and clears a dead one instantly.
 *
 * Pure Node, zero dependencies, fail-open: a runner that throws scores 0, the loop continues.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.ASCEND_DATA_DIR ? path.resolve(process.env.ASCEND_DATA_DIR) : path.join(ROOT, 'data');
const STATS = path.join(DATA, 'stats.json');
const LOG = path.join(DATA, 'log.jsonl');
const LOCK = path.join(DATA, 'ascend.lock');

const safe = (fn, d) => { try { return fn(); } catch { return d; } };
function ensureData() { if (!fs.existsSync(DATA)) safe(() => fs.mkdirSync(DATA, { recursive: true })); }
const taskId = t => (typeof t === 'string' ? t : (t.id || t.name || t.cmd || JSON.stringify(t))).slice(0, 120);

// ── pid-liveness lock ─────────────────────────────────────────────────────────────────────────
function isPidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function acquireLock() {
  ensureData();
  const existing = safe(() => JSON.parse(fs.readFileSync(LOCK, 'utf8')), null);
  if (existing && existing.pid && existing.pid !== process.pid && isPidAlive(existing.pid)) return false;
  return safe(() => { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); return true; }, false);
}
function releaseLock() { safe(() => { const l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (l.pid === process.pid) fs.unlinkSync(LOCK); }); }

// ── stats (per-task reward memory) ──────────────────────────────────────────────────────────────
function loadStats() { return safe(() => JSON.parse(fs.readFileSync(STATS, 'utf8')), {}); }
function saveStats(s) { ensureData(); safe(() => { const tmp = STATS + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, STATS); }); }
function recordOutcome(id, reward, extra) {
  const s = loadStats();
  const st = s[id] || { plays: 0, avgReward: 0 };
  st.plays += 1;
  st.avgReward += ((Number(reward) || 0) - st.avgReward) / st.plays; // running mean
  st.last = new Date().toISOString();
  s[id] = st; saveStats(s);
  ensureData();
  safe(() => fs.appendFileSync(LOG, JSON.stringify({ ts: st.last, id, reward: Number(reward) || 0, ...extra }) + '\n'));
  return st;
}

// ── UCB1 selection ───────────────────────────────────────────────────────────────────────────
function ucb1Select(tasks, stats) {
  let totalPlays = 0;
  for (const t of tasks) totalPlays += (stats[taskId(t)] || {}).plays || 0;
  const lnT = Math.log(Math.max(1, totalPlays));
  let best = tasks[0], bestScore = -Infinity;
  for (const t of tasks) {
    const st = stats[taskId(t)] || { plays: 0, avgReward: 0 };
    // Unplayed tasks get top priority (classic UCB1 init); else exploit + explore.
    const score = st.plays === 0 ? Infinity : st.avgReward + Math.sqrt((2 * lnT) / st.plays);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// ── built-in shell runner ─────────────────────────────────────────────────────────────────────
function shellRunner(task, ctx = {}) {
  const cmd = typeof task === 'string' ? task : task.cmd;
  const timeout = (task && task.timeoutMs) || ctx.timeoutMs || 8 * 60 * 1000;
  return new Promise(resolve => {
    if (!cmd) return resolve({ ok: false, output: 'no cmd for shell runner', reward: 0 });
    let out = '', done = false;
    const ch = spawn(cmd, { shell: true, cwd: ctx.cwd || ROOT });
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => { safe(() => ch.kill()); finish({ ok: false, output: out.slice(-2000), reward: 0, timeout: true }); }, timeout);
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { out += d; });
    ch.on('close', code => { clearTimeout(timer); finish({ ok: code === 0, output: out.slice(-2000), reward: code === 0 ? 1 : 0, code }); });
    ch.on('error', e => { clearTimeout(timer); finish({ ok: false, output: e.message, reward: 0 }); });
  });
}

/**
 * runCycle(opts) — SELECT one task, RUN it, RECORD the outcome. Returns the outcome record.
 * opts: { tasks, runner=shellRunner, select=ucb1Select, timeoutMs, cwd, dryRun }
 */
async function runCycle(opts = {}) {
  const tasks = Array.isArray(opts.tasks) ? opts.tasks : [];
  if (!tasks.length) return { ok: false, id: null, output: 'no tasks', reward: 0 };
  const stats = loadStats();
  const select = opts.select || ucb1Select;
  const task = safe(() => select(tasks, stats), tasks[0]) || tasks[0];
  const id = taskId(task);
  if (opts.dryRun) return { ok: true, id, output: '[dry-run] would run this task', reward: 0, dryRun: true };

  const runner = opts.runner || shellRunner;
  let res;
  try { res = await runner(task, { timeoutMs: opts.timeoutMs, cwd: opts.cwd }); }
  catch (e) { res = { ok: false, output: String(e && e.message || e), reward: 0 }; }
  res = res || { ok: false, output: '', reward: 0 };
  const reward = res.reward != null ? res.reward : (res.ok ? 1 : 0);
  const st = recordOutcome(id, reward, { ok: !!res.ok, timeout: !!res.timeout });
  return { ok: !!res.ok, id, output: res.output || '', reward, plays: st.plays, avgReward: +st.avgReward.toFixed(3) };
}

/**
 * runLoop(opts) — run cycles until stopped. opts adds { once, intervalMs, maxCycles }.
 * Holds the pid-liveness lock for the loop's lifetime.
 */
async function runLoop(opts = {}) {
  if (!acquireLock()) { return { started: false, reason: 'another instance holds the lock' }; }
  const results = [];
  try {
    const max = opts.once ? 1 : (opts.maxCycles || Infinity);
    const intervalMs = opts.intervalMs != null ? opts.intervalMs : 30 * 60 * 1000;
    for (let n = 0; n < max; n++) {
      const r = await runCycle(opts);
      results.push(r);
      if (typeof opts.onCycle === 'function') safe(() => opts.onCycle(r, n));
      if (n + 1 < max) await new Promise(res => setTimeout(res, intervalMs));
    }
  } finally { releaseLock(); }
  return { started: true, cycles: results.length, results };
}

module.exports = { runLoop, runCycle, ucb1Select, shellRunner, recordOutcome, acquireLock, releaseLock, taskId };

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const FLAG = n => argv.includes(`--${n}`);
  const OPT = (n, d) => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
  const tasksFile = OPT('tasks', process.env.ASCEND_TASKS || path.join(ROOT, 'examples', 'tasks.example.json'));
  const tasks = safe(() => JSON.parse(fs.readFileSync(tasksFile, 'utf8')), []);
  const looping = FLAG('loop');
  const opts = {
    tasks, once: FLAG('once'), dryRun: FLAG('dry-run'),
    // The interval only paces a continuous --loop; finite runs go back-to-back.
    intervalMs: looping ? parseInt(OPT('interval', '1800'), 10) * 1000 : 0,
    onCycle: (r) => console.log(`[ascend] task=${r.id} ok=${r.ok} reward=${r.reward}${r.plays ? ` plays=${r.plays} avg=${r.avgReward}` : ''}`),
  };
  if (!tasks.length) { console.log(`No tasks. Provide --tasks=<file.json> (array of {id,cmd} or strings). Tried: ${tasksFile}`); process.exit(0); }
  (async () => {
    const out = await runLoop({ ...opts, maxCycles: looping ? Infinity : (opts.once ? 1 : tasks.length) });
    if (!out.started) console.log('[ascend] ' + out.reason);
    process.stdout.write('', () => process.exit(0));
  })();
}
