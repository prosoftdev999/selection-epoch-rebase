import fs from 'node:fs';

const u16len = (s) => s.length;

class Replay {
  constructor() {
    this.blockOrder = [];
    this.blocks = new Map();
    this.atomText = new Map();
    this.tomb = new Map();
    this.renders = new Map();
    this.selection = null;
    this.pending = new Map();
    this.seenPatch = new Set();
    this.nextRev = 1;
    this.checkpoints = [];
  }

  cloneDoc() {
    const out = new Map();
    for (const b of this.blockOrder) out.set(b, [...this.blocks.get(b)]);
    return out;
  }

  bootstrap(blocks) {
    this.blockOrder = [];
    this.blocks = new Map();
    this.atomText = new Map();
    this.tomb = new Map();
    for (const block of blocks) {
      this.blockOrder.push(block.id);
      const ids = [];
      for (const atom of block.atoms) {
        ids.push(atom.id);
        this.atomText.set(atom.id, atom.text);
      }
      this.blocks.set(block.id, ids);
    }
  }

  liveLoc(id) {
    if (id == null) return null;
    for (const blockId of this.blockOrder) {
      const index = this.blocks.get(blockId).indexOf(id);
      if (index !== -1) return { blockId, index };
    }
    return null;
  }

  chase(id, direction) {
    const seen = new Set();
    let cur = id;
    while (cur != null) {
      if (seen.has(cur)) throw new Error(`tombstone cycle at ${cur}`);
      seen.add(cur);
      if (this.liveLoc(cur)) return cur;
      const t = this.tomb.get(cur);
      if (!t) return null;
      cur = t[direction];
    }
    return null;
  }

  anchorFromSnapshot(epoch, nodeId, offset, affinity) {
    const snap = this.renders.get(epoch);
    if (!snap) throw new Error(`unknown render epoch ${epoch}`);
    const node = snap.nodes.get(nodeId);
    if (!node) throw new Error(`unknown node ${nodeId} in epoch ${epoch}`);
    const absolute = node.start + offset;
    if (offset < 0 || absolute > node.end) throw new Error('node offset out of range');
    const ids = snap.blocks.get(node.blockId);
    let current = 0;
    let index = absolute === 0 ? 0 : null;
    for (let i = 0; i < ids.length && index == null; i += 1) {
      if (current === absolute) {
        index = i;
        break;
      }
      current += u16len(this.atomText.get(ids[i]));
      if (current === absolute) index = i + 1;
      else if (current > absolute) throw new Error('selection endpoint is not on an atom boundary');
    }
    if (index == null) {
      if (current === absolute) index = ids.length;
      else throw new Error('bad snapshot offset');
    }
    return {
      left: index > 0 ? ids[index - 1] : null,
      right: index < ids.length ? ids[index] : null,
      affinity,
    };
  }

  resolveAnchor(anchor) {
    const left = this.chase(anchor.left, 'prev');
    const right = this.chase(anchor.right, 'next');
    const leftLoc = left == null ? null : this.liveLoc(left);
    const rightLoc = right == null ? null : this.liveLoc(right);
    const affinity = anchor.affinity ?? 'forward';

    if (leftLoc && rightLoc) {
      if (leftLoc.blockId === rightLoc.blockId) {
        if (leftLoc.index >= rightLoc.index) throw new Error('anchor order inverted');
        return {
          blockId: leftLoc.blockId,
          index: affinity === 'backward' ? leftLoc.index + 1 : rightLoc.index,
        };
      }
      const lpos = this.blockOrder.indexOf(leftLoc.blockId);
      const rpos = this.blockOrder.indexOf(rightLoc.blockId);
      if (lpos > rpos) throw new Error('cross-block anchor order inverted');
      return affinity === 'backward'
        ? { blockId: leftLoc.blockId, index: leftLoc.index + 1 }
        : { blockId: rightLoc.blockId, index: rightLoc.index };
    }
    if (leftLoc) return { blockId: leftLoc.blockId, index: leftLoc.index + 1 };
    if (rightLoc) return { blockId: rightLoc.blockId, index: rightLoc.index };
    if (this.blockOrder.length === 0) throw new Error('empty document');
    const blockId = affinity === 'forward' ? this.blockOrder[0] : this.blockOrder.at(-1);
    return {
      blockId,
      index: affinity === 'forward' ? 0 : this.blocks.get(blockId).length,
    };
  }

