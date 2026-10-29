// ============================================================================
//  GRAPHICS TEMPLATE PACKAGES: unpack, read the manifest, run the checks.
//
//  A template arrives three ways (docs/REQ_graphics_overlays.md, W1):
//    upload   a .zip (index.html + fonts, images, scripts) or a single .html
//    paste    HTML typed or pasted into the console, optionally with extra files
//    copy     a duplicate of another template's latest version
//  All three end here as a list of files, and all three get the same checks.
//
//  THE MANIFEST is what makes a page a template: canvas size, the fields an
//  operator or a feed fills, and sample data for the preview. It is read from,
//  in order: a volt.json file, a <script type="application/json"
//  id="volt-manifest"> block (the spike's templates), an SPX
//  SPXGCTemplateDefinition, and finally data-field="..." attributes. A
//  template with none of these is still accepted: it is a fixed graphic.
//  A package with a *.ograf.json manifest is an EBU OGraf graphic instead
//  (ograf.ts): its schema gives the fields and Volt hosts its component.
//
//  THE CHECKS decide whether a draft may be published. `error` blocks
//  publishing; `warn` is shown and allowed. They are deliberately about what
//  will break on air, not about style:
//    - it must be self-contained. The renderer and the player run templates
//      with no network, so a font from fonts.googleapis.com is not "slower",
//      it is missing, and the graphic renders in a fallback face on air.
//    - fields need an update() to receive them, or the panel and the API move
//      nothing on screen.
//
//  PURE: no database, no network. Tested by test/graphics-pure.check.ts.
// ============================================================================
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isZip, readZip, ZipError } from './zip';
import { isOgrafManifest, ografChecks, readOgraf, stripJsComments, type OgrafInfo } from './ograf';

export const LIMITS = { maxFiles: 200, maxBytes: 25 * 1024 * 1024 };

export type FieldType = 'text' | 'number' | 'image' | 'list' | 'color' | 'boolean';
export interface TemplateField { id: string; type: FieldType; label: string; hidden?: boolean; options?: { value: string | number; label: string }[]
  /** Older field ids this one took over: a setup moving to this version carries their binding across. */
  replaces?: string[] }
export interface Manifest {
  name?: string;
  canvas: [number, number];
  canvasDeclared: boolean;
  fps?: number;
  bbox?: [number, number, number, number];
  /** The setup's anchor PLACES the graphic (its box goes to that spot of the frame, keeping its margin), not only scales about it. Needs a bbox. */
  snap?: boolean;
  fields: TemplateField[];
  sample: Record<string, unknown>;
  contract: string;
  manifestFrom: 'volt.json' | 'volt-manifest' | 'spx' | 'data-field' | 'ograf' | 'none';
  /** Set for an EBU OGraf package: served through a generated host page (ograf.ts). */
  ograf?: OgrafInfo;
}
export interface PackageFile { path: string; data: Buffer; contentType: string; sha256: string }
export type CheckLevel = 'ok' | 'warn' | 'error';
export interface Check { id: string; level: CheckLevel; title: string; detail: string }
export interface Analysed { files: PackageFile[]; manifest: Manifest; checks: Check[]; sizeBytes: number; publishable: boolean }

export class PackageError extends Error {}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
};
export const contentTypeFor = (path: string) => TYPES[(path.split('.').pop() || '').toLowerCase()] ?? 'application/octet-stream';
const isText = (p: string) => /\.(html?|css|m?js|json|svg|txt|xml)$/i.test(p);

/** A safe relative path inside the package, or a PackageError. */
export function safePath(raw: string): string {
  const p = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p)) throw new PackageError(`${raw}: absolute paths are not allowed in a package.`);
  const norm = posix.normalize(p);
  if (norm.startsWith('..') || norm.split('/').includes('..')) throw new PackageError(`${raw}: paths may not leave the package.`);
  if (/[\x00-\x1f]/.test(norm)) throw new PackageError(`${raw}: the path contains control characters.`);
  if (norm.length > 300) throw new PackageError(`${raw.slice(0, 40)}...: the path is too long.`);
  return norm;
}

