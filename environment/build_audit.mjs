import fs from 'node:fs';

class Replay {
  constructor() {
    this.order = [];
    this.blocks = new Map();
    this.text = new Map();
    this.renders = new Map();
    this.selection = null;
    this.pending = new Map();
    this.seen = new Set();
    this.nextRev = 1;
    this.checkpoints = [];
  }

  bootstrap(blocks) {
    for (const block of blocks) {
      this.order.push(block.id);
      this.blocks.set(block.id, block.atoms.map((a) => a.id));
      for (const atom of block.atoms) this.text.set(atom.id, atom.text);
    }
  }

  findAtom(id) {
    if (id == null) return null;
    for (const blockId of this.order) {
      const index = this.blocks.get(blockId).indexOf(id);
      if (index >= 0) return { blockId, index };
    }
    return null;
  }

  pointFromEndpoint(endpoint) {
    const render = this.renders.get(endpoint.epoch);
    const node = render?.get(endpoint.node_id);
    if (!node) throw new Error('unknown render endpoint');
    const ids = this.blocks.get(node.blockId) ?? [];
    const wanted = node.start + endpoint.offset_utf16;
    let width = 0;
    let index = 0;
    for (let i = 0; i < ids.length; i += 1) {
      const next = width + this.text.get(ids[i]).length;
      if (wanted <= width) { index = i; break; }
      if (wanted <= next) {
        index = wanted === next || endpoint.affinity === 'forward' ? i + 1 : i;
        break;
      }
      width = next;
      index = i + 1;
    }
    return { blockId: node.blockId, index, affinity: endpoint.affinity };
  }

  removeIds(ids) {
    const remove = new Set(ids);
    for (const blockId of this.order) {
      this.blocks.set(blockId, this.blocks.get(blockId).filter((id) => !remove.has(id)));
    }
  }

  insertAtoms(blockId, index, atoms) {
    const ids = [];
    for (const atom of atoms) {
      if (!this.text.has(atom.id)) this.text.set(atom.id, atom.text);
      ids.push(atom.id);
    }
    this.blocks.get(blockId).splice(index, 0, ...ids);
    return ids.length;
  }

  boundary(left, right) {
    const l = this.findAtom(left);
    const r = this.findAtom(right);
    if (l && r && l.blockId === r.blockId) return { blockId: r.blockId, index: r.index };
    if (r) return { blockId: r.blockId, index: r.index };
    if (l) return { blockId: l.blockId, index: l.index + 1 };
    const blockId = this.order[0];
    return { blockId, index: 0 };
  }

  applyOp(op) {
    if (op.kind === 'splice') {
      this.removeIds(op.delete ?? []);
      const p = this.boundary(op.left ?? null, op.right ?? null);
      this.insertAtoms(p.blockId, p.index, op.insert ?? []);
      return;
    }
    if (op.kind === 'split') {
      const p = this.boundary(op.left ?? null, op.right ?? null);
      const suffix = this.blocks.get(p.blockId).splice(p.index);
      const pos = this.order.indexOf(p.blockId);
      this.order.splice(pos + 1, 0, op.new_block);
      this.blocks.set(op.new_block, suffix);
      return;
    }
    if (op.kind === 'merge') {
      const left = op.left_block;
      const right = op.right_block;
      this.insertAtoms(left, this.blocks.get(left).length, op.separator ?? []);
      this.blocks.get(left).push(...(this.blocks.get(right) ?? []));
      this.blocks.delete(right);
      this.order = this.order.filter((b) => b !== right);
    }
  }

  drainAll() {
    while (this.pending.has(this.nextRev)) {
      const patch = this.pending.get(this.nextRev);
      this.pending.delete(this.nextRev);
      for (const op of patch.ops) this.applyOp(op);
      this.nextRev += 1;
    }
  }

  receiveRemote(event) {
    if (this.seen.has(event.patch_id)) return;
    this.seen.add(event.patch_id);
    this.pending.set(event.rev, event);
    if (this.pending.has(this.nextRev)) {
      const patch = this.pending.get(this.nextRev);
      this.pending.delete(this.nextRev);
      for (const op of patch.ops) this.applyOp(op);
      this.nextRev += 1;
    }
  }

