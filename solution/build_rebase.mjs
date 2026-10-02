import fs from 'node:fs';

const u16len = (s) => s.length;
const deep = (x) => structuredClone(x);

class History {
  constructor() {
    this.text = new Map();
    this.links = new Map();
    this.origin = new Map();
    this.alias = new Map();
  }

  canon(id) {
    if (id == null) return null;
    const seen = new Set();
    let cur = id;
    while (this.alias.has(cur)) {
      if (seen.has(cur)) throw new Error(`alias cycle at ${cur}`);
      seen.add(cur);
      cur = this.alias.get(cur);
    }
    return cur;
  }

  addAliases(mapping = {}) {
    for (const [from, to] of Object.entries(mapping)) {
      this.alias.set(from, to);
      if (this.text.has(from) && !this.text.has(to)) this.text.set(to, this.text.get(from));
      if (this.origin.has(from) && !this.origin.has(to)) this.origin.set(to, { ...this.origin.get(from) });
    }
  }
}

class Doc {
  constructor(history) {
    this.history = history;
    this.order = [];
    this.blocks = new Map();
  }

  clone() {
    const out = new Doc(this.history);
    out.order = [...this.order];
    for (const b of this.order) out.blocks.set(b, [...this.blocks.get(b)]);
    return out;
  }

  liveLoc(atomId) {
    if (atomId == null) return null;
    const id = this.history.canon(atomId);
    for (const blockId of this.order) {
      const index = this.blocks.get(blockId).indexOf(id);
      if (index !== -1) return { blockId, index };
    }
    return null;
  }

  chase(atomId, direction) {
    const seen = new Set();
    let cur = atomId;
    while (cur != null) {
      cur = this.history.canon(cur);
      if (seen.has(cur)) throw new Error(`history cycle at ${cur}`);
      seen.add(cur);
      if (this.liveLoc(cur)) return cur;
      const link = this.history.links.get(cur) ?? this.history.origin.get(cur);
      if (!link) return null;
      cur = direction === 'prev' ? link.prev : link.next;
    }
    return null;
  }

  resolve(boundary) {
    const left = this.chase(boundary.left ?? null, 'prev');
    const right = this.chase(boundary.right ?? null, 'next');
    const ll = left == null ? null : this.liveLoc(left);
    const rr = right == null ? null : this.liveLoc(right);
    const affinity = boundary.affinity ?? 'forward';
    if (ll && rr) return affinity === 'backward' ? { blockId: ll.blockId, index: ll.index + 1 } : rr;
    if (ll) return { blockId: ll.blockId, index: ll.index + 1 };
    if (rr) return rr;
    if (this.order.length === 0) throw new Error('empty document');
    const blockId = affinity === 'forward' ? this.order[0] : this.order.at(-1);
    return { blockId, index: affinity === 'forward' ? 0 : this.blocks.get(blockId).length };
  }

  rememberOrigin(atoms, blockId, index) {
    const ids = this.blocks.get(blockId);
    const left = index > 0 ? ids[index - 1] : null;
    const right = index < ids.length ? ids[index] : null;
    let prev = left;
    for (let i = 0; i < atoms.length; i += 1) {
      const atom = atoms[i];
      if (!this.history.text.has(atom.id)) this.history.text.set(atom.id, atom.text);
      const next = i + 1 < atoms.length ? atoms[i + 1].id : right;
      if (!this.history.origin.has(atom.id)) this.history.origin.set(atom.id, { prev, next });
      prev = atom.id;
    }
  }

  insert(blockId, index, atoms = []) {
    if (!this.blocks.has(blockId)) throw new Error(`missing block ${blockId}`);
    this.rememberOrigin(atoms, blockId, index);
    const live = new Set(this.order.flatMap((b) => this.blocks.get(b)));
    const ids = [];
    for (const atom of atoms) {
      const id = this.history.canon(atom.id);
      if (live.has(id)) throw new Error(`duplicate live atom ${id}`);
      if (!this.history.text.has(id)) this.history.text.set(id, atom.text);
      ids.push(id);
    }
    this.blocks.get(blockId).splice(index, 0, ...ids);
    return ids;
  }