/** Turn an upload body into package files. A zip is unpacked; anything else is index.html. */
export function filesFromUpload(body: Buffer, filename = ''): { path: string; data: Buffer }[] {
  if (isZip(body)) {
    try {
      return readZip(body, { maxEntries: LIMITS.maxFiles, maxTotalBytes: LIMITS.maxBytes });
    } catch (e) {
      if (e instanceof ZipError) throw new PackageError(e.message);
      throw new PackageError('The .zip file could not be read.');
    }
  }
  if (/\.zip$/i.test(filename)) throw new PackageError('This is not a readable .zip file.');
  const head = body.subarray(0, 512).toString('utf8').toLowerCase();
  if (!head.includes('<')) throw new PackageError('Upload a .zip package or an .html file.');
  return [{ path: 'index.html', data: body }];
}

/**
 * Normalise paths and find the entry. A zip made by "Compress folder" has one
 * top folder (scorebug/index.html); that folder is stripped so every package
 * is served from its own root.
 */
export function normalise(raw: { path: string; data: Buffer }[]): PackageFile[] {
  if (raw.length > LIMITS.maxFiles) throw new PackageError(`The package has ${raw.length} files, more than the ${LIMITS.maxFiles} allowed.`);
  let files = raw.map((f) => ({ path: safePath(f.path), data: f.data }));
  const atRoot = (p: string) => !p.includes('/');
  const isEntry = (p: string) => p.toLowerCase() === 'index.html' || (atRoot(p) && isOgrafManifest(p));
  if (!files.some((f) => isEntry(f.path))) {
    const tops = new Set(files.map((f) => f.path.split('/')[0]));
    if (tops.size === 1) {
      const top = [...tops][0] + '/';
      const inner = (p: string) => p.toLowerCase().startsWith(top.toLowerCase()) ? p.slice(top.length) : '';
      if (files.some((f) => { const i = inner(f.path); return i && isEntry(i); })) {
        files = files.map((f) => ({ ...f, path: f.path.slice(top.length) }));
      }
    }
  }
  // A single .html file of another name is the entry, unless the package is OGraf.
  const htmls = files.filter((f) => /\.html?$/i.test(f.path));
  if (!files.some((f) => f.path.toLowerCase() === 'index.html' || isOgrafManifest(f.path)) && htmls.length === 1) {
    htmls[0].path = 'index.html';
  }
  const seen = new Set<string>();
  const out: PackageFile[] = [];
  for (const f of files) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new PackageError(`${f.path} appears twice in the package.`);
    seen.add(key);
    const path = key === 'index.html' ? 'index.html' : f.path;
    out.push({ path, data: f.data, contentType: contentTypeFor(path), sha256: createHash('sha256').update(f.data).digest('hex') });
  }
  return out;
}

const FIELD_TYPES = new Set<FieldType>(['text', 'number', 'image', 'list', 'color', 'boolean']);
function normField(f: any, i: number): TemplateField | null {
  const id = String(f?.id ?? f?.field ?? '').trim();
  if (!/^[A-Za-z_][\w.-]{0,63}$/.test(id)) return null;
  let type = String(f?.type ?? f?.ftype ?? 'text').toLowerCase();
  if (type === 'textfield' || type === 'string' || type === 'textarea' || type === 'caption') type = 'text';
  if (type === 'filelist' || type === 'image' || type === 'img') type = 'image';
  if (type === 'checkbox' || type === 'bool') type = 'boolean';
  if (type === 'dropdown') type = 'text';
  if (type === 'number' || type === 'int' || type === 'float') type = 'number';
  if (type === 'colour') type = 'color';
  if (!FIELD_TYPES.has(type as FieldType)) type = 'text';
  return { id, type: type as FieldType, label: String(f?.label ?? f?.title ?? id).slice(0, 80) || `Field ${i + 1}`, ...(f?.hidden ? { hidden: true } : {}),
    // A fixed choice list (a dropdown in the setup and live control): [{value,label}] or plain values.
    ...(Array.isArray(f?.options) && f.options.length ? { options: f.options.slice(0, 100).map((o: any) => (o && typeof o === 'object')
      ? { value: typeof o.value === 'number' ? o.value : String(o.value ?? ''), label: String(o.label ?? o.value ?? '').slice(0, 80) }
      : { value: typeof o === 'number' ? o : String(o), label: String(o).slice(0, 80) }) } : {}),
    ...(Array.isArray(f?.replaces) && f.replaces.length ? { replaces: f.replaces.map(String).filter((x: string) => /^[A-Za-z_][\w.-]{0,63}$/.test(x)).slice(0, 8) } : {}) };
}

