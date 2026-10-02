import fs from 'node:fs';

const legacy = JSON.parse(fs.readFileSync('/app/legacy_audit.json', 'utf8')).checkpoints;
const rebase = JSON.parse(fs.readFileSync('/app/rebase_audit.json', 'utf8')).checkpoints;
for (const row of legacy) {
  const rev = row.applied_remote_rev;
  delete row.applied_remote_rev;
  row.remote_clock = { text: rev, tree: 0 };
  row.pending_local = [];
}
fs.writeFileSync('/app/editor_audit.json', `${JSON.stringify({ checkpoints: [...legacy, ...rebase] }, null, 2)}\n`);