  delete(atomIds = []) {
    const targets = new Set(atomIds.map((id) => this.history.canon(id)));
    for (const blockId of this.order) {
      const ids = this.blocks.get(blockId);
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (targets.has(id) && !this.history.links.has(id)) {
          this.history.links.set(id, {
            prev: i > 0 ? ids[i - 1] : null,
            next: i + 1 < ids.length ? ids[i + 1] : null,
          });
        }
      }
    }
    for (const blockId of this.order) this.blocks.set(blockId, this.blocks.get(blockId).filter((id) => !targets.has(id)));
  }

  split(boundary, newBlock) {
    const point = this.resolve(boundary);
    if (this.blocks.has(newBlock)) throw new Error(`block exists ${newBlock}`);
    const arr = this.blocks.get(point.blockId);
    const suffix = arr.splice(point.index);
    const pos = this.order.indexOf(point.blockId);
    this.order.splice(pos + 1, 0, newBlock);
    this.blocks.set(newBlock, suffix);
  }

  merge(left, right, separator = []) {
    if (!this.blocks.has(left) || !this.blocks.has(right)) return;
    const lp = this.order.indexOf(left);
    const rp = this.order.indexOf(right);
    if (rp !== lp + 1) return;
    this.insert(left, this.blocks.get(left).length, separator);
    this.blocks.get(left).push(...this.blocks.get(right));
    this.blocks.delete(right);
    this.order.splice(rp, 1);
  }

  move(block, after) {
    if (!this.blocks.has(block)) return;
    this.order.splice(this.order.indexOf(block), 1);
    if (after == null) this.order.unshift(block);
    else if (this.order.includes(after)) this.order.splice(this.order.indexOf(after) + 1, 0, block);
    else this.order.push(block);
  }
}

class RebaseReplay {
  constructor() {
    this.history = new History();
    this.canonical = new Doc(this.history);
    this.optimistic = new Doc(this.history);
    this.renders = new Map();
    this.selection = null;
    this.locals = [];
    this.localById = new Map();
    this.seenFrames = new Set();
    this.pending = { text: new Map(), tree: new Map() };
    this.clock = { text: 0, tree: 0 };
    this.checkpoints = [];
  }

  bootstrap(event) {
    this.canonical = new Doc(this.history);
    for (const block of event.blocks) {
      this.canonical.order.push(block.id);
      this.canonical.blocks.set(block.id, []);
      for (const atom of block.atoms) {
        this.history.text.set(atom.id, atom.text);
        this.canonical.blocks.get(block.id).push(atom.id);
      }
    }
    this.optimistic = this.canonical.clone();
  }

  endpointFromRender(endpoint) {
    const snap = this.renders.get(endpoint.epoch);
    if (!snap) throw new Error(`unknown epoch ${endpoint.epoch}`);
    const node = snap.nodes.get(endpoint.node_id);
    if (!node) throw new Error(`unknown node ${endpoint.node_id}`);
    const absolute = node.start_utf16 + endpoint.offset_utf16;
    const ids = snap.blocks.get(node.block_id);
    let total = 0;
    let index = absolute === 0 ? 0 : null;
    for (let i = 0; i < ids.length && index == null; i += 1) {
      if (total === absolute) index = i;
      total += u16len(this.history.text.get(this.history.canon(ids[i])));
      if (total === absolute) index = i + 1;
      else if (total > absolute) throw new Error('endpoint is not on an atom boundary');
    }
    if (index == null && total === absolute) index = ids.length;
    if (index == null) throw new Error('bad endpoint');
    return {
      left: index > 0 ? ids[index - 1] : null,
      right: index < ids.length ? ids[index] : null,
      affinity: endpoint.affinity,
    };
  }

  endpointObject(boundary) {
    const p = this.optimistic.resolve(boundary);
    const text = this.optimistic.blocks.get(p.blockId).slice(0, p.index)
      .map((id) => this.history.text.get(this.history.canon(id))).join('');
    return { block_id: p.blockId, utf16: u16len(text), affinity: boundary.affinity };
  }

