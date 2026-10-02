# Editor replay contract

The capture is a line-oriented event stream from a collaborative rich-text editor. It records the browser's optimistic document, render epochs, selections, local replacements, and server patches. Replaying the file means processing the records in file order while respecting the rules below.

## Document model

The document is an ordered list of blocks. Each block contains ordered atoms. Atom IDs are globally unique and an atom's `text` never changes. Text offsets in the capture and in the audit are UTF-16 code-unit offsets, matching DOM `Text`/`Selection` offsets in browsers. A checkpoint's block text is the concatenation of the live atoms in that block.

Deleted atoms remain useful as tombstones. When an atom is deleted, remember its immediate predecessor and successor from the block just before that deletion. A stale boundary can therefore be followed through a chain of deleted atoms until a live neighbor is found.

## Render epochs and selections

A `render` record describes the DOM text-node segmentation for one epoch. `start_utf16` and `end_utf16` are absolute offsets in that block at that exact render. Node IDs may be reused in later epochs. Keep the logical atom sequence for every render epoch; later selection records may refer to an older epoch.

A selection endpoint names `{epoch, node_id, offset_utf16, affinity}`. Convert it against the named render snapshot, not against the current document. The resulting logical boundary is the pair of atom IDs immediately to the left and right of the endpoint in that snapshot. Capture both neighbors even when one is `null` at a block edge.

When that boundary is resolved in the current document, follow deleted left neighbors through predecessor tombstones and deleted right neighbors through successor tombstones until live atoms (or document edges) are reached. If both live neighbors are now separated by inserted content, `backward` affinity means immediately after the surviving left neighbor and `forward` affinity means immediately before the surviving right neighbor. If the neighbors are now in different blocks after a split, the same rule chooses the end of the left block or the start of the right block. If only one live neighbor remains, resolve immediately next to that neighbor. If neither side can be recovered, use the start of the first block for `forward` and the end of the last block for `backward`.

Selection direction is determined from current document order: anchor before focus is `forward`, focus before anchor is `backward`, and equal endpoints are `none`. `selected_text` is the current text in that range; when the range spans blocks, join block boundaries with a single `\n`.

## Local replacements

A `local_splice` replaces the current selection in the optimistic document with the listed atoms. Captures only issue this event when the current selection resolves inside one block. Delete the selected live atoms, insert the new atoms at the lower endpoint, and collapse both selection endpoints immediately after the inserted atoms with `forward` affinity.

## Server patches

`remote` records can be delivered out of revision order and can be duplicated. `patch_id` is the delivery identity. Ignore a repeated `patch_id`. Buffer a first-seen patch until its `rev` is the next unapplied server revision, then apply every consecutively available revision before processing the following capture record. Revisions begin at 1.

Patch operations run in listed order:

- `splice`: remember the boundary from `left`, `right`, and `affinity`; delete the listed live atom IDs if present; resolve the remembered boundary through tombstones; insert the listed atoms there.
- `split`: resolve the supplied boundary, create `new_block` immediately after the resolved block, and move the suffix beginning at the boundary into the new block.
- `merge`: `left_block` and `right_block` are adjacent at that revision. Append any `separator` atoms to the left block, append the right block's atoms, then remove the right block.

Remote operations apply to the current optimistic document, so local atoms can sit between a remote operation's historical neighbors. Existing live atoms never change relative order.

## Checkpoints

At every `checkpoint`, emit a snapshot after all effects caused by earlier records, including a full drain of any newly contiguous remote revisions triggered by the immediately preceding delivery. The audit format is specified in `instruction.md`.