  localSplice(event) {
    if (!this.selection) return;
    const a = this.selection.anchor;
    const f = this.selection.focus;
    if (a.blockId !== f.blockId || !this.blocks.has(a.blockId)) return;
    const lo = Math.min(a.index, f.index);
    const hi = Math.max(a.index, f.index);
    const ids = this.blocks.get(a.blockId);
    this.removeIds(ids.slice(lo, hi));
    const count = this.insertAtoms(a.blockId, lo, event.insert ?? []);
    const point = { blockId: a.blockId, index: lo + count, affinity: 'forward' };
    this.selection = { anchor: { ...point }, focus: { ...point } };
  }

  endpoint(point) {
    if (!point || !this.blocks.has(point.blockId)) return null;
    const ids = this.blocks.get(point.blockId).slice(0, Math.min(point.index, this.blocks.get(point.blockId).length));
    return { block_id: point.blockId, utf16: ids.map((id) => this.text.get(id)).join('').length, affinity: point.affinity };
  }

  compare(a, b) {
    const ap = this.order.indexOf(a.blockId);
    const bp = this.order.indexOf(b.blockId);
    return ap === bp ? Math.sign(a.index - b.index) : Math.sign(ap - bp);
  }

  selectedText() {
    if (!this.selection) return { text: '', direction: 'none' };
    const a = this.selection.anchor;
    const f = this.selection.focus;
    if (!this.blocks.has(a.blockId) || !this.blocks.has(f.blockId)) return { text: '', direction: 'none' };
    const cmp = this.compare(a, f);
    if (cmp === 0) return { text: '', direction: 'none' };
    const direction = cmp < 0 ? 'forward' : 'backward';
    const lo = cmp < 0 ? a : f;
    const hi = cmp < 0 ? f : a;
    const lpos = this.order.indexOf(lo.blockId);
    const hpos = this.order.indexOf(hi.blockId);
    if (lpos === hpos) {
      return { text: this.blocks.get(lo.blockId).slice(lo.index, hi.index).map((id) => this.text.get(id)).join(''), direction };
    }
    const parts = [this.blocks.get(lo.blockId).slice(lo.index).map((id) => this.text.get(id)).join('')];
    for (let i = lpos + 1; i < hpos; i += 1) parts.push(this.blocks.get(this.order[i]).map((id) => this.text.get(id)).join(''));
    parts.push(this.blocks.get(hi.blockId).slice(0, hi.index).map((id) => this.text.get(id)).join(''));
    return { text: parts.join('\n'), direction };
  }

  checkpoint(event) {
    const selected = this.selectedText();
    this.checkpoints.push({
      checkpoint_id: event.checkpoint_id,
      blocks: this.order.map((blockId) => ({ block_id: blockId, text: this.blocks.get(blockId).map((id) => this.text.get(id)).join('') })),
      anchor: this.endpoint(this.selection?.anchor),
      focus: this.endpoint(this.selection?.focus),
      direction: selected.direction,
      selected_text: selected.text,
      applied_remote_rev: this.nextRev - 1,
    });
  }

  process(event) {
    if (!['bootstrap', 'remote', 'checkpoint'].includes(event.type)) this.drainAll();
    if (event.type === 'bootstrap') this.bootstrap(event.blocks);
    else if (event.type === 'render') {
      const nodes = new Map();
      for (const n of event.nodes) nodes.set(n.node_id, { blockId: n.block_id, start: n.start_utf16, end: n.end_utf16 });
      this.renders.set(event.epoch, nodes);
    } else if (event.type === 'selection') {
      this.selection = { anchor: this.pointFromEndpoint(event.anchor), focus: this.pointFromEndpoint(event.focus) };
    } else if (event.type === 'local_splice') this.localSplice(event);
    else if (event.type === 'remote') this.receiveRemote(event);
    else if (event.type === 'checkpoint') this.checkpoint(event);
  }
}

function parseArgs(argv) {
  let input = '/app/data/capture.jsonl';
  let output = '/app/editor_audit.json';
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--input') input = argv[++i];
    else if (argv[i] === '--output') output = argv[++i];
  }
  return { input, output };
}

const { input, output } = parseArgs(process.argv);
const events = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const replay = new Replay();
for (const event of events) replay.process(event);
fs.writeFileSync(output, `${JSON.stringify({ checkpoints: replay.checkpoints }, null, 2)}\n`);