  selectedTextAndDirection() {
    if (!this.selection) return { text: '', direction: 'none' };
    const a = this.optimistic.resolve(this.selection.anchor);
    const f = this.optimistic.resolve(this.selection.focus);
    const ap = [this.optimistic.order.indexOf(a.blockId), a.index];
    const fp = [this.optimistic.order.indexOf(f.blockId), f.index];
    const cmp = ap[0] === fp[0] ? Math.sign(ap[1] - fp[1]) : Math.sign(ap[0] - fp[0]);
    if (cmp === 0) return { text: '', direction: 'none' };
    const direction = cmp < 0 ? 'forward' : 'backward';
    const lo = cmp < 0 ? a : f;
    const hi = cmp < 0 ? f : a;
    const lp = this.optimistic.order.indexOf(lo.blockId);
    const hp = this.optimistic.order.indexOf(hi.blockId);
    const textOf = (ids) => ids.map((id) => this.history.text.get(this.history.canon(id))).join('');
    if (lp === hp) return { text: textOf(this.optimistic.blocks.get(lo.blockId).slice(lo.index, hi.index)), direction };
    const parts = [textOf(this.optimistic.blocks.get(lo.blockId).slice(lo.index))];
    for (let i = lp + 1; i < hp; i += 1) parts.push(textOf(this.optimistic.blocks.get(this.optimistic.order[i])));
    parts.push(textOf(this.optimistic.blocks.get(hi.blockId).slice(0, hi.index)));
    return { text: parts.join('\n'), direction };
  }

  captureLocal(event) {
    if (!this.selection) throw new Error('local batch without selection');
    if (event.action === 'replace_selection') {
      const a = this.optimistic.resolve(this.selection.anchor);
      const f = this.optimistic.resolve(this.selection.focus);
      if (a.blockId !== f.blockId) throw new Error('cross-block replace_selection');
      const lo = Math.min(a.index, f.index);
      const hi = Math.max(a.index, f.index);
      const ids = this.optimistic.blocks.get(a.blockId);
      return {
        batch_id: event.batch_id,
        action: event.action,
        boundary: {
          left: lo > 0 ? ids[lo - 1] : null,
          right: hi < ids.length ? ids[hi] : null,
          affinity: 'forward',
        },
        delete: ids.slice(lo, hi),
        insert: deep(event.insert ?? []),
      };
    }
    if (event.action === 'split_at_focus') {
      const p = this.optimistic.resolve(this.selection.focus);
      const ids = this.optimistic.blocks.get(p.blockId);
      return {
        batch_id: event.batch_id,
        action: event.action,
        boundary: {
          left: p.index > 0 ? ids[p.index - 1] : null,
          right: p.index < ids.length ? ids[p.index] : null,
          affinity: this.selection.focus.affinity,
        },
        new_block: event.new_block,
      };
    }
    throw new Error(`unknown local action ${event.action}`);
  }

  applyIntent(doc, intent, updateSelection) {
    if (intent.action === 'replace_selection') {
      doc.delete(intent.delete);
      const point = doc.resolve(intent.boundary);
      const inserted = doc.insert(point.blockId, point.index, intent.insert);
      if (updateSelection) {
        const index = point.index + inserted.length;
        const ids = doc.blocks.get(point.blockId);
        const collapsed = {
          left: index > 0 ? ids[index - 1] : null,
          right: index < ids.length ? ids[index] : null,
          affinity: 'forward',
        };
        this.selection = { anchor: { ...collapsed }, focus: { ...collapsed } };
      }
      return;
    }
    if (intent.action === 'split_at_focus') {
      doc.split(intent.boundary, intent.new_block);
      if (updateSelection) {
        const point = doc.resolve({ ...intent.boundary, affinity: 'forward' });
        const ids = doc.blocks.get(point.blockId);
        const collapsed = {
          left: point.index > 0 ? ids[point.index - 1] : null,
          right: point.index < ids.length ? ids[point.index] : null,
          affinity: 'forward',
        };
        this.selection = { anchor: { ...collapsed }, focus: { ...collapsed } };
      }
      return;
    }
    throw new Error(`unknown intent ${intent.action}`);
  }

  rebuildOptimistic() {
    this.optimistic = this.canonical.clone();
    for (const intent of this.locals) this.applyIntent(this.optimistic, intent, false);
  }