  endpointObject(anchor) {
    const point = this.resolveAnchor(anchor);
    const ids = this.blocks.get(point.blockId).slice(0, point.index);
    const text = ids.map((id) => this.atomText.get(id)).join('');
    return { block_id: point.blockId, utf16: u16len(text), affinity: anchor.affinity };
  }

  pointKey(point) {
    return [this.blockOrder.indexOf(point.blockId), point.index];
  }

  comparePoints(a, b) {
    const ak = this.pointKey(a);
    const bk = this.pointKey(b);
    return ak[0] === bk[0] ? Math.sign(ak[1] - bk[1]) : Math.sign(ak[0] - bk[0]);
  }

  selectedTextAndDirection() {
    if (!this.selection) return { text: '', direction: 'none' };
    const a = this.resolveAnchor(this.selection.anchor);
    const f = this.resolveAnchor(this.selection.focus);
    const cmp = this.comparePoints(a, f);
    if (cmp === 0) return { text: '', direction: 'none' };
    const direction = cmp < 0 ? 'forward' : 'backward';
    const lo = cmp < 0 ? a : f;
    const hi = cmp < 0 ? f : a;
    const lpos = this.blockOrder.indexOf(lo.blockId);
    const hpos = this.blockOrder.indexOf(hi.blockId);
    if (lpos === hpos) {
      const ids = this.blocks.get(lo.blockId).slice(lo.index, hi.index);
      return { text: ids.map((id) => this.atomText.get(id)).join(''), direction };
    }
    const parts = [];
    parts.push(this.blocks.get(lo.blockId).slice(lo.index).map((id) => this.atomText.get(id)).join(''));
    for (let i = lpos + 1; i < hpos; i += 1) {
      const b = this.blockOrder[i];
      parts.push(this.blocks.get(b).map((id) => this.atomText.get(id)).join(''));
    }
    parts.push(this.blocks.get(hi.blockId).slice(0, hi.index).map((id) => this.atomText.get(id)).join(''));
    return { text: parts.join('\n'), direction };
  }

  deleteIds(ids) {
    const targets = new Set(ids);
    for (const blockId of this.blockOrder) {
      const arr = this.blocks.get(blockId);
      for (let i = 0; i < arr.length; i += 1) {
        const id = arr[i];
        if (targets.has(id) && !this.tomb.has(id)) {
          this.tomb.set(id, {
            prev: i > 0 ? arr[i - 1] : null,
            next: i + 1 < arr.length ? arr[i + 1] : null,
          });
        }
      }
    }
    for (const blockId of this.blockOrder) {
      this.blocks.set(blockId, this.blocks.get(blockId).filter((id) => !targets.has(id)));
    }
  }

  insertAtoms(blockId, index, atoms) {
    const ids = [];
    for (const atom of atoms) {
      if (this.atomText.has(atom.id)) throw new Error(`duplicate atom ${atom.id}`);
      this.atomText.set(atom.id, atom.text);
      ids.push(atom.id);
    }
    this.blocks.get(blockId).splice(index, 0, ...ids);
    return ids;
  }

  applySplice(op) {
    const anchor = { left: op.left ?? null, right: op.right ?? null, affinity: op.affinity ?? 'forward' };
    this.deleteIds(op.delete ?? []);
    const point = this.resolveAnchor(anchor);
    this.insertAtoms(point.blockId, point.index, op.insert ?? []);
  }

  applySplit(op) {
    const anchor = { left: op.left ?? null, right: op.right ?? null, affinity: op.affinity ?? 'forward' };
    const point = this.resolveAnchor(anchor);
    if (this.blocks.has(op.new_block)) throw new Error(`block already exists: ${op.new_block}`);
    const arr = this.blocks.get(point.blockId);
    const suffix = arr.splice(point.index);
    const pos = this.blockOrder.indexOf(point.blockId);
    this.blockOrder.splice(pos + 1, 0, op.new_block);
    this.blocks.set(op.new_block, suffix);
  }

