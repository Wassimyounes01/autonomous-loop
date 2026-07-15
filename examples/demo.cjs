'use strict';
// demo.cjs — watch the UCB1 bandit concentrate cycles on the higher-reward task.
// Run: node examples/demo.cjs
const path = require('path');

// Isolate demo state so it doesn't touch a real ./data dir.
// (Must be set BEFORE requiring the lib — the data/lock paths resolve at load time.)
process.env.ASCEND_DATA_DIR = path.join(require('os').tmpdir(), 'ascend-demo-' + process.pid);
const { runLoop } = require('../lib/ascend.cjs');

// Two tasks with different (stochastic-ish but deterministic) payoffs. In a real loop the runner
// would spawn a command or call an agent; here it just returns a reward so the bandit is visible.
const tasks = [
  { id: 'high-value', base: 0.8 },
  { id: 'low-value', base: 0.2 },
];
let tick = 0;
const runner = async (task) => {
  tick++;
  // deterministic wobble around the task's base payoff
  const reward = Math.max(0, Math.min(1, task.base + (((tick * 37) % 10) - 5) / 50));
  return { ok: reward > 0.5, output: `${task.id} → ${reward.toFixed(2)}`, reward };
};

(async () => {
  const counts = {};
  await runLoop({
    tasks, runner, maxCycles: 20, intervalMs: 0,
    onCycle: (r) => { counts[r.id] = (counts[r.id] || 0) + 1; },
  });
  console.log('cycles per task after 20 runs (bandit should favor high-value):');
  for (const [id, n] of Object.entries(counts)) console.log(`  ${id.padEnd(12)} ${n} cycles`);
})();