  applyServerOp(op) {
    if (op.kind === 'splice') {
      const boundary = { left: op.left ?? null, right: op.right ?? null, affinity: op.affinity ?? 'forward' };
      this.canonical.delete(op.delete ?? []);
      const p = this.canonical.resolve(boundary);
      this.canonical.insert(p.blockId, p.index, op.insert ?? []);
    } else if (op.kind === 'split') {
      this.canonical.split({ left: op.left ?? null, right: op.right ?? null, affinity: op.affinity ?? 'forward' }, op.new_block);
    } else if (op.kind === 'merge') {
      this.canonical.merge(op.left_block, op.right_block, op.separator ?? []);
    } else if (op.kind === 'move') {
      this.canonical.move(op.block, op.after ?? null);
    } else {
      throw new Error(`unknown server op ${op.kind}`);
    }
  }

  enabled(frame) {
    if (frame.seq !== this.clock[frame.lane] + 1) return false;
    for (const [lane, value] of Object.entries(frame.depends ?? {})) if (this.clock[lane] < value) return false;
    return true;
  }

  drain() {
    while (true) {
      const candidates = [];
      for (const lane of ['text', 'tree']) {
        const frame = this.pending[lane].get(this.clock[lane] + 1);
        if (frame && this.enabled(frame)) candidates.push(frame);
      }
      if (candidates.length === 0) return;
      candidates.sort((a, b) => a.server_time - b.server_time || a.frame_id.localeCompare(b.frame_id));
      const frame = candidates[0];
      this.pending[frame.lane].delete(frame.seq);
      const decision = frame.ack_local ?? frame.reject_local ?? null;
      if (decision != null) this.locals = this.locals.filter((x) => x.batch_id !== decision);
      this.history.addAliases(frame.id_map ?? {});
      for (const op of frame.ops ?? []) this.applyServerOp(op);
      this.clock[frame.lane] += 1;
      this.rebuildOptimistic();
    }
  }

  process(event) {
    if (event.type === 'bootstrap') {
      this.bootstrap(event);
    } else if (event.type === 'render') {
      const nodes = new Map();
      for (const n of event.nodes) nodes.set(n.node_id, deep(n));
      const blocks = new Map();
      for (const b of this.optimistic.order) blocks.set(b, [...this.optimistic.blocks.get(b)]);
      this.renders.set(event.epoch, { nodes, blocks });
    } else if (event.type === 'selection') {
      this.selection = {
        anchor: this.endpointFromRender(event.anchor),
        focus: this.endpointFromRender(event.focus),
      };
    } else if (event.type === 'local_batch') {
      const intent = this.captureLocal(event);
      this.localById.set(intent.batch_id, deep(intent));
      this.locals.push(intent);
      this.applyIntent(this.optimistic, intent, true);
    } else if (event.type === 'delivery') {
      const frame = event.frame;
      if (this.seenFrames.has(frame.frame_id)) return;
      this.seenFrames.add(frame.frame_id);
      this.pending[frame.lane].set(frame.seq, deep(frame));
      this.drain();
    } else if (event.type === 'checkpoint') {
      const sel = this.selectedTextAndDirection();
      const textOf = (ids) => ids.map((id) => this.history.text.get(this.history.canon(id))).join('');
      this.checkpoints.push({
        checkpoint_id: event.checkpoint_id,
        blocks: this.optimistic.order.map((b) => ({ block_id: b, text: textOf(this.optimistic.blocks.get(b)) })),
        anchor: this.selection ? this.endpointObject(this.selection.anchor) : null,
        focus: this.selection ? this.endpointObject(this.selection.focus) : null,
        direction: sel.direction,
        selected_text: sel.text,
        remote_clock: { ...this.clock },
        pending_local: this.locals.map((x) => x.batch_id),
      });
    } else {
      throw new Error(`unknown event ${event.type}`);
    }
  }
}

export function replayRebase(events) {
  const replay = new RebaseReplay();
  for (const event of events) replay.process(event);
  return { checkpoints: replay.checkpoints };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '/app/data/rebase_capture.jsonl';
  let output = '/app/rebase_audit.json';
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--input') input = process.argv[++i];
    else if (process.argv[i] === '--output') output = process.argv[++i];
    else throw new Error(`unknown argument ${process.argv[i]}`);
  }
  const events = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  fs.writeFileSync(output, `${JSON.stringify(replayRebase(events), null, 2)}\n`);
}