  applyMerge(op) {
    if (!this.blocks.has(op.left_block) || !this.blocks.has(op.right_block)) throw new Error('merge block missing');
    const lp = this.blockOrder.indexOf(op.left_block);
    const rp = this.blockOrder.indexOf(op.right_block);
    if (rp !== lp + 1) throw new Error('merge blocks are not adjacent');
    this.insertAtoms(op.left_block, this.blocks.get(op.left_block).length, op.separator ?? []);
    this.blocks.get(op.left_block).push(...this.blocks.get(op.right_block));
    this.blocks.delete(op.right_block);
    this.blockOrder.splice(rp, 1);
  }

  applyPatch(patch) {
    for (const op of patch.ops) {
      if (op.kind === 'splice') this.applySplice(op);
      else if (op.kind === 'split') this.applySplit(op);
      else if (op.kind === 'merge') this.applyMerge(op);
      else throw new Error(`unknown operation ${op.kind}`);
    }
  }

  receiveRemote(event) {
    if (this.seenPatch.has(event.patch_id)) return;
    this.seenPatch.add(event.patch_id);
    this.pending.set(event.rev, event);
    while (this.pending.has(this.nextRev)) {
      const patch = this.pending.get(this.nextRev);
      this.pending.delete(this.nextRev);
      this.applyPatch(patch);
      this.nextRev += 1;
    }
  }

  render(event) {
    const nodes = new Map();
    for (const n of event.nodes) {
      nodes.set(n.node_id, { blockId: n.block_id, start: n.start_utf16, end: n.end_utf16 });
    }
    this.renders.set(event.epoch, { nodes, blocks: this.cloneDoc(), order: [...this.blockOrder] });
  }

  select(event) {
    const endpoint = (e) => this.anchorFromSnapshot(e.epoch, e.node_id, e.offset_utf16, e.affinity);
    this.selection = { anchor: endpoint(event.anchor), focus: endpoint(event.focus) };
  }

  localSplice(event) {
    if (!this.selection) throw new Error('local splice without selection');
    const a = this.resolveAnchor(this.selection.anchor);
    const f = this.resolveAnchor(this.selection.focus);
    if (a.blockId !== f.blockId) throw new Error('local splice crosses blocks');
    const lo = Math.min(a.index, f.index);
    const hi = Math.max(a.index, f.index);
    const doomed = this.blocks.get(a.blockId).slice(lo, hi);
    this.deleteIds(doomed);
    const inserted = this.insertAtoms(a.blockId, lo, event.insert ?? []);
    const index = lo + inserted.length;
    const arr = this.blocks.get(a.blockId);
    const collapsed = {
      left: index > 0 ? arr[index - 1] : null,
      right: index < arr.length ? arr[index] : null,
      affinity: 'forward',
    };
    this.selection = { anchor: { ...collapsed }, focus: { ...collapsed } };
  }

  checkpoint(event) {
    const sel = this.selectedTextAndDirection();
    this.checkpoints.push({
      checkpoint_id: event.checkpoint_id,
      blocks: this.blockOrder.map((blockId) => ({
        block_id: blockId,
        text: this.blocks.get(blockId).map((id) => this.atomText.get(id)).join(''),
      })),
      anchor: this.selection ? this.endpointObject(this.selection.anchor) : null,
      focus: this.selection ? this.endpointObject(this.selection.focus) : null,
      direction: sel.direction,
      selected_text: sel.text,
      applied_remote_rev: this.nextRev - 1,
    });
  }

  process(event) {
    switch (event.type) {
      case 'bootstrap': this.bootstrap(event.blocks); break;
      case 'render': this.render(event); break;
      case 'selection': this.select(event); break;
      case 'local_splice': this.localSplice(event); break;
      case 'remote': this.receiveRemote(event); break;
      case 'checkpoint': this.checkpoint(event); break;
      default: throw new Error(`unknown event ${event.type}`);
    }
  }
}

export function replayEvents(events) {
  const replay = new Replay();
  for (const event of events) replay.process(event);
  return { checkpoints: replay.checkpoints };
}

function parseArgs(argv) {
  let input = '/app/data/capture.jsonl';
  let output = '/app/editor_audit.json';
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--input') input = argv[++i];
    else if (argv[i] === '--output') output = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { input, output };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { input, output } = parseArgs(process.argv);
  const events = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const result = replayEvents(events);
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
