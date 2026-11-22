// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

const trail = (s: string): string => s.replace(/[ \t]+$/g, '');
const lead = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;
function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  const n = text.indexOf('\n'), br = n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br), final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function occurrences(file: string[], old: string[], strict: boolean, start = 0, eof = false): { at: number; tier: number }[] {
  const norm = (s: string, t: number) => t === 0 ? s : t === 1 ? trail(s) : s.replace(/^[ \t]+|[ \t]+$/g, '');
  for (let t = 0; t <= (strict ? 0 : 2); t++) {
    const found: number[] = [];
    for (let i = start; i + old.length <= file.length; i++) {
      if (eof && i + old.length !== file.length) continue;
      if (old.every((x, j) => norm(x,t) === norm(file[i+j]!,t))) found.push(i);
    }
    if (found.length) return found.map(at => ({at,tier:t}));
  }
  return [];
}
function outputLines(file: string[], old: string[], fresh: string[], at: number, tier: number, context: number[] = []): string[] {
  let n = fresh.slice();
  for (let j=0;j<n.length;j++) if(context[j] !== undefined && context[j]! >= 0) n[j]=file[at+context[j]!]!;
  if (tier === 2 && old.length) {
    const p=lead(old[0]!), f=lead(file[at]!);
    n=n.map((s,j) => context[j] !== undefined && context[j]! >= 0 ? s : (s !== '' && s.trim() !== '' && s.startsWith(p) ? f+s.slice(p.length) : s));
  }
  return n;
}
type Hunk={a:number; body:string[]};
type Section={old:string|null; ne:string|null; create:boolean; del:boolean; hunks:Hunk[]; hdr:boolean};
function pathHeader(s:string):string|null { let p=s.slice(4).split('\t',1)[0]!.trim(); if(p==='/dev/null')return null; return p.replace(/^(a|b)\//,''); }
function unifiedEdits(lines:string[], strict:boolean):Edit[] {
  const sections:Section[]=[]; let cur:Section|null=null, i=0;
  const diff=/^diff --git a\/(\S+) b\/(\S+)$/;
  while(i<lines.length){ const l=lines[i]!; let m=diff.exec(l);
    if(m){cur={old:m[1]!,ne:m[2]!,create:false,del:false,hunks:[],hdr:false};sections.push(cur);i++;continue;}
    if(l.startsWith('--- ') && (lines[i+1]??'').startsWith('+++ ')) {if(cur&&cur.hunks.length===0&&!cur.hdr){cur.old=pathHeader(l);cur.ne=pathHeader(lines[i+1]!);cur.hdr=true;}else{cur={old:pathHeader(l),ne:pathHeader(lines[i+1]!),create:false,del:false,hunks:[],hdr:true};sections.push(cur);}i+=2;continue;}
    if(l.startsWith('@@')) { if(!cur) throw new Exit2(`error: parse ${i+1}`); const hm=/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l); if(!hm)throw new Exit2(`error: parse ${i+1}`); const h:Hunk={a:Number(hm[1]),body:[]};cur.hunks.push(h);i++;
      while(i<lines.length){const b=lines[i]!; if(b.startsWith('diff --git ')||(b.startsWith('--- ')&&(lines[i+1]??'').startsWith('+++ ')))break; if(b===''||/^[ +\\-]/.test(b)){h.body.push(b);i++;}else break;}
      while(h.body.length && (h.body[h.body.length-1]===''||h.body[h.body.length-1]===' '))h.body.pop(); continue;
    }
    if(l.startsWith('diff --git '))throw new Exit2(`error: parse ${i+1}`);
    if(cur&&cur.hunks.length===0){if(l.startsWith('rename from '))cur.old=l.slice(12).trim(); else if(l.startsWith('rename to '))cur.ne=l.slice(10).trim(); else if(l.startsWith('new file mode'))cur.create=true;else if(l.startsWith('deleted file mode'))cur.del=true;
      if(l.startsWith('--- ')) { if(!(lines[i+1]??'').startsWith('+++ '))throw new Exit2(`error: parse ${i+2}`); cur.old=pathHeader(l);cur.ne=pathHeader(lines[i+1]!);cur.hdr=true;i+=2;continue; }}
    i++;
  }
  if(!sections.length)throw new Exit2('error: parse 1');
  return sections.map(s=>tree=>{
    const op=s.old, np=s.ne; const from=op??np, to=np??op; if(!from||!to)throw new Fail('unsafe',from??to??'');
    if(!safe(from)||!safe(to))throw new Fail('unsafe',!safe(from)?from:to);
    const isCreate=s.create||op===null, isDelete=s.del||np===null, move=!isCreate&&!isDelete&&from!==to;
    if(isCreate){if(tree.get(to)!==null)throw new Fail('exists',to);let out:string[]=[];let noBreak=false;for(const h of s.hunks){let lastPlus=-1;for(let bi=0;bi<h.body.length;bi++)if(h.body[bi]!.startsWith('+'))lastPlus=bi;for(const b of h.body)if(b.startsWith('+'))out.push(b.slice(1));if(lastPlus>=0)noBreak=h.body[lastPlus+1]?.startsWith('\\')??false;}tree.now.set(to,out.length?out.join('\n')+(noBreak?'':'\n'):'');return;}
    const txt=tree.get(from);if(txt===null)throw new Fail('missing',from);if(isDelete){tree.now.set(from,null);return;}if(move&&tree.get(to)!==null)throw new Fail('exists',to);
    const f=fileLines(txt);let ls=f.lines,d=0,final=f.final;
    for(const h of s.hunks){const old:string[]=[], fresh:string[]=[], context:number[]=[];let lastCP=-1;for(let bi=0;bi<h.body.length;bi++){const bb=h.body[bi]!;if(bb===''||bb[0]===' '||bb[0]==='+')lastCP=bi;}const mark=lastCP>=0&&(h.body[lastCP+1]?.startsWith('\\')??false);for(const b of h.body){if(b.startsWith('\\'))continue;if(b===''||b[0]===' '){old.push(b===''?'':b.slice(1));fresh.push(b===''?'':b.slice(1));context.push(old.length-1);}else if(b[0]==='-')old.push(b.slice(1));else if(b[0]==='+'){fresh.push(b.slice(1));context.push(-1);}}
      let at:number,tier=0;if(old.length){const found=occurrences(ls,old,strict);if(!found.length)throw new Fail('no-match',from);const target=h.a-1+d;found.sort((x,y)=>Math.abs(x.at-target)-Math.abs(y.at-target)||x.at-y.at);at=found[0]!.at;tier=found[0]!.tier;const repl=outputLines(ls,old,fresh,at,tier,context);const reaches=at+old.length===ls.length;ls.splice(at,old.length,...repl); if(reaches)final=!mark;}
      else {at=Math.min(ls.length,Math.max(0,h.a+d));ls.splice(at,0,...fresh);if(at===ls.length-fresh.length)final=!mark;}
      d+=fresh.length-old.length;
    }
    const out=ls.length?ls.join(f.br)+(final?f.br:''):'';if(move){tree.now.set(from,null);tree.now.set(to,out);tree.moves.push([from,to]);}else tree.now.set(from,out);
  });
}
function searchEdits(lines:string[], strict:boolean):Edit[] {
 const out:Edit[]=[];let i=0, prev='', floor=0;
 while(i<lines.length){if(trail(lines[i]!)!=='<<<<<<< SEARCH'){i++;continue;}const start=i;let p='';for(let k=i-1;k>=floor;k--){const x=lines[k]!.trim();if(x && !x.startsWith('```')){p=x;break;}}if(!p)p=prev;if(!p)throw new Exit2(`error: parse ${i+1}`);
 let sep=-1,end=-1;for(let k=i+1;k<lines.length;k++){const t=trail(lines[k]!);if(t==='>>>>>>> REPLACE')break;if(t==='======='){sep=k;break;}}if(sep>=0)for(let k=sep+1;k<lines.length;k++)if(trail(lines[k]!)==='>>>>>>> REPLACE'){end=k;break;}if(sep<0||end<0)throw new Exit2(`error: parse ${start+1}`);
 const path=p, old=lines.slice(i+1,sep), fresh=lines.slice(sep+1,end);out.push(tree=>{if(!safe(path))throw new Fail('unsafe',path);if(!old.length){if(tree.get(path)!==null)throw new Fail('exists',path);tree.now.set(path,fresh.length?fresh.join('\n')+'\n':'');return;}const txt=tree.get(path);if(txt===null)throw new Fail('missing',path);const f=fileLines(txt), found=occurrences(f.lines,old,strict);if(!found.length)throw new Fail('no-match',path);if(found.length>1)throw new Fail('ambiguous',path);const z=found[0]!, repl=outputLines(f.lines,old,fresh,z.at,z.tier);f.lines.splice(z.at,old.length,...repl);tree.now.set(path,f.lines.length?f.lines.join(f.br)+(f.final?f.br:''):'');});
 prev=p;floor=end+1;i=end+1;
 }
 if(!out.length)throw new Exit2('error: parse 1');return out;
}
type VChunk={anchor:string|null;eof:boolean;body:string[]};
function v4aEdits(lines:string[],strict:boolean):Edit[]{
 const first=lines.findIndex(x=>!blank(x));if(first<0)throw new Exit2('error: parse 1');if(lines[first]!.trim()!=='*** Begin Patch')throw new Exit2(`error: parse ${first+1}`);
 let last=lines.length-1;while(last>=0&&blank(lines[last]!))last--;if(last<0||lines[last]!.trim()!=='*** End Patch')throw new Exit2(`error: parse ${lines.length+1}`);
 const out:Edit[]=[];let i=first+1;
 while(i<last){if(blank(lines[i]!)){i++;continue;}const hdr=lines[i]!,kind=hdr.startsWith('*** Add File: ')?'add':hdr.startsWith('*** Delete File: ')?'del':hdr.startsWith('*** Update File: ')?'upd':'';if(!kind)throw new Exit2(`error: parse ${i+1}`);const path=hdr.slice(kind==='add'?13:kind==='del'?16:17).trim(), ln=i+1;i++;let move:string|null=null,add:string[]=[],chunks:VChunk[]=[];
  if(kind==='add'){const s0=i;while(i<last&&!lines[i]!.startsWith('*** ')){const b=lines[i++]!;if(b!==''&&!b.startsWith('+'))throw new Exit2(`error: parse ${i}`);add.push(b===''?'':b.slice(1));}let k=add.length;while(k>0&&lines[s0+k-1]==='')k--;add.length=k;}
  else if(kind==='upd'){
   if(i<last&&lines[i]!.startsWith('*** Move to: ')){move=lines[i]!.slice(13).trim();i++;}
   let c:VChunk|null=null;
   while(i<last&&(!lines[i]!.startsWith('*** ')||lines[i]==='*** End of File')) {const b=lines[i]!;
    if(b.startsWith('@@')){if(c)chunks.push(c);c={anchor:b.slice(2).trim()||null,eof:false,body:[]};i++;continue;}
    if(b==='*** End of File'){if(!c)c={anchor:null,eof:true,body:[]};else c.eof=true;chunks.push(c);c=null;i++;continue;}
    if(b===''&&!c&&chunks.length){i++;continue;}
    if(!c)c={anchor:null,eof:false,body:[]};if(b!==''&&!/^[ +\-]/.test(b))throw new Exit2(`error: parse ${i+1}`);c.body.push(b);i++;
   }if(c){while(c.body.length&&blank(c.body[c.body.length-1]!))c.body.pop();chunks.push(c);}if(!chunks.length&&!move)throw new Exit2(`error: parse ${ln}`);
  }else {}
  const dest=move;out.push(tree=>{if(!safe(path))throw new Fail('unsafe',path);if(dest!==null&&!safe(dest))throw new Fail('unsafe',dest);
   if(kind==='add'){if(tree.get(path)!==null)throw new Fail('exists',path);tree.now.set(path,add.length?add.join('\n')+'\n':'');return;}
   const txt=tree.get(path);if(txt===null)throw new Fail('missing',path);if(kind==='del'){tree.now.set(path,null);return;}if(dest!==null&&tree.get(dest)!==null)throw new Fail('exists',dest);
   const f=fileLines(txt);let ls=f.lines,cursor=0;
   for(const ch of chunks){if(ch.anchor!==null){const z=occurrences(ls,[ch.anchor],strict,cursor);if(!z.length)throw new Fail('no-match',path);cursor=z[0]!.at+1;}
    const old:string[]=[],fresh:string[]=[],ctx:number[]=[];for(const b of ch.body){if(b===''||b[0]===' '){old.push(b===''?'':b.slice(1));fresh.push(b===''?'':b.slice(1));ctx.push(old.length-1);}else if(b[0]==='-')old.push(b.slice(1));else if(b[0]==='+'){fresh.push(b.slice(1));ctx.push(-1);}}
    if(old.length){const z=occurrences(ls,old,strict,cursor,ch.eof);if(!z.length)throw new Fail('no-match',path);const at=z[0]!, repl=outputLines(ls,old,fresh,at.at,at.tier,ctx);ls.splice(at.at,old.length,...repl);cursor=at.at+repl.length;}
    else {const at=ch.eof?ls.length:Math.min(cursor,ls.length);ls.splice(at,0,...fresh);cursor=at+fresh.length;}
   }
   const result=ls.length?ls.join(f.br)+(f.final?f.br:''):'';if(dest!==null){tree.now.set(path,null);tree.now.set(dest,result);tree.moves.push([path,dest]);}else tree.now.set(path,result);
  });
 }
 if(!out.length)throw new Exit2('error: parse 1');return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const movedOld = new Set<string>(), movedNew = new Set<string>();
  const moveRows: { newPath: string; row: string }[] = [];
  for (const [oldPath, newPath] of tree.moves) {
    if (tree.original(oldPath) !== null && tree.get(oldPath) === null && tree.original(newPath) === null && tree.get(newPath) !== null) {
      movedOld.add(oldPath); movedNew.add(newPath); moveRows.push({newPath,row:`R ${oldPath} -> ${newPath}`});
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  rows.push(...moveRows.sort((a,b)=>Buffer.compare(Buffer.from(a.newPath),Buffer.from(b.newPath))).map(x=>x.row));
  rows.sort((a,b)=>Buffer.compare(Buffer.from(a.slice(a.indexOf(' ')+1).split(' -> ').at(-1)!),Buffer.from(b.slice(b.indexOf(' ')+1).split(' -> ').at(-1)!)));
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
