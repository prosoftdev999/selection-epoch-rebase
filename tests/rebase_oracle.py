import json, copy, random
from dataclasses import dataclass
from pathlib import Path


def u16len(s): return len(s.encode('utf-16-le'))//2

class Doc:
    def __init__(self, hist):
        self.order=[]; self.blocks={}; self.hist=hist
    def clone(self):
        d=Doc(self.hist); d.order=list(self.order); d.blocks={b:list(v) for b,v in self.blocks.items()}; return d
    def loc(self, aid):
        if aid is None: return None
        aid=self.hist.canon(aid)
        for b in self.order:
            try: return b,self.blocks[b].index(aid)
            except ValueError: pass
        return None
    def chase(self, aid, direction):
        seen=set()
        while aid is not None:
            aid=self.hist.canon(aid)
            if aid in seen: raise ValueError('cycle '+str(aid))
            seen.add(aid)
            if self.loc(aid): return aid
            link=self.hist.links.get(aid) or self.hist.origin.get(aid)
            if not link: return None
            aid=link['prev' if direction=='prev' else 'next']
        return None
    def resolve(self,bound):
        left=self.chase(bound.get('left'),'prev'); right=self.chase(bound.get('right'),'next')
        ll=self.loc(left) if left else None; rr=self.loc(right) if right else None
        aff=bound.get('affinity','forward')
        if ll and rr:
            if aff=='backward': return ll[0],ll[1]+1
            return rr
        if ll: return ll[0],ll[1]+1
        if rr: return rr
        if not self.order: raise ValueError('empty doc')
        b=self.order[0] if aff=='forward' else self.order[-1]
        return (b,0) if aff=='forward' else (b,len(self.blocks[b]))
    def remember_origin(self, atoms, b, idx):
        ids=self.blocks[b]
        left=ids[idx-1] if idx else None; right=ids[idx] if idx<len(ids) else None
        prev=left
        for i,a in enumerate(atoms):
            aid=a['id']; self.hist.text.setdefault(aid,a['text'])
            nxt=atoms[i+1]['id'] if i+1<len(atoms) else right
            self.hist.origin.setdefault(aid, {'prev':prev,'next':nxt})
            prev=aid
    def insert(self,b,idx,atoms):
        if b not in self.blocks: raise ValueError('missing block '+b)
        self.remember_origin(atoms,b,idx)
        ids=[]
        live={a for bb in self.order for a in self.blocks[bb]}
        for a in atoms:
            aid=self.hist.canon(a['id'])
            if aid in live: raise ValueError('duplicate live '+aid)
            self.hist.text.setdefault(aid,a['text'])
            ids.append(aid)
        self.blocks[b][idx:idx]=ids
        return ids
    def delete(self, atom_ids):
        targets={self.hist.canon(a) for a in atom_ids}
        for b in list(self.order):
            ids=self.blocks[b]
            for i,aid in enumerate(ids):
                if aid in targets:
                    self.hist.links.setdefault(aid, {'prev': ids[i-1] if i else None, 'next': ids[i+1] if i+1<len(ids) else None})
        for b in list(self.order):
            self.blocks[b]=[a for a in self.blocks[b] if a not in targets]
    def split(self,bound,new_block):
        b,idx=self.resolve(bound)
        if new_block in self.blocks: raise ValueError('block exists '+new_block)
        suffix=self.blocks[b][idx:]; self.blocks[b]=self.blocks[b][:idx]
        p=self.order.index(b); self.order.insert(p+1,new_block); self.blocks[new_block]=suffix
    def merge(self,left,right,separator):
        if left not in self.blocks or right not in self.blocks: return
        if self.order.index(right)!=self.order.index(left)+1: return
        self.insert(left,len(self.blocks[left]),separator)
        self.blocks[left].extend(self.blocks[right]); del self.blocks[right]; self.order.remove(right)
    def move_block(self,block,after):
        if block not in self.blocks: return
        self.order.remove(block)
        if after is None: self.order.insert(0,block)
        elif after in self.order: self.order.insert(self.order.index(after)+1,block)
        else: self.order.append(block)

class History:
    def __init__(self): self.text={}; self.links={}; self.origin={}; self.alias={}
    def canon(self,a):
        if a is None: return None
        seen=set()
        while a in self.alias:
            if a in seen: raise ValueError('alias cycle')
            seen.add(a); a=self.alias[a]
        return a
    def add_aliases(self,m):
        for a,b in m.items():
            self.alias[a]=b
            if a in self.text and b not in self.text: self.text[b]=self.text[a]
            if a in self.origin and b not in self.origin:
                self.origin[b]=dict(self.origin[a])

