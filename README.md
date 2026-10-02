# Selection Epoch Rebase

A frontend and collaborative-editor reconstruction challenge focused on recovering text selections across asynchronous runtime epochs, IME composition, renderer commits, collaboration state, and concurrent UI updates.

Selection state in a modern editor is not simply a pair of character offsets. It can move as text is inserted or deleted, cross process and runtime boundaries, be represented in node-local or global coordinates, and require rebasing when remote operations occur concurrently with local composition.

Selection Epoch Rebase reconstructs those histories and produces one consistent view for each requested commit.

## Overview

The task correlates four independent views of editor state:

- model / IME state
- renderer state
- collaboration-worker state
- concurrent UI-root state

Conceptually:

```text
IME / model events
        │
        ├───────────────┐
        ↓               │
selection rebasing      │
                        │
renderer journal ───────┤
                        │
collaboration worker ───┤
                        │
concurrent UI root ─────┘
        │
        ↓
cross-stream reconciliation
        │
        ↓
commit-specific editor state
```

The final result must agree across these different runtime representations.

## Repository Structure

```text
selection-epoch-rebase/
├── cheat/
├── environment/
├── solution/
├── tests/
├── instruction.md
└── task.toml
```

### `instruction.md`

Defines the reconstruction rules, input evidence, commit cases, UTF-16 conventions, and required output schema.

### `environment/`

Contains the reproducible runtime and solver-visible evidence.

### `solution/`

Contains the reference reconstruction implementation.

### `tests/`

Contains the independent verifier.

### `task.toml`

Defines task metadata and execution configuration.

## Why Selection Rebasing Is Difficult

Consider an editor with a selection at:

```text
hello wor|ld
```

If a remote operation inserts text before the selection:

```text
hello beautiful wor|ld
```

the logical selection should continue to refer to the same position even though its numeric offset changes.

Now add:

- concurrent remote edits
- local IME composition
- node splitting and merging
- renderer reordering
- runtime epochs
- recycled handles
- hidden leaves
- deferred updates

and a simple numeric offset is no longer enough to reconstruct the historical selection.

## UTF-16 Coordinates

Selection coordinates are represented in UTF-16 code units.

This distinction matters for characters outside the Basic Multilingual Plane.

For example, a character such as:

```text
🙂
```

occupies two UTF-16 code units.

An implementation that counts Unicode code points instead of UTF-16 units can therefore produce incorrect selection positions.

The renderer replay also needs to preserve slicing and offsets in UTF-16 units. :chatgpt-content-reference{index="3"}

## Model / IME Reconstruction

The model side reconstructs editor state around local composition commits.

Relevant state includes:

- stable editor identity
- visible model revision
- post-commit text
- composition ranges
- local and remote operations
- selection association
- runtime epochs
- clock conversion

The capture uses process-local clock epochs, so events must be correlated with the appropriate main-thread time before editor ownership and composition state can be resolved. :chatgpt-content-reference{index="4"}

## Selection Association

When text is replaced, selection endpoints can associate with either side of the replaced range.

Conceptually:

```text
left association:
    boundary follows content before the edit

right association:
    boundary follows inserted/replaced content
```

This matters particularly when remote changes occur at the same logical boundary as an IME composition.

The reconstruction determines the association behavior needed to reproduce the recorded commits.

## Renderer Journal

The renderer maintains another representation of text and selection.

Its historical journal includes operations such as:

- splice
- split
- merge
- move
- focus
- selection
- commit

Recovered renderer pages are validated before events are replayed. In the captured task, torn or invalid page copies can be rejected while valid earlier generations preserve the logical journal. :chatgpt-content-reference{index="5"}

Renderer selection endpoints begin as node-local offsets and must be converted into global UTF-16 positions in the reconstructed rendered text.

## Collaboration Worker

The collaboration worker represents the shared editing state.

Its reconstruction may require reconciling replicated durable state and applying operations in the correct logical order.

For each relevant commit, the task derives values including:

```text
worker_text
worker_selection_anchor_utf16
worker_selection_focus_utf16
worker_state_sha256
worker_visible_op_count
```

These values provide an independent view of the same editor history. :chatgpt-content-reference{index="6"}

## Concurrent UI Root

The concurrent UI representation introduces another state machine.

Updates can be:

