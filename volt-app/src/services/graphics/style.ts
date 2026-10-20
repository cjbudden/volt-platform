// ============================================================================
//  TEMPLATE STYLE: find a template's colours and fonts, and change them.
//
//  The "customise the look" editor (REQ section 15). It is not a designer: it
//  changes what a template already has, in any package, whoever wrote it:
//
//    theme variables   --brand: #0a2350 in CSS. Edited at the declaration,
//                      so everything that uses the variable follows.
//    colour literals   #0a2350, rgb(10 35 80) written straight into CSS, HTML
//                      or the template's own script. Grouped by colour (#fff
//                      and #ffffff are one), every occurrence replaced.
//    font families     the first family of each font-family (CSS or a script's
//                      fontFamily = "...") is a font token. Changing it swaps
//                      that name and keeps the fallbacks. @font-face rules are
//                      never rewritten, so the old face stays available.
//    added fonts       uploaded .woff2/.woff/.ttf/.otf go in fonts/ with an
//                      @font-face in volt-fonts.css, linked from index.html
//                      (OGraf: from the generated host page).
//
//  Vendor and minified scripts (lib/, vendor/, *.min.js, anything over 200 KB)
//  are not scanned: their colours are not the template's design.
//  PURE: no database, no network. Tested by test/graphics-pure.check.ts.
// ============================================================================
import { posix } from 'node:path';

export interface StyleToken {
  id: string;
  kind: 'color' | 'font';
  via: 'var' | 'literal';
  label: string;
  value: string;
  uses: number;
  files: string[];
}
export interface StyleFont { family: string; bundled: boolean; file?: string }
export interface StyleReport { tokens: StyleToken[]; fonts: StyleFont[] }
export interface NewFont { family: string; filename: string; data: Buffer }
type F = { path: string; data: Buffer };

export class StyleError extends Error {}

const SCAN_MAX = 200 * 1024;
const isMarkup = (p: string) => /\.(html?|css|svg)$/i.test(p);
const isScript = (p: string) => /\.m?js$/i.test(p);
const vendor = (p: string) => /(^|\/)(lib|libs|vendor|node_modules|dist)\//i.test(p) || /\.min\.m?js$/i.test(p);
export const scannable = (f: F) => (isMarkup(f.path) || isScript(f.path)) && f.data.length <= SCAN_MAX && !vendor(f.path);

export const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace', 'system-ui'];
export const FONT_EXT = /\.(woff2|woff|ttf|otf)$/i;
const FONT_FORMAT: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;
const FUNC = /\b(?:rgba?|hsla?)\(\s*[0-9.%+-]+(?:\s*[,\s]\s*[0-9.%+-]+){2}(?:\s*[,/]\s*[0-9.%+-]+)?\s*\)/gi;
export const COLOR = /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgba?|hsla?)\([^()]{3,60}\)|transparent)$/i;

/** One key for one colour: #FFF, #ffffff and #ffffffff are the same token. */
export function normColor(c: string): string {
  const s = c.trim().toLowerCase();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    if (h.length === 8 && h.endsWith('ff')) h = h.slice(0, 6);
    return '#' + h;
  }
  return s.replace(/\s+/g, ' ').replace(/\(\s*/, '(').replace(/\s*\)/, ')').replace(/\s*,\s*/g, ', ');
}

/** Characters before a match that mean it is not a colour: href="#top", url(#clip), &#123;, an id selector. */
function looksLikeColour(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 8), at);
  if (/(?:href\s*=\s*["']|url\(\s*["']?|&|xlink:href\s*=\s*["'])$/i.test(before)) return false;
  const prev = text[at - 1] ?? '';
  // In CSS a #abc at the start of a selector is an id: preceded by a newline, }, ; or , and followed by {.
  const after = text.slice(at, at + 40);
  if (/^#[0-9a-fA-F]{3,8}\s*[{,]/.test(after) && /[\s}{;,>]/.test(prev || '\n')) return false;
  return true;
}