class AdvancedReplay:
    def __init__(self):
        self.hist=History(); self.canonical=Doc(self.hist); self.optimistic=Doc(self.hist)
        self.renders={}; self.selection=None; self.locals=[]; self.local_by_id={}
        self.seen_frames=set(); self.pending={'text':{},'tree':{}}; self.clock={'text':0,'tree':0}; self.out=[]
    def bootstrap(self,e):
        self.canonical=Doc(self.hist)
        for bl in e['blocks']:
            b=bl['id']; self.canonical.order.append(b); self.canonical.blocks[b]=[]
            for a in bl['atoms']:
                self.hist.text[a['id']]=a['text']; self.canonical.blocks[b].append(a['id'])
        self.optimistic=self.canonical.clone()
    def endpoint_from_render(self,ep):
        snap=self.renders[ep['epoch']]; node=snap['nodes'][ep['node_id']]
        absu=node['start_utf16']+ep['offset_utf16']; ids=snap['blocks'][node['block_id']]
        offs=[0]
        for aid in ids: offs.append(offs[-1]+u16len(self.hist.text[self.hist.canon(aid)]))
        if absu not in offs: raise ValueError(('not boundary',ep,offs))
        i=offs.index(absu)
        return {'left':ids[i-1] if i else None,'right':ids[i] if i<len(ids) else None,'affinity':ep['affinity']}
    def endpoint_out(self,bound):
        b,i=self.optimistic.resolve(bound); txt=''.join(self.hist.text[self.hist.canon(a)] for a in self.optimistic.blocks[b][:i])
        return {'block_id':b,'utf16':u16len(txt),'affinity':bound['affinity']}
    def selected(self):
        if not self.selection: return '', 'none'
        a=self.optimistic.resolve(self.selection['anchor']); f=self.optimistic.resolve(self.selection['focus'])
        ap=(self.optimistic.order.index(a[0]),a[1]); fp=(self.optimistic.order.index(f[0]),f[1])
        if ap==fp: return '', 'none'
        direction='forward' if ap<fp else 'backward'; lo,hi=(a,f) if ap<fp else (f,a)
        lp=self.optimistic.order.index(lo[0]); hp=self.optimistic.order.index(hi[0])
        if lp==hp:
            return ''.join(self.hist.text[self.hist.canon(x)] for x in self.optimistic.blocks[lo[0]][lo[1]:hi[1]]),direction
        parts=[''.join(self.hist.text[self.hist.canon(x)] for x in self.optimistic.blocks[lo[0]][lo[1]:])]
        for p in range(lp+1,hp): parts.append(''.join(self.hist.text[self.hist.canon(x)] for x in self.optimistic.blocks[self.optimistic.order[p]]))
        parts.append(''.join(self.hist.text[self.hist.canon(x)] for x in self.optimistic.blocks[hi[0]][:hi[1]]))
        return '\n'.join(parts),direction
    def concrete_local(self,e):
        action=e['action']; intent={'batch_id':e['batch_id'],'action':action}
        if action=='replace_selection':
            if not self.selection: raise ValueError('no sel')
            a=self.optimistic.resolve(self.selection['anchor']); f=self.optimistic.resolve(self.selection['focus'])
            if a[0]!=f[0]: raise ValueError('cross local replace')
            lo,hi=sorted((a[1],f[1])); b=a[0]; ids=self.optimistic.blocks[b]
            intent['boundary']={'left':ids[lo-1] if lo else None,'right':ids[hi] if hi<len(ids) else None,'affinity':'forward'}
            intent['delete']=list(ids[lo:hi]); intent['insert']=copy.deepcopy(e.get('insert',[]))
        elif action=='split_at_focus':
            if not self.selection: raise ValueError('no sel')
            b,i=self.optimistic.resolve(self.selection['focus']); ids=self.optimistic.blocks[b]
            intent['boundary']={'left':ids[i-1] if i else None,'right':ids[i] if i<len(ids) else None,'affinity':self.selection['focus']['affinity']}
            intent['new_block']=e['new_block']
        else: raise ValueError(action)
        return intent
    def apply_intent(self,doc,intent,update_selection=False):
        if intent['action']=='replace_selection':
            doc.delete(intent['delete']); b,i=doc.resolve(intent['boundary']); ins=doc.insert(b,i,intent['insert']); idx=i+len(ins); ids=doc.blocks[b]
            if update_selection:
                c={'left':ids[idx-1] if idx else None,'right':ids[idx] if idx<len(ids) else None,'affinity':'forward'}
                self.selection={'anchor':copy.deepcopy(c),'focus':copy.deepcopy(c)}
        elif intent['action']=='split_at_focus':
            doc.split(intent['boundary'],intent['new_block'])
            if update_selection:
                # collapse at start of new block using the same boundary, forward affinity
                b,i=doc.resolve({'left':intent['boundary']['left'],'right':intent['boundary']['right'],'affinity':'forward'})
                ids=doc.blocks[b]
                c={'left':ids[i-1] if i else None,'right':ids[i] if i<len(ids) else None,'affinity':'forward'}
                self.selection={'anchor':copy.deepcopy(c),'focus':copy.deepcopy(c)}
    def rebuild(self):
        self.optimistic=self.canonical.clone()
        for intent in self.locals:
            self.apply_intent(self.optimistic,intent,update_selection=False)
    def apply_server_op(self,op):
        d=self.canonical; k=op['kind']
        if k=='splice':
            bound={'left':op.get('left'),'right':op.get('right'),'affinity':op.get('affinity','forward')}
            d.delete(op.get('delete',[])); b,i=d.resolve(bound); d.insert(b,i,op.get('insert',[]))
        elif k=='split': d.split({'left':op.get('left'),'right':op.get('right'),'affinity':op.get('affinity','forward')},op['new_block'])
        elif k=='merge': d.merge(op['left_block'],op['right_block'],op.get('separator',[]))
        elif k=='move': d.move_block(op['block'],op.get('after'))
        else: raise ValueError(k)
    def frame_enabled(self,fr):
        lane=fr['lane']
        if fr['seq']!=self.clock[lane]+1:return False
        return all(self.clock[k]>=v for k,v in fr.get('depends',{}).items())
    def drain(self):
        lane_rank={'text':0,'tree':1}
        while True:
            enabled=[]
            for lane in ('text','tree'):
                fr=self.pending[lane].get(self.clock[lane]+1)
                if fr and self.frame_enabled(fr): enabled.append(fr)
            if not enabled: break
            fr=min(enabled,key=lambda x:(x['server_time'],lane_rank[x['lane']],x['frame_id']))
            self.pending[fr['lane']].pop(fr['seq'])
            bid=fr.get('ack_local') or fr.get('reject_local')
            if bid:
                self.locals=[x for x in self.locals if x['batch_id']!=bid]
            if fr.get('id_map'): self.hist.add_aliases(fr['id_map'])
            for op in fr.get('ops',[]): self.apply_server_op(op)
            self.clock[fr['lane']]+=1
            self.rebuild()
    def delivery(self,e):
        fr=e['frame']
        if fr['frame_id'] in self.seen_frames: return
        self.seen_frames.add(fr['frame_id']); self.pending[fr['lane']][fr['seq']]=copy.deepcopy(fr); self.drain()
    def process(self,e):
        t=e['type']
        if t=='bootstrap': self.bootstrap(e)
        elif t=='render':
            self.renders[e['epoch']]={'nodes':{n['node_id']:copy.deepcopy(n) for n in e['nodes']},'blocks':{b:list(self.optimistic.blocks[b]) for b in self.optimistic.order}}
        elif t=='selection': self.selection={'anchor':self.endpoint_from_render(e['anchor']),'focus':self.endpoint_from_render(e['focus'])}
        elif t=='local_batch':
            intent=self.concrete_local(e); self.local_by_id[intent['batch_id']]=copy.deepcopy(intent); self.locals.append(intent); self.apply_intent(self.optimistic,intent,update_selection=True)
        elif t=='delivery': self.delivery(e)
        elif t=='checkpoint':
            st,di=self.selected(); self.out.append({'checkpoint_id':e['checkpoint_id'],'blocks':[{'block_id':b,'text':''.join(self.hist.text[self.hist.canon(a)] for a in self.optimistic.blocks[b])} for b in self.optimistic.order], 'anchor':self.endpoint_out(self.selection['anchor']) if self.selection else None, 'focus':self.endpoint_out(self.selection['focus']) if self.selection else None,'direction':di,'selected_text':st,'remote_clock':dict(self.clock),'pending_local':[x['batch_id'] for x in self.locals]})
        else: raise ValueError(t)



def replay_file(path):
    engine = AdvancedReplay()
    with open(path, 'r', encoding='utf-8') as handle:
        for line in handle:
            if line.strip():
                engine.process(json.loads(line))
    return {'checkpoints': engine.out}
