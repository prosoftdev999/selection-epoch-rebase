import copy
import json


def u16len(text):
    return len(text.encode("utf-16-le")) // 2


class OracleReplay:
    def __init__(self):
        self.order = []
        self.blocks = {}
        self.text = {}
        self.tomb = {}
        self.renders = {}
        self.selection = None
        self.pending = {}
        self.seen = set()
        self.next_rev = 1
        self.out = []

    def location(self, atom_id):
        if atom_id is None:
            return None
        for block_id in self.order:
            try:
                return block_id, self.blocks[block_id].index(atom_id)
            except ValueError:
                continue
        return None

    def chase(self, atom_id, direction):
        seen = set()
        while atom_id is not None:
            if atom_id in seen:
                raise ValueError("tombstone cycle")
            seen.add(atom_id)
            if self.location(atom_id):
                return atom_id
            link = self.tomb.get(atom_id)
            if link is None:
                return None
            atom_id = link[direction]
        return None

    def snapshot_anchor(self, endpoint):
        snap = self.renders[endpoint["epoch"]]
        node = snap["nodes"][endpoint["node_id"]]
        absolute = node["start"] + endpoint["offset_utf16"]
        ids = snap["blocks"][node["block"]]
        offsets = [0]
        for atom_id in ids:
            offsets.append(offsets[-1] + u16len(self.text[atom_id]))
        if absolute not in offsets:
            raise ValueError("selection endpoint not on atom boundary")
        idx = offsets.index(absolute)
        return {
            "left": ids[idx - 1] if idx else None,
            "right": ids[idx] if idx < len(ids) else None,
            "affinity": endpoint["affinity"],
        }

    def resolve(self, boundary):
        left = self.chase(boundary.get("left"), "prev")
        right = self.chase(boundary.get("right"), "next")
        lloc = self.location(left) if left else None
        rloc = self.location(right) if right else None
        affinity = boundary.get("affinity", "forward")
        if lloc and rloc:
            lb, li = lloc
            rb, ri = rloc
            if lb == rb:
                return (lb, li + 1) if affinity == "backward" else (rb, ri)
            return (lb, li + 1) if affinity == "backward" else (rb, ri)
        if lloc:
            return lloc[0], lloc[1] + 1
        if rloc:
            return rloc
        block_id = self.order[0] if affinity == "forward" else self.order[-1]
        return (block_id, 0) if affinity == "forward" else (block_id, len(self.blocks[block_id]))

    def delete(self, atom_ids):
        targets = set(atom_ids)
        for block_id in self.order:
            ids = self.blocks[block_id]
            for i, atom_id in enumerate(ids):
                if atom_id in targets and atom_id not in self.tomb:
                    self.tomb[atom_id] = {
                        "prev": ids[i - 1] if i else None,
                        "next": ids[i + 1] if i + 1 < len(ids) else None,
                    }
        for block_id in self.order:
            self.blocks[block_id] = [a for a in self.blocks[block_id] if a not in targets]

    def insert(self, block_id, index, atoms):
        ids = []
        for atom in atoms:
            if atom["id"] in self.text:
                raise ValueError("duplicate atom")
            self.text[atom["id"]] = atom["text"]
            ids.append(atom["id"])
        self.blocks[block_id][index:index] = ids
        return ids

    def apply_op(self, op):
        kind = op["kind"]
        if kind == "splice":
            boundary = {"left": op.get("left"), "right": op.get("right"), "affinity": op.get("affinity", "forward")}
            self.delete(op.get("delete", []))
            block_id, index = self.resolve(boundary)
            self.insert(block_id, index, op.get("insert", []))
        elif kind == "split":
            boundary = {"left": op.get("left"), "right": op.get("right"), "affinity": op.get("affinity", "forward")}
            block_id, index = self.resolve(boundary)
            new_block = op["new_block"]
            suffix = self.blocks[block_id][index:]
            self.blocks[block_id] = self.blocks[block_id][:index]
            pos = self.order.index(block_id)
            self.order.insert(pos + 1, new_block)
            self.blocks[new_block] = suffix
        elif kind == "merge":
            left = op["left_block"]
            right = op["right_block"]
            self.insert(left, len(self.blocks[left]), op.get("separator", []))
            self.blocks[left].extend(self.blocks[right])
            del self.blocks[right]
            self.order.remove(right)
        else:
            raise ValueError(f"unknown op {kind}")

    def remote(self, event):
        if event["patch_id"] in self.seen:
            return
        self.seen.add(event["patch_id"])
        self.pending[event["rev"]] = event
        while self.next_rev in self.pending:
            patch = self.pending.pop(self.next_rev)
            for op in patch["ops"]:
                self.apply_op(op)
            self.next_rev += 1

    def endpoint(self, boundary):
        block_id, index = self.resolve(boundary)
        prefix = "".join(self.text[a] for a in self.blocks[block_id][:index])
        return {"block_id": block_id, "utf16": u16len(prefix), "affinity": boundary["affinity"]}

    def selected(self):
        if self.selection is None:
            return "", "none"
        anchor = self.resolve(self.selection["anchor"])
        focus = self.resolve(self.selection["focus"])
        apos = (self.order.index(anchor[0]), anchor[1])
        fpos = (self.order.index(focus[0]), focus[1])
        if apos == fpos:
            return "", "none"
        direction = "forward" if apos < fpos else "backward"
        low, high = (anchor, focus) if apos < fpos else (focus, anchor)
        lo_block, lo_idx = low
        hi_block, hi_idx = high
        lo_pos = self.order.index(lo_block)
        hi_pos = self.order.index(hi_block)
        if lo_pos == hi_pos:
            return "".join(self.text[a] for a in self.blocks[lo_block][lo_idx:hi_idx]), direction
        parts = ["".join(self.text[a] for a in self.blocks[lo_block][lo_idx:])]
        for p in range(lo_pos + 1, hi_pos):
            parts.append("".join(self.text[a] for a in self.blocks[self.order[p]]))
        parts.append("".join(self.text[a] for a in self.blocks[hi_block][:hi_idx]))
        return "\n".join(parts), direction

    def process(self, event):
        kind = event["type"]
        if kind == "bootstrap":
            for block in event["blocks"]:
                self.order.append(block["id"])
                self.blocks[block["id"]] = []
                for atom in block["atoms"]:
                    self.blocks[block["id"]].append(atom["id"])
                    self.text[atom["id"]] = atom["text"]
        elif kind == "render":
            self.renders[event["epoch"]] = {
                "nodes": {
                    n["node_id"]: {"block": n["block_id"], "start": n["start_utf16"], "end": n["end_utf16"]}
                    for n in event["nodes"]
                },
                "blocks": {b: list(self.blocks[b]) for b in self.order},
            }
        elif kind == "selection":
            self.selection = {"anchor": self.snapshot_anchor(event["anchor"]), "focus": self.snapshot_anchor(event["focus"])}
        elif kind == "local_splice":
            anchor = self.resolve(self.selection["anchor"])
            focus = self.resolve(self.selection["focus"])
            if anchor[0] != focus[0]:
                raise ValueError("cross-block local splice")
            block_id = anchor[0]
            lo, hi = sorted((anchor[1], focus[1]))
            self.delete(self.blocks[block_id][lo:hi])
            inserted = self.insert(block_id, lo, event.get("insert", []))
            index = lo + len(inserted)
            ids = self.blocks[block_id]
            collapsed = {
                "left": ids[index - 1] if index else None,
                "right": ids[index] if index < len(ids) else None,
                "affinity": "forward",
            }
            self.selection = {"anchor": copy.deepcopy(collapsed), "focus": copy.deepcopy(collapsed)}
        elif kind == "remote":
            self.remote(event)
        elif kind == "checkpoint":
            selected_text, direction = self.selected()
            self.out.append({
                "checkpoint_id": event["checkpoint_id"],
                "blocks": [{"block_id": b, "text": "".join(self.text[a] for a in self.blocks[b])} for b in self.order],
                "anchor": self.endpoint(self.selection["anchor"]) if self.selection else None,
                "focus": self.endpoint(self.selection["focus"]) if self.selection else None,
                "direction": direction,
                "selected_text": selected_text,
                "applied_remote_rev": self.next_rev - 1,
            })
        else:
            raise ValueError(f"unknown event {kind}")


def replay_file(path):
    replay = OracleReplay()
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                replay.process(json.loads(line))
    return {"checkpoints": replay.out}