function between(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? m[1] : null;
}

export function readManifest(files: PackageFile[]): Manifest {
  const og = readOgraf(files);
  if (og) return og;
  const index = files.find((f) => f.path === 'index.html');
  const html = index ? index.data.toString('utf8') : '';
  let src: any = null; let from: Manifest['manifestFrom'] = 'none';

  const vj = files.find((f) => f.path.toLowerCase() === 'volt.json');
  if (vj) { try { src = JSON.parse(vj.data.toString('utf8')); from = 'volt.json'; } catch { /* reported by checks */ } }
  if (!src) {
    const block = between(html, /<script[^>]*id=["']volt-manifest["'][^>]*>([\s\S]*?)<\/script>/i);
    if (block) { try { src = JSON.parse(block); from = 'volt-manifest'; } catch { /* reported */ } }
  }
  if (!src) {
    const spx = between(html, /SPXGCTemplateDefinition\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i);
    if (spx) {
      try {
        const d = JSON.parse(spx);
        src = { name: d.description, fields: (d.DataFields ?? []).filter((x: any) => x.ftype !== 'instruction' && x.ftype !== 'spacer')
          .map((x: any) => ({ id: x.field, type: x.ftype, label: x.title })),
          sample: Object.fromEntries((d.DataFields ?? []).filter((x: any) => x.field && x.value != null).map((x: any) => [x.field, x.value])) };
        from = 'spx';
      } catch { /* not JSON: leave it */ }
    }
  }
  if (!src) {
    const ids = [...html.matchAll(/data-field\s*=\s*["']([A-Za-z_][\w.-]{0,63})["']/g)].map((m) => m[1]);
    if (ids.length) { src = { fields: [...new Set(ids)].map((id) => ({ id, type: 'text', label: id })) }; from = 'data-field'; }
  }
  src = src ?? {};
  const canvasOk = Array.isArray(src.canvas) && src.canvas.length === 2 && src.canvas.every((n: any) => Number.isInteger(n) && n >= 16 && n <= 7680);
  const fields: TemplateField[] = [];
  const ids = new Set<string>();
  for (const [i, f] of (Array.isArray(src.fields) ? src.fields : []).entries()) {
    const nf = normField(f, i);
    if (nf && !ids.has(nf.id)) { ids.add(nf.id); fields.push(nf); }
  }
  const bbox = Array.isArray(src.bbox) && src.bbox.length === 4 && src.bbox.every((n: any) => Number.isFinite(n)) ? src.bbox as [number, number, number, number] : undefined;
  return {
    ...(typeof src.name === 'string' && src.name.trim() ? { name: src.name.trim().slice(0, 120) } : {}),
    canvas: canvasOk ? [src.canvas[0], src.canvas[1]] : [1920, 1080],
    canvasDeclared: canvasOk,
    ...(Number.isFinite(src.fps) && src.fps > 0 && src.fps <= 120 ? { fps: Number(src.fps) } : {}),
    ...(bbox ? { bbox } : {}),
    ...(bbox && src.snap === true ? { snap: true } : {}),
    fields,
    sample: src.sample && typeof src.sample === 'object' && !Array.isArray(src.sample) ? src.sample : {},
    contract: typeof src.contract === 'string' ? src.contract.slice(0, 80) : 'casparcg-html',
    manifestFrom: from,
  };
}

const EXTERNAL = [
  /<(?:link|script|img|source|video|audio|iframe|embed|object|image|use|track)\b[^>]*?\b(?:src|href|xlink:href|data)\s*=\s*["']?\s*(?:https?:)?\/\/([^"'\s/>]+)/gi,
  /url\(\s*["']?\s*(?:https?:)?\/\/([^)"'\s/]+)/gi,
  /@import\s+(?:url\()?\s*["']\s*(?:https?:)?\/\/([^"'\s/]+)/gi,
  /\b(?:fetch|EventSource|WebSocket|importScripts|import)\s*\(\s*["'`]\s*(?:https?|wss?):\/\/([^"'`\s/]+)/gi,
  /\bfrom\s+["'](?:https?:)?\/\/([^"'\s/]+)/gi,
  /\.open\(\s*["'][A-Z]+["']\s*,\s*["'](?:https?:)?\/\/([^"'\s/]+)/gi,
];
const RELATIVE = [
  /<(?:link|script|img|source|video|audio|image|track)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi,
  /url\(\s*["']?([^)"'#?]+)["']?\s*\)/gi,
];

function contractFns(js: string) {
  const has = (n: string) => new RegExp(`(?:function\\s+${n}\\s*\\(|\\b(?:window\\.)?${n}\\s*=\\s*(?:async\\s*)?(?:function|\\()|\\b${n}\\s*:\\s*(?:async\\s*)?(?:function|\\())`).test(js);
  return { update: has('update'), play: has('play'), stop: has('stop'), next: has('next') };
}

export function runChecks(files: PackageFile[], m: Manifest): Check[] {
  if (m.contract === 'ograf' && m.ograf) {
    const checks = ografChecks(files, m);
    const visible = m.fields.filter((f) => !f.hidden);
    checks.push({ id: 'fields', level: visible.length ? 'ok' : 'warn',
      title: visible.length ? `${visible.length} field${visible.length === 1 ? '' : 's'} found` : 'No fields found',
      detail: visible.length ? 'Read from the OGraf schema.' : 'The manifest has no schema, so nothing can be filled in. That is fine for a fixed graphic.' });
    checks.push({ id: 'canvas', level: 'ok', title: m.canvasDeclared ? `Canvas ${m.canvas[0]}×${m.canvas[1]}` : 'Responsive',
      detail: m.canvasDeclared ? 'From the render requirements.' : 'No resolution required, so Volt lays it out at 1920×1080.' });
    return [...checks, ...sharedChecks(files)];
  }
  const checks: Check[] = [];
  const add = (id: string, level: CheckLevel, title: string, detail: string) => checks.push({ id, level, title, detail });
  const index = files.find((f) => f.path === 'index.html');
  if (!index) {
    add('entry', 'error', 'No index.html', 'A package needs an index.html at its root, or a single .html file.');
    return checks;
  }
  const text = files.filter((f) => isText(f.path)).map((f) => ({ path: f.path, s: f.data.toString('utf8') }));
  const allJs = text.filter((t) => /\.(html?|m?js)$/i.test(t.path)).map((t) => t.s).join('\n');

  const vj = files.find((f) => f.path.toLowerCase() === 'volt.json');
  if (vj && m.manifestFrom !== 'volt.json') add('manifest', 'error', 'volt.json is not valid JSON', 'Fix the file or remove it.');
  else if (/id=["']volt-manifest["']/i.test(index.data.toString('utf8')) && m.manifestFrom !== 'volt-manifest' && m.manifestFrom !== 'volt.json') {
    add('manifest', 'error', 'The volt-manifest block is not valid JSON', 'Fix the JSON inside <script id="volt-manifest">.');
  }

  add('canvas', m.canvasDeclared ? 'ok' : 'warn',
    m.canvasDeclared ? `Canvas ${m.canvas[0]}×${m.canvas[1]}` : 'No canvas size declared',
    m.canvasDeclared ? 'Declared in the manifest. Positions and the safe area are measured on it.' : 'Treated as 1920×1080. Add "canvas": [1920, 1080] to the manifest to make it explicit.');

  const visible = m.fields.filter((f) => !f.hidden);
  add('fields', visible.length ? 'ok' : 'warn',
    visible.length ? `${visible.length} field${visible.length === 1 ? '' : 's'} found` : 'No fields found',
    visible.length ? `Read from ${m.manifestFrom === 'volt.json' ? 'volt.json' : m.manifestFrom === 'volt-manifest' ? 'the volt-manifest block' : m.manifestFrom === 'spx' ? 'the SPX template definition' : 'data-field attributes'}.`
      : 'Nothing can be filled in. That is fine for a fixed logo or bug; otherwise declare fields in the manifest.');

  const fn = contractFns(allJs);
  const shared = () => [...checks, ...sharedChecks(files)];
  if (visible.length && !fn.update) add('update', 'error', 'No update() function', 'The template has fields but nothing to receive them, so the live panel and the API would change nothing on screen. Add function update(data) { ... } (the CasparCG contract).');
  else if (fn.update) add('update', 'ok', 'update() found', 'The live panel, data feeds and the API drive the fields through it.');
  if (!fn.play || !fn.stop) add('transport', 'warn', `No ${[!fn.play && 'play()', !fn.stop && 'stop()'].filter(Boolean).join(' or ')}`,
    'Take on and off will show and hide it without its animation.');
  else add('transport', 'ok', 'play() and stop() found', fn.next ? 'next() too, for multi-step graphics.' : 'Take on and off play its animation.');
  return shared();
}

/** What every package is checked for, whatever its contract: what breaks on air. */
function sharedChecks(files: PackageFile[]): Check[] {
  const checks: Check[] = [];
  const add = (id: string, level: CheckLevel, title: string, detail: string) => checks.push({ id, level, title, detail });
  const size = files.reduce((a, f) => a + f.data.length, 0);
  const text = files.filter((f) => isText(f.path)).map((f) => ({ path: f.path, s: /\.m?js$/i.test(f.path) ? stripJsComments(f.data.toString('utf8')) : f.data.toString('utf8') }));
  const allJs = text.filter((t) => /\.(html?|m?js)$/i.test(t.path)).map((t) => t.s).join('\n');
  const hosts = new Set<string>();
  for (const t of text) for (const re of EXTERNAL) for (const mm of t.s.matchAll(re)) hosts.add(mm[1].toLowerCase());
  if (hosts.size) {
    const list = [...hosts].slice(0, 3).join(', ') + (hosts.size > 3 ? ` and ${hosts.size - 3} more` : '');
    add('network', 'error', 'Loads files from the internet', `${list}. Graphics run with no network, so these would be missing on air. Put the files in the package and refer to them by relative path.`);
  } else add('network', 'ok', 'Self-contained', 'Everything it loads is inside the package.');

  const have = new Set(files.map((f) => f.path.toLowerCase()));
  const missing = new Set<string>();
  // Markup and styles only: in JavaScript, url( is usually new URL(...), not a file reference.
  for (const t of text.filter((x) => /\.(html?|css|svg)$/i.test(x.path))) {
    const dir = posix.dirname(t.path);
    for (const re of RELATIVE) for (const mm of t.s.matchAll(re)) {
      const ref = mm[1].trim();
      if (!ref || /^(?:[a-z]+:|\/\/|#|\{|\$)/i.test(ref) || ref.startsWith('/')) continue;
      let p: string;
      try { p = posix.normalize(posix.join(dir === '.' ? '' : dir, decodeURIComponent(ref))); } catch { continue; }
      if (!have.has(p.toLowerCase())) missing.add(ref);
    }
  }
  if (missing.size) add('missing', 'warn', `${missing.size} referenced file${missing.size === 1 ? '' : 's'} not in the package`, [...missing].slice(0, 4).join(', ') + (missing.size > 4 ? ' ...' : ''));

  if (/\b(?:document\.cookie|localStorage|sessionStorage|indexedDB)\b/.test(allJs)) {
    add('storage', 'warn', 'Uses browser storage or cookies', 'These are blocked in the sandbox. Keep state in the fields instead.');
  }

  add('size', size <= LIMITS.maxBytes ? 'ok' : 'error', `${fmtBytes(size)} of ${fmtBytes(LIMITS.maxBytes)}`,
    `${files.length} file${files.length === 1 ? '' : 's'}.`);
  add('sandbox', 'ok', 'Runs sandboxed', 'No cookies, no Volt session, no network. The code cannot reach anything outside the graphic.');
  return checks;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function analyse(raw: { path: string; data: Buffer }[]): Analysed {
  const files = normalise(raw);
  const sizeBytes = files.reduce((a, f) => a + f.data.length, 0);
  if (sizeBytes > LIMITS.maxBytes) throw new PackageError(`The package is ${fmtBytes(sizeBytes)}, more than the ${fmtBytes(LIMITS.maxBytes)} allowed.`);
  const manifest = readManifest(files);
  const checks = runChecks(files, manifest);
  return { files, manifest, checks, sizeBytes, publishable: !checks.some((c) => c.level === 'error') };
}