- applied
- skipped
- rebased
- retained in a queue
- entangled with other lanes
- committed under different compatibility behavior

The reconstruction tracks visible leaf text, focus, selection, pending work, and published state.

A subtle but important distinction is that the reported selection is a **global UTF-16 offset** in the visible root text, even though internal tree state may keep a local offset. :chatgpt-content-reference{index="7"}

## Epoch Rebasing

A central theme of the project is preserving logical state across epochs.

Conceptually:

```text
epoch N state
     ↓
new remote/local operations
     ↓
runtime transition
     ↓
rebase retained selection
     ↓
epoch N+1 state
```

An update may have been created under one state but committed after the underlying text or tree has changed.

The solver must reconstruct what that update means in the newer state rather than replaying stale coordinates literally.

## Logical vs Physical Identity

Runtime handles may be reused.

Therefore:

```text
runtime handle
```

is not always equivalent to:

```text
stable editor identity
```

Editor ownership must be resolved using lifetime information at the relevant historical time.

This prevents state from one editor instance from being incorrectly assigned to a later instance that reused the same runtime identifier.

## Cross-Stream Reconciliation

Each requested case ultimately brings together four views:

```text
Model / IME
    +
Renderer
    +
Collaboration Worker
    +
Concurrent UI Root
    ↓
reconciled commit
```

The output should represent a coherent historical state rather than four independently plausible snapshots.

## Output

The solver writes:

```text
/app/output/ime_replay.json
```

The top-level object contains:

```json
{
  "schema_version": 1,
  "cases": []
}
```

Each case records the reconstructed model, renderer, worker, and concurrent-root state associated with a requested commit. :chatgpt-content-reference{index="8"}

Representative fields include:

```text
case_id
editor_id
visible_revision

text
selection_start_utf16
selection_end_utf16

render_text
focused_node_id
render_selection_anchor_utf16
render_selection_focus_utf16
render_commit_seq

worker_text
worker_selection_anchor_utf16
worker_selection_focus_utf16
worker_state_sha256
worker_visible_op_count

fiber_dom_text
fiber_focused_key
fiber_selection_utf16
fiber_tree_sha256
```

See `instruction.md` for the complete authoritative schema.

## Common Failure Modes

### Counting Unicode code points instead of UTF-16 units

Emoji and other supplementary characters shift the selection.

### Treating stale selection offsets as current

Selections must be rebased through edits.

### Ignoring runtime epochs

Reused handles can cause state to be assigned to the wrong editor.

### Replaying only one subsystem

A locally plausible model state can disagree with the renderer, worker, or concurrent UI root.

### Using local renderer offsets as global offsets

Node-local selection positions must be projected into the full rendered text.

### Ignoring concurrent queues

A UI update may be skipped and retained rather than applied immediately.

## Reconstruction Pipeline

A high-level workflow is:

```text
recover runtime epochs
        ↓
resolve stable editor identities
        ↓
replay model / IME operations
        ↓
rebase composition selection
        ↓
recover renderer journal
        ↓
replay collaborative worker
        ↓
reconstruct concurrent UI commits
        ↓
convert selections to UTF-16
        ↓
cross-check commit identities
        ↓
emit ime_replay.json
```

## Technical Areas

This project exercises:

- JavaScript runtime behavior
- Python data reconstruction
- text editor internals
- IME composition
- UTF-16 indexing
- selection rebasing
- collaborative editing
- CRDT-style state
- event replay
- renderer journals
- concurrent UI scheduling
- logical identity recovery
- clock reconciliation
- CRC validation
- state hashing
- distributed-system reasoning

## Validation

A correct reconstruction should maintain consistency across all four evidence streams.

Useful invariants include:

```text
editor identities agree
selection offsets are within text bounds
commit identities correspond
replayed hashes match recorded state
selection movement follows edit semantics
```

The recovered reference pipeline validated every requested case after reconstructing all four streams. :chatgpt-content-reference{index="9"}

## Goal

Selection Epoch Rebase demonstrates that text selection is historical state, not merely two integers.

Correct reconstruction requires tracking how those positions evolve through composition, remote edits, rendering changes, collaboration state, and concurrent commits.

The central principle is:

> Preserve the logical selection while the underlying text and runtime state evolve.

## License

No license is currently specified.
