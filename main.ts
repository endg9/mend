// mend: one patch tool for every AI edit format (unified diff, SEARCH/REPLACE,
// V4A, JSON tool calls). Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// See SPEC.md for the full contract. This file implements it end to end.

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

/** Patch text split into lines: split at \n, one trailing \r removed per line. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it; paths in `now` override what is on disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

/** A file's own line break, its lines, and whether it ends with a break. */
function splitFile(text: string): { br: string; lines: string[]; fin: boolean } {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (fin ? br : '');
}

/** One line normalised for a matching tier: 0 exact, 1 trailing ws, 2 both ends. */
function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Positions where old lines occur in the file at one tier (from `from` on). */
function occurrences(fileLines: string[], oldLines: string[], tier: number, from: number, endAtLast: boolean): number[] {
  const out: number[] = [];
  const last = fileLines.length - oldLines.length;
  for (let i = from; i <= last; i += 1) {
    if (endAtLast && i + oldLines.length !== fileLines.length) continue;
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (norm(fileLines[i + j]!, tier) !== norm(oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which the old lines occur at least once, with the spots. */
function findFirstTier(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  from = 0,
  endAtLast = false,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, oldLines, t, from, endAtLast);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Re-indent one replacement line at tier 2: the patch's indent P becomes the file's F. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** A replacement list: context entries come from the file's own matched lines. */
function renderN(
  fileLines: string[],
  at: number,
  oldLines: string[],
  entries: Array<{ text: string; ctx: number | null }>,
  tier: number,
): string[] {
  const f = oldLines.length > 0 ? leading(fileLines[at] ?? '') : '';
  const p = oldLines.length > 0 ? leading(oldLines[0]!) : '';
  return entries.map((e) => {
    if (e.ctx !== null) return fileLines[at + e.ctx]!;
    return tier === 2 ? reindent(e.text, f, p) : e.text;
  });
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

/** One JSON edit object (SPEC section 9), or null when it is not one. */
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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface BodyEntry {
  kind: ' ' | '-' | '+' | '\\' | '';
  text: string;
  noNL: boolean;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface UniSection {
  oldH?: string | null;
  newH?: string | null;
  oldR?: string | null;
  newR?: string | null;
  oldD?: string;
  newD?: string;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/;
const DIFF_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** Path after `--- `/`+++ `: up to the first tab, spaces trimmed, a/ or b/ off. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply a section's hunks to a file's text; the section's path on failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  let { br, lines, fin } = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const oldLines: string[] = [];
    const newEntries: Array<{ text: string; ctx: number | null }> = [];
    let lastCP: BodyEntry | null = null;
    for (const e of h.body) {
      if (e.kind === '\\') continue;
      if (e.kind === ' ') {
        oldLines.push(e.text);
        newEntries.push({ text: e.text, ctx: oldLines.length - 1 });
        lastCP = e;
      } else if (e.kind === '-') {
        oldLines.push(e.text);
      } else if (e.kind === '+') {
        newEntries.push({ text: e.text, ctx: null });
        lastCP = e;
      } else {
        oldLines.push('');
        newEntries.push({ text: '', ctx: oldLines.length - 1 });
        lastCP = e;
      }
    }
    const noNL = lastCP !== null && lastCP.noNL;
    const oldLen = lines.length;
    if (oldLines.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), oldLen);
      const ins = newEntries.map((e) => e.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (at === oldLen) fin = !noNL;
      d += newEntries.length;
    } else {
      const found = findFirstTier(lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let at = found.occ[0]!;
      let best = Math.abs(at - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < best) {
          best = dist;
          at = pos;
        }
      }
      const rep = renderN(lines, at, oldLines, newEntries, found.tier);
      const toEnd = at + oldLines.length === oldLen;
      lines = [...lines.slice(0, at), ...rep, ...lines.slice(at + oldLines.length)];
      if (toEnd) fin = !noNL;
      d += newEntries.length - oldLines.length;
    }
  }
  return joinFile(lines, br, fin);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hunk: Hunk | null = null;

  const closeBody = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw.trim() === '') hunk.body.pop();
    hunk = null;
  };
  const openSection = (): UniSection => {
    const s: UniSection = { isNew: false, isDel: false, hunks: [] };
    sections.push(s);
    return s;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        closeBody();
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeBody();
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        if (line.startsWith('\\')) {
          for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
            if (hunk.body[k]!.kind !== '\\') {
              hunk.body[k]!.noNL = true;
              break;
            }
          }
          hunk.body.push({ kind: '\\', text: line, noNL: false, raw: line });
        } else {
          const kind = line === '' ? '' : (line[0] as ' ' | '-' | '+');
          hunk.body.push({ kind, text: line === '' ? '' : line.slice(1), noNL: false, raw: line });
        }
        continue;
      } else {
        closeBody();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      sec = openSection();
      sec.oldD = m[1];
      sec.newD = m[2];
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && sec.hunks.length === 0 && sec.oldH === undefined && sec.newH === undefined) {
        sec.oldH = headerPath(line);
        sec.newH = headerPath(lines[i + 1]!);
      } else {
        sec = openSection();
        sec.oldH = headerPath(line);
        sec.newH = headerPath(lines[i + 1]!);
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${lineNo}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      hunk = { a: Number(m[1]), body: [] };
      sec.hunks.push(hunk);
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${lineNo + 1}`);
      if (line.startsWith('+++ ')) {
        sec.newH = headerPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.oldR = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.newR = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isNew = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDel = true;
        continue;
      }
    }
    // Anything else outside a hunk body is ignored prose.
  }
  closeBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => {
    const oldP = s.oldH !== undefined ? s.oldH : s.oldR !== undefined ? s.oldR : s.oldD;
    const newP = s.newH !== undefined ? s.newH : s.newR !== undefined ? s.newR : s.newD;
    return (tree: Tree) => {
      const isCreate = s.isNew || oldP === null;
      if (isCreate && typeof newP === 'string') {
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let lastPlusNoNL = false;
        for (const h of s.hunks) {
          for (const e of h.body) {
            if (e.kind === '+') {
              plus.push(e.text);
              lastPlusNoNL = e.noNL;
            }
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNL ? '' : '\n'));
        return;
      }
      const isDelete = s.isDel || newP === null;
      if (isDelete && typeof oldP === 'string') {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (typeof oldP === 'string' && typeof newP === 'string' && oldP !== newP) {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const result = applyHunks(before, s.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, result);
        tree.moves.push([oldP, newP]);
        return;
      }
      const p = typeof oldP === 'string' ? oldP : newP;
      if (typeof p !== 'string') return;
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, s.hunks, strict, p));
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const sIdx = i;
      let j = i + 1;
      let sep = -1;
      while (j < lines.length) {
        const t = lines[j]!.trimEnd();
        if (t === '<<<<<<< SEARCH') break;
        if (t === '=======') {
          sep = j;
          break;
        }
        j += 1;
      }
      if (sep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      let k = sep + 1;
      let end = -1;
      while (k < lines.length) {
        const t = lines[k]!.trimEnd();
        if (t === '<<<<<<< SEARCH') break;
        if (t === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
        k += 1;
      }
      if (end < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      let path: string | null = null;
      for (let p = sIdx - 1; p > prevEnd; p -= 1) {
        const l = lines[p]!;
        if (!blank(l) && !l.trim().startsWith('```')) {
          path = l.trim();
          break;
        }
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new Exit2(`error: parse ${sIdx + 1}`);
      }
      blocks.push({ path, oldLines: lines.slice(sIdx + 1, sep), newLines: lines.slice(sep + 1, end) });
      prevEnd = end;
      i = end + 1;
    } else {
      i += 1;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const { br, lines: fl, fin } = splitFile(before);
    const found = findFirstTier(fl, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const rep = renderN(fl, at, b.oldLines, b.newLines.map((t) => ({ text: t, ctx: null })), found.tier);
    tree.now.set(b.path, joinFile([...fl.slice(0, at), ...rep, ...fl.slice(at + b.oldLines.length)], br, fin));
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string;
  body: BodyEntry[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  addLines: Array<{ text: string; plus: boolean }>;
  moveTo?: string;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;

  const finishSection = (s: VSection): void => {
    if (s.kind === 'add') {
      while (s.addLines.length > 0 && !s.addLines[s.addLines.length - 1]!.plus) s.addLines.pop();
    }
    if (s.kind === 'upd') {
      if (chunk !== null) {
        while (chunk.body.length > 0 && chunk.body[chunk.body.length - 1]!.raw.trim() === '') chunk.body.pop();
        chunk = null;
      }
      if (s.chunks.length === 0 && s.moveTo === undefined) throw new Exit2(`error: parse ${s.lineNo}`);
    }
  };

  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      if (cur !== null) finishSection(cur);
      const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'del' : 'upd';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: line.slice(prefix.length).trim(), lineNo, addLines: [], chunks: [] };
      sections.push(cur);
      chunk = null;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) {
        cur.addLines.push({ text: line.slice(1), plus: true });
        continue;
      }
      if (line === '') {
        cur.addLines.push({ text: '', plus: false });
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (line.startsWith('*** Move to: ')) {
      if (cur.moveTo !== undefined || cur.chunks.length > 0 || chunk !== null) throw new Exit2(`error: parse ${lineNo}`);
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.trimEnd() === '*** End of File' && line === line.trimStart()) {
      if (chunk === null) throw new Exit2(`error: parse ${lineNo}`);
      chunk.eof = true;
      chunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      chunk = { anchor: line.slice(2).trim(), body: [], eof: false };
      cur.chunks.push(chunk);
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (chunk === null) {
        if (line === '' && cur.chunks.length > 0) continue;
        if (cur.chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        chunk = { anchor: '', body: [], eof: false };
        cur.chunks.push(chunk);
      }
      const kind = line === '' ? '' : (line[0] as ' ' | '-' | '+');
      chunk.body.push({ kind, text: line === '' ? '' : line.slice(1), noNL: false, raw: line });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (cur !== null) finishSection(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => (tree: Tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : `${s.addLines.map((a) => a.text).join('\n')}\n`);
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let { br, lines: fl, fin } = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== '') {
        const af = findFirstTier(fl, [ch.anchor], strict, cursor, false);
        if (af === null) throw new Fail('no-match', s.path);
        cursor = af.occ[0]! + 1;
      }
      const oldLines: string[] = [];
      const newEntries: Array<{ text: string; ctx: number | null }> = [];
      for (const e of ch.body) {
        if (e.kind === ' ') {
          oldLines.push(e.text);
          newEntries.push({ text: e.text, ctx: oldLines.length - 1 });
        } else if (e.kind === '-') {
          oldLines.push(e.text);
        } else if (e.kind === '+') {
          newEntries.push({ text: e.text, ctx: null });
        } else if (e.kind === '') {
          oldLines.push('');
          newEntries.push({ text: '', ctx: oldLines.length - 1 });
        }
      }
      if (oldLines.length === 0) {
        const at = ch.eof ? fl.length : cursor;
        fl = [...fl.slice(0, at), ...newEntries.map((e) => e.text), ...fl.slice(at)];
        cursor = at + newEntries.length;
      } else {
        const found = findFirstTier(fl, oldLines, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', s.path);
        const at = found.occ[0]!;
        const rep = renderN(fl, at, oldLines, newEntries, found.tier);
        fl = [...fl.slice(0, at), ...rep, ...fl.slice(at + oldLines.length)];
        cursor = at + newEntries.length;
      }
    }
    const result = joinFile(fl, br, fin);
    if (s.moveTo !== undefined) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, result);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, result);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Command line, exit codes, atomicity (SPEC sections 1, 2 and 10)     */
/* ------------------------------------------------------------------ */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      pairedOld.add(oldP);
      pairedNew.add(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (pairedOld.has(p) || pairedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
