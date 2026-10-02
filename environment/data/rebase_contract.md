# Optimistic rebase capture contract

`rebase_capture.jsonl` is a second, independent editor session. It records a browser-visible optimistic document while canonical server work is arriving on two ordered lanes. The audit must follow the state a user would have seen after each record, not merely the canonical server state.

## Identity, text, and boundaries

The document is an ordered list of blocks containing ordered atoms. Atom IDs are globally unique within this session and atom text is immutable. Text offsets are UTF-16 code-unit offsets.

A logical boundary is `{left, right, affinity}`. `left` and `right` are the atom IDs immediately adjacent to the boundary when it is captured. A boundary is historical: later edits do not replace it with a numeric index.

When an atom is first removed from a document state, its immediate predecessor and successor at that removal are its deletion neighbors. An inserted atom also has insertion neighbors: the immediate atoms on either side of the insertion, with atoms from the same insertion chained in their listed order. Historical neighbor information remains available after the atom leaves the live document.

Before resolving an atom reference, follow any `id_map` aliases transitively. If the resulting atom is live, use it. Otherwise, follow deletion neighbors in the requested direction; if no deletion neighbors were ever recorded for that atom, follow its insertion neighbors. Continue until a live atom or an edge is reached. A boundary with two surviving sides uses `backward` affinity immediately after the live left side and `forward` affinity immediately before the live right side. With only one surviving side, resolve next to that side. With neither side recoverable, use the start of the first block for `forward` and the end of the last block for `backward`.

## Render epochs and selections

`render` and `selection` records have the same meaning as in `editor_replay_contract.md`, except that a render snapshots the current optimistic document of this session. Node IDs are not identities and may be reused. A selection endpoint must be interpreted against the named epoch, then retained as a logical boundary.

Selection direction and `selected_text` are always derived from current optimistic block order. Multi-block text uses a single `\n` between blocks.

## Local batches

A `local_batch` is an optimistic browser action. Batches remain pending until a server frame acknowledges or rejects them. Pending batches are ordered by their appearance in the capture.

`replace_selection` is emitted only when the current selection resolves within one block. Its first application captures the lower and upper logical boundary of that selection, the live atom IDs inside the range, and the listed insertion atoms. The same captured intent is used whenever that still-pending batch is replayed after canonical state changes. After its first application, the browser selection collapses after its inserted atoms with `forward` affinity.

`split_at_focus` captures the current focus boundary and creates `new_block` immediately after the block containing that boundary, moving the suffix beginning at the boundary into the new block. On its first application the browser selection collapses at that split boundary with `forward` affinity. A replay of the pending batch uses the original captured boundary, not a later selection.

The optimistic document at any moment is the current canonical document plus all still-pending local batches, replayed in capture order using their captured intents. Canonical changes therefore rebase pending work; they do not reinterpret pending actions from the current selection.

## Server frames

A `delivery` contains one server `frame`. Frames have a unique `frame_id`, a `lane` (`text` or `tree`), a positive lane-local `seq`, a dependency clock in `depends`, a unique integer `server_time`, and zero or more canonical operations. Duplicate deliveries of the same `frame_id` have no effect.

A frame is enabled when its `seq` is exactly the next sequence number for its lane and the current server clock is at least every value in `depends`. After a first-seen delivery, repeatedly apply enabled buffered frames before processing the next capture record. If more than one frame is enabled, apply the one with the smallest `server_time` first. Applying a frame increments only its own lane clock.

Server operations affect the canonical document, in listed order:

- `splice`: capture the supplied `{left,right,affinity}` boundary, remove any listed live atom IDs that are present, resolve the boundary through history, then insert the listed atoms there.
- `split`: resolve the supplied boundary, create `new_block` immediately after its resolved block, and move the suffix beginning at the boundary into it.
- `merge`: the named blocks are adjacent when this operation applies. Append any `separator` atoms to `left_block`, append all atoms from `right_block`, then remove `right_block`.
- `move`: remove `block` from block order and insert it immediately after `after`; `after: null` means the first block.

A frame may contain `ack_local` or `reject_local`. Either decision removes that pending local batch before the frame's canonical operations are incorporated into the visible state. An acknowledged frame can also provide `id_map`, mapping optimistic atom IDs from that batch to canonical atom IDs. Those aliases apply to all historical boundaries and neighbor links. A rejected batch has no alias; its former inserted atoms remain historical only through their insertion or deletion neighbors. After the frame's canonical operations and lane-clock increment, every still-pending local batch contributes again according to its original captured intent.

## Checkpoints

At each `checkpoint`, record the current optimistic document, selection, server clock, and pending local batch IDs after all effects caused by earlier records and the complete enabled-frame drain caused by the preceding delivery.