/** Ranges of custom-property declarations (--x: value), so their values are not also counted as literals. */
function varRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)/g)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}
const inside = (r: [number, number][], i: number) => r.some(([a, b]) => i >= a && i < b);

/** The font-family declarations a file uses: [start, end] of the value and the value. */
function familyUses(text: string, script: boolean): { start: number; end: number; value: string }[] {
  const out: { start: number; end: number; value: string }[] = [];
  const faces: [number, number][] = [];
  for (const m of text.matchAll(/@font-face\s*\{[^}]*\}/gi)) faces.push([m.index!, m.index! + m[0].length]);
  const css = /font-family\s*:\s*([^;}{"'`\n]*(?:(?:"[^"]*"|'[^']*')[^;}{"'`\n]*)*)/gi;
  for (const m of text.matchAll(css)) {
    const start = m.index! + m[0].length - m[1].length;
    if (inside(faces, m.index!) || !m[1].trim()) continue;
    out.push({ start, end: start + m[1].length, value: m[1] });
  }
  // The shorthand: font: 600 52px/1 "Volt Serif", serif. The family list follows the size.
  for (const m of text.matchAll(/(^|[^\w-])font\s*:\s*([^;}{\n"'`]*(?:(?:"[^"]*"|'[^']*')[^;}{\n"'`]*)*)/g)) {
    const v = m[2]; const vs = m.index! + m[0].length - v.length;
    const sz = /(?:^|\s)\d[\d.]*(?:px|pt|em|rem|%|vh|vw|vmin|vmax)(?:\s*\/\s*[\d.]+[a-z%]*)?\s+/i.exec(v);
    if (!sz || inside(faces, m.index!)) continue;
    const at = sz.index + sz[0].length;
    const fam = v.slice(at).replace(/\s*!important\s*$/i, '');
    if (fam.trim()) out.push({ start: vs + at, end: vs + at + fam.length, value: fam });
  }
  if (script) {
    for (const m of text.matchAll(/\bfontFamily\s*[=:]\s*(["'`])([^"'`\n]{1,200})\1/g)) {
      const start = m.index! + m[0].length - 1 - m[2].length;
      out.push({ start, end: start + m[2].length, value: m[2] });
    }
  }
  return out;
}
const firstFamily = (v: string) => (v.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').trim();
const isVarRef = (v: string) => /^var\(/i.test(v.trim());

function prettyVar(name: string): string {
  const s = name.replace(/^--/, '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}

/** Every colour and font a template's own files use, most used first. */
export function readStyle(files: F[]): StyleReport {
  const vars = new Map<string, StyleToken>();
  const lits = new Map<string, StyleToken>();
  const fams = new Map<string, StyleToken>();
  const faces = new Map<string, StyleFont>();
  for (const f of files) {
    if (!scannable(f) && !/\.css$/i.test(f.path)) continue;
    if (f.data.length > SCAN_MAX) continue;
    const text = f.data.toString('utf8');
    const script = isScript(f.path);
    for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      const fam = /font-family\s*:\s*([^;]+)/i.exec(m[1]);
      const src = /url\(\s*["']?([^)"']+)/i.exec(m[1]);
      if (fam) { const name = firstFamily(fam[1]); if (name && !faces.has(name.toLowerCase())) faces.set(name.toLowerCase(), { family: name, bundled: true, ...(src ? { file: posix.normalize(posix.join(posix.dirname(f.path), src[1])) } : {}) }); }
    }
    for (const m of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)/g)) {
      const name = m[1]; const value = m[2].trim();
      const isFont = /font|family|face|typeface/i.test(name) && !COLOR.test(value);
      if (!COLOR.test(value) && !isFont) continue;
      const id = `var:${name}`;
      const t = vars.get(id) ?? { id, kind: isFont ? 'font' : 'color', via: 'var', label: prettyVar(name), value: isFont ? firstFamily(value) : value, uses: 0, files: [] } as StyleToken;
      t.uses++; if (!t.files.includes(f.path)) t.files.push(f.path);
      vars.set(id, t);
    }
    if (!scannable(f)) continue;
    const ranges = varRanges(text);
    for (const re of [HEX, FUNC]) {
      for (const m of text.matchAll(re)) {
        if (inside(ranges, m.index!) || (re === HEX && !looksLikeColour(text, m.index!))) continue;
        const key = normColor(m[0]);
        const id = `color:${key}`;
        const t = lits.get(id) ?? { id, kind: 'color', via: 'literal', label: '', value: key, uses: 0, files: [] } as StyleToken;
        t.uses++; if (!t.files.includes(f.path)) t.files.push(f.path);
        lits.set(id, t);
      }
    }
    for (const u of familyUses(text, script)) {
      if (isVarRef(u.value)) continue;
      const fam = firstFamily(u.value);
      if (!fam || GENERIC_FAMILIES.includes(fam.toLowerCase()) || /^(inherit|initial|unset)$/i.test(fam)) continue;
      const id = `font:${fam}`;
      const t = fams.get(id) ?? { id, kind: 'font', via: 'literal', label: fam, value: fam, uses: 0, files: [] } as StyleToken;
      t.uses++; if (!t.files.includes(f.path)) t.files.push(f.path);
      fams.set(id, t);
    }
  }
  const colours = [...lits.values()].sort((a, b) => b.uses - a.uses).slice(0, 24)
    .map((t, i) => ({ ...t, label: `Colour ${i + 1}` }));
  const tokens = [...vars.values(), ...[...fams.values()].sort((a, b) => b.uses - a.uses), ...colours];
  for (const t of fams.values()) if (!faces.has(t.value.toLowerCase())) faces.set(t.value.toLowerCase(), { family: t.value, bundled: false });
  return { tokens, fonts: [...faces.values()].sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.family.localeCompare(b.family)) };
}

const fontSlug = (family: string) => family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font';
export const FAMILY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
/** Write `to` where `was` stood, in the same quoting, so an HTML attribute or a script string stays valid. */
function swapFirst(value: string, to: string): string {
  const parts = value.split(',');
  const lead = /^\s*/.exec(parts[0])![0]; const trail = /\s*$/.exec(parts[0])![0];
  const core = parts[0].trim();
  const qc = core[0] === '"' || core[0] === "'" ? core[0] : '';
  const name = GENERIC_FAMILIES.includes(to.toLowerCase()) ? to : qc ? qc + to + qc : /^[A-Za-z][A-Za-z -]*$/.test(to) ? to : `'${to}'`;
  parts[0] = lead + name + trail;
  return parts.join(',');
}

/**
 * The package with the changes applied. `changes` maps token ids (from
 * readStyle) to new values; ids it does not know are an error, so a stale
 * editor cannot silently do nothing.
 */
export function applyStyle(files: F[], changes: Record<string, string>, addFonts: NewFont[] = []): F[] {
  const report = readStyle(files);
  const known = new Map(report.tokens.map((t) => [t.id, t]));
  const added = new Set<string>();
  for (const nf of addFonts) {
    if (!FAMILY_NAME.test(nf.family)) throw new StyleError(`"${nf.family}" is not a usable font name: letters, digits, spaces, dots, dashes.`);
    if (!FONT_EXT.test(nf.filename)) throw new StyleError(`${nf.filename}: fonts must be .woff2, .woff, .ttf or .otf.`);
    if (nf.data.length > 4 * 1024 * 1024) throw new StyleError(`${nf.filename} is larger than 4 MB.`);
    added.add(nf.family.toLowerCase());
  }
  const families = new Set([...report.fonts.map((f) => f.family.toLowerCase()), ...added, ...GENERIC_FAMILIES]);
  const plan: { t: StyleToken; to: string }[] = [];
  for (const [id, raw] of Object.entries(changes)) {
    const t = known.get(id);
    if (!t) throw new StyleError(`Nothing called ${id} in this template. Reload and try again.`);
    const to = String(raw ?? '').trim();
    if (t.kind === 'color' && !COLOR.test(to)) throw new StyleError(`${to || '(empty)'} is not a colour. Use #rrggbb, rgb() or hsl().`);
    if (t.kind === 'font' && (!FAMILY_NAME.test(to) || !families.has(to.toLowerCase()))) throw new StyleError(`${to || '(empty)'} is not a font in this template. Add the font file first.`);
    if (t.kind === 'color' ? normColor(to) === normColor(t.value) : to === t.value) continue;
    plan.push({ t, to });
  }

  let out = files.map((f) => ({ path: f.path, data: f.data }));
  const edit = (path: string, fn: (s: string) => string) => {
    out = out.map((f) => (f.path === path ? { path, data: Buffer.from(fn(f.data.toString('utf8')), 'utf8') } : f));
  };
  for (const { t, to } of plan) {
    for (const path of t.files) {
      if (t.via === 'var') {
        const name = t.id.slice(4).replace(/[-]/g, '\\-');
        edit(path, (s) => s.replace(new RegExp(`(${name}\\s*:\\s*)([^;{}]+)`, 'g'), (_m, a: string, v: string) => {
          if (t.kind === 'font') return a + swapFirst(v, to);
          return a + to + (/\s$/.test(v) ? ' ' : '');
        }));
      } else if (t.kind === 'color') {
        const target = t.value;
        edit(path, (s) => {
          const ranges = varRanges(s);
          let res = ''; let last = 0;
          const hits: [number, number][] = [];
          for (const re of [HEX, FUNC]) for (const m of s.matchAll(re)) {
            if (inside(ranges, m.index!) || (re === HEX && !looksLikeColour(s, m.index!))) continue;
            if (normColor(m[0]) === target) hits.push([m.index!, m.index! + m[0].length]);
          }
          hits.sort((a, b) => a[0] - b[0]);
          for (const [a, b] of hits) { res += s.slice(last, a) + to; last = b; }
          return res + s.slice(last);
        });
      } else {
        const from = t.value;
        edit(path, (s) => {
          const uses = familyUses(s, isScript(path)).filter((u) => firstFamily(u.value) === from).sort((a, b) => b.start - a.start);
          for (const u of uses) s = s.slice(0, u.start) + swapFirst(u.value, to) + s.slice(u.end);
          return s;
        });
      }
    }
  }

  if (addFonts.length) {
    const have = new Set(out.map((f) => f.path.toLowerCase()));
    const rules: string[] = [];
    for (const nf of addFonts) {
      const ext = FONT_EXT.exec(nf.filename)![1].toLowerCase();
      let path = `fonts/${fontSlug(nf.family)}.${ext}`;
      for (let i = 2; have.has(path.toLowerCase()); i++) path = `fonts/${fontSlug(nf.family)}-${i}.${ext}`;
      have.add(path.toLowerCase());
      out.push({ path, data: nf.data });
      rules.push(`@font-face{font-family:"${nf.family}";src:url("${path}") format("${FONT_FORMAT[ext]}");font-display:block}`);
    }
    const prev = out.find((f) => f.path === 'volt-fonts.css');
    const css = (prev ? prev.data.toString('utf8').trimEnd() + '\n' : '/* Fonts added in Volt\'s style editor. */\n') + rules.join('\n') + '\n';
    out = out.filter((f) => f.path !== 'volt-fonts.css').concat({ path: 'volt-fonts.css', data: Buffer.from(css, 'utf8') });
    const index = out.find((f) => f.path === 'index.html');
    if (index && !/href=["']volt-fonts\.css["']/.test(index.data.toString('utf8'))) {
      edit('index.html', (s) => {
        const link = '<link rel="stylesheet" href="volt-fonts.css">';
        const m = /<\/head>/i.exec(s) ?? /<body\b/i.exec(s);
        return m ? s.slice(0, m.index) + link + s.slice(m.index) : link + s;
      });
    }
  }
  return out;
}
