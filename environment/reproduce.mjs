import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const out = '/tmp/selection-epoch-repro.json';
const run = spawnSync('node', ['/app/build_audit.mjs', '--input', '/app/data/repro.jsonl', '--output', out], {
  encoding: 'utf8',
});
if (run.status !== 0 || !fs.existsSync(out)) {
  console.error('reproducer: replay did not produce an audit');
  process.exit(1);
}
const digest = createHash('sha256').update(fs.readFileSync(out)).digest('hex');
const expected = '8bafff59542f9f43184d2bef98f6ff0121deabceaf41a74c51dea1ec7a8be792';
if (digest !== expected) {
  console.error('reproducer: captured checkpoints do not replay consistently');
  process.exit(1);
}
console.log('reproducer: capture replay is consistent');
