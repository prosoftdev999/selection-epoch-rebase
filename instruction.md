The browser trace in this task comes from two collaborative-editor sessions. The shipped replay utility handles only the simpler session and is not sufficient for the second session, where pending local edits are rebased while dependent server frames arrive out of order.

Produce `/app/editor_audit.json` by replaying both `/app/data/capture.jsonl` and `/app/data/rebase_capture.jsonl`. Process them as independent sessions, in that file order, and append their checkpoint rows in that same order. The first session follows `/app/data/editor_replay_contract.md`; the second follows `/app/data/rebase_contract.md`. You may repair or replace the replay tooling under `/app` as needed. `/app/reproduce.mjs` remains a small diagnostic for the first session only.

The output must be UTF-8 JSON with exactly one top-level key, `checkpoints`. Its value is an array with one object for every `checkpoint` record from the two input files. Every checkpoint object must contain exactly these fields:

- `checkpoint_id`: the checkpoint ID from the source record.
- `blocks`: the current optimistic document as an ordered array of `{ "block_id": string, "text": string }` objects.
- `anchor`: `{ "block_id": string, "utf16": integer, "affinity": "forward" | "backward" }`, or `null` when no selection has been established.
- `focus`: the same shape as `anchor`, or `null`.
- `direction`: exactly `"forward"`, `"backward"`, or `"none"`, using current document order.
- `selected_text`: current selected text, with `\n` between blocks for a cross-block range.
- `remote_clock`: exactly `{ "text": integer, "tree": integer }`. For `capture.jsonl`, treat its ordinary remote revision stream as the `text` lane and keep `tree` at zero. For `rebase_capture.jsonl`, use the two-lane clock defined by its contract.
- `pending_local`: the pending local batch IDs in capture order. This is always an empty array for `capture.jsonl`.

Do not collapse repeated-looking checkpoints. Offsets are UTF-16 code units. Block order, endpoint affinity, the two lane-clock values, and pending-local order are all observable parts of the required result.

You have 7200 seconds to complete this task. Do not cheat by using online solutions or hints specific to this task.
