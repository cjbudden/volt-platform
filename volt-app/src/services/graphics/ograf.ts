// ============================================================================
//  EBU OGRAF PACKAGES: read the manifest, map its schema, host the component.
//
//  OGraf (ograf.ebu.io, v1) is the EBU's open standard for HTML broadcast
//  graphics. A package is a folder with a *.ograf.json manifest and an ES
//  module (`main`) whose default export is a Web Component class with
//  load / updateAction / playAction / stopAction / customAction / dispose.
//
//  Volt drives every template through the CasparCG contract (update, play,
//  next, stop) over the postMessage bridge, so an OGraf package needs no
//  special case anywhere else: at serve time /gfx/<version>/index.html is a
//  small host page, generated from the stored manifest, that registers the
//  component, calls load() and maps the four functions onto its actions:
//
//    update(json)  updateAction({ data })     merged with earlier values
//    play()        playAction({ goto: 0 })    the first step
//    next()        playAction({ delta: 1 })   the next step (past the last ends it)
//    stop()        stopAction({})
//
//  The uploaded files are stored exactly as uploaded; the host page is never
//  stored, so a downloaded package is still a valid OGraf package.
//
//  PURE: no database, no network. Tested by test/graphics-pure.check.ts.
// ============================================================================
import type { Check, CheckLevel, Manifest, PackageFile, TemplateField, FieldType } from './templatePackage';

export const OGRAF_SCHEMA_V1 = 'https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json';
export const isOgrafManifest = (path: string) => /\.ograf\.json$/i.test(path);

export interface OgrafInfo {
  manifestPath: string;
  id: string;
  version?: string;
  description?: string;
  author?: string;
  main: string;
  stepCount: number;
  supportsRealTime: boolean;
  supportsNonRealTime: boolean;
  customActions: { id: string; name: string }[];
  /** Schema properties Volt could not turn into a field (objects), left at their defaults. */
  unmapped: string[];
  /** Raw problems found while reading, turned into checks. */
  problems: { id: string; level: CheckLevel; title: string; detail: string }[];
  manifestCount: number;
  requiresInternet?: boolean;
  /** Stylesheets Volt adds to the host page: volt-fonts.css from the style editor. */
  css?: string[];
}

/** The manifests in a package, root first, then by path. */
export function ografManifests<T extends { path: string }>(files: T[]): T[] {
  return files.filter((f) => isOgrafManifest(f.path))
    .sort((a, b) => (a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path));
}

const FIELD_ID = /^[A-Za-z_$][\w $.-]{0,63}$/;
const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function constraint(c: any): number | undefined {
  if (typeof c === 'number' && Number.isFinite(c)) return c;
  if (!c || typeof c !== 'object') return undefined;
  for (const k of ['exact', 'ideal', 'max', 'min']) if (Number.isFinite(c[k])) return Number(c[k]);
  return undefined;
}

/** One schema property as a Volt field. Objects have no Volt input: null. */
export function fieldFromSchema(id: string, p: any): (TemplateField & { order?: number; default?: unknown }) | null {
  if (!FIELD_ID.test(id) || id !== id.trim() || !p || typeof p !== 'object') return null;
  const types = (Array.isArray(p.type) ? p.type : [p.type]).filter((t: any) => t && t !== 'null');
  const jt = String(types[0] ?? (Array.isArray(p.enum) ? typeof p.enum[0] : 'string'));
  const gdd = String(p.gddType ?? '').toLowerCase();
  let type: FieldType;
  if (jt === 'object') return null;
  if (jt === 'array') type = 'list';
  else if (jt === 'number' || jt === 'integer') type = 'number';
  else if (jt === 'boolean') type = 'boolean';
  else if (gdd.startsWith('color') || p.format === 'color') type = 'color';
  else if (gdd.includes('image') || (gdd.startsWith('file-path') && /image/.test(JSON.stringify(p.gddOptions ?? {}) + gdd)) || /^image\//.test(String(p.contentMediaType ?? ''))) type = 'image';
  else type = 'text';
  const label = (str(p.label, 80) ?? str(p.title, 80) ?? id);
  const f: TemplateField & { order?: number; default?: unknown } = { id, type, label };
  // OGraf's `hidden` only keeps a value out of display names; the field still gets an input.
  if (Array.isArray(p.enum) && p.enum.length && p.enum.length <= 100 && p.enum.every((v: any) => typeof v === 'string' || typeof v === 'number')) {
    const labels = p.gddOptions?.labels && typeof p.gddOptions.labels === 'object' ? p.gddOptions.labels : {};
    f.options = p.enum.map((v: string | number) => ({ value: v, label: String(labels[String(v)] ?? v).slice(0, 80) }));
  }
  if (Number.isFinite(p.order)) f.order = Number(p.order);
  if (p.default !== undefined) f.default = p.default;
  return f;
}

/** The fields and sample data an OGraf `schema` describes, in the schema's `order`. */
export function fieldsFromSchema(schema: any): { fields: TemplateField[]; sample: Record<string, unknown>; unmapped: string[] } {
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const out: (TemplateField & { order?: number; default?: unknown; i: number })[] = [];
  const unmapped: string[] = [];
  const sample: Record<string, unknown> = {};
  const topDefault = schema?.default && typeof schema.default === 'object' ? schema.default : {};
  Object.entries<any>(props).forEach(([id, p], i) => {
    const f = fieldFromSchema(id, p);
    if (!f) { unmapped.push(id); return; }
    out.push({ ...f, i });
  });
  out.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.i - b.i);
  const fields = out.slice(0, 100).map(({ order: _o, default: d, i: _i, ...f }) => {
    const v = topDefault[f.id] !== undefined ? topDefault[f.id] : d;
    if (v !== undefined) sample[f.id] = v;
    return f;
  });
  return { fields, sample, unmapped };
}

/**
 * Read the package's OGraf manifest into a Volt manifest, or null when the
 * package has none. Problems (bad JSON, missing required fields) are carried
 * in `ograf.problems` and become checks, so a broken package is still shown.
 */
export function readOgraf(files: PackageFile[]): Manifest | null {
  const manifests = ografManifests(files);
  if (!manifests.length) return null;
  const mf = manifests[0];
  const problems: OgrafInfo['problems'] = [];
  let d: any = null;
  try { d = JSON.parse(mf.data.toString('utf8').replace(/^﻿/, '')); } catch (e: any) {
    problems.push({ id: 'manifest', level: 'error', title: `${mf.path} is not valid JSON`, detail: String(e?.message ?? e).slice(0, 200) });
  }
  if (d && (typeof d !== 'object' || Array.isArray(d))) { problems.push({ id: 'manifest', level: 'error', title: `${mf.path} is not an OGraf manifest`, detail: 'It should be a JSON object.' }); d = null; }
  d = d ?? {};
  if (d.$schema && typeof d.$schema === 'string' && d.$schema !== OGRAF_SCHEMA_V1) {
    problems.push({ id: 'ograf-version', level: 'warn', title: 'Not an OGraf v1 manifest', detail: `$schema is ${String(d.$schema).slice(0, 120)}. Volt reads OGraf v1; the graphic may still work.` });
  }
  const missing = (['id', 'name', 'main'] as const).filter((k) => !str(d[k], 300));
  if (typeof d.supportsRealTime !== 'boolean') missing.push('supportsRealTime' as any);
  if (missing.length && problems.every((p) => p.id !== 'manifest')) {
    problems.push({ id: 'manifest', level: missing.some((k) => k === 'main') ? 'error' : 'warn', title: `The manifest has no ${missing.join(', ')}`, detail: 'These are required by OGraf v1.' });
  }

  const rr = (Array.isArray(d.renderRequirements) ? d.renderRequirements : []).filter((r: any) => r && typeof r === 'object');
  const withRes = rr.find((r: any) => r.resolution);
  const w = constraint(withRes?.resolution?.width); const h = constraint(withRes?.resolution?.height);
  const canvasOk = Number.isInteger(w) && Number.isInteger(h) && w! >= 16 && h! >= 16 && w! <= 7680 && h! <= 7680;
  const fps = constraint(rr.find((r: any) => r.frameRate)?.frameRate);
  const requiresInternet = rr.length > 0 && rr.every((r: any) => r.accessToPublicInternet?.exact === true);

  const { fields, sample, unmapped } = fieldsFromSchema(d.schema);
  const stepCount = Number.isInteger(d.stepCount) ? Number(d.stepCount) : 1;
  const author = str(d.author?.name, 120) ?? str(d.author, 120);
  const mainRel = str(d.main, 300) ?? '';
  const dir = mf.path.includes('/') ? mf.path.slice(0, mf.path.lastIndexOf('/') + 1) : '';
  const info: OgrafInfo = {
    manifestPath: mf.path,
    id: str(d.id, 200) ?? mf.path.replace(/\.ograf\.json$/i, ''),
    ...(str(d.version, 40) ? { version: str(d.version, 40) } : {}),
    ...(str(d.description, 500) ? { description: str(d.description, 500) } : {}),
    ...(author ? { author } : {}),
    main: mainRel ? (dir + mainRel.replace(/^\.\//, '')) : '',
    stepCount,
    supportsRealTime: d.supportsRealTime !== false,
    supportsNonRealTime: d.supportsNonRealTime === true,
    customActions: (Array.isArray(d.customActions) ? d.customActions : []).filter((a: any) => str(a?.id, 80))
      .slice(0, 50).map((a: any) => ({ id: str(a.id, 80)!, name: str(a.name, 80) ?? str(a.id, 80)! })),
    unmapped,
    problems,
    manifestCount: manifests.length,
    ...(requiresInternet ? { requiresInternet: true } : {}),
    ...(files.some((f) => f.path === 'volt-fonts.css') ? { css: ['volt-fonts.css'] } : {}),
  };
  return {
    ...(str(d.name, 120) ? { name: str(d.name, 120) } : {}),
    canvas: canvasOk ? [w!, h!] : [1920, 1080],
    canvasDeclared: canvasOk,
    ...(fps && fps > 0 && fps <= 120 ? { fps } : {}),
    fields,
    sample,
    contract: 'ograf',
    manifestFrom: 'ograf',
    ograf: info,
  };
}

/** Strip JS comments so a JSDoc `import("https://ograf.ebu.io/…")` type is not read as a network load. */
export function stripJsComments(js: string): string {
  return js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`\w])\/\/[^\n]*/g, '$1');
}

/** The contract checks for an OGraf package (the shared checks run after these). */
export function ografChecks(files: PackageFile[], m: Manifest): Check[] {
  const o = m.ograf!;
  const checks: Check[] = [];
  const add = (id: string, level: CheckLevel, title: string, detail: string) => checks.push({ id, level, title, detail });
  for (const p of o.problems) add(p.id, p.level, p.title, p.detail);
  const fatal = o.problems.some((p) => p.id === 'manifest' && p.level === 'error');
  if (!fatal) {
    add('ograf', 'ok', `EBU OGraf graphic${o.version ? ` v${o.version}` : ''}`,
      `${o.manifestPath}, id ${o.id}${o.author ? `, by ${o.author}` : ''}. Volt hosts the Web Component and drives it through load, updateAction, playAction and stopAction.`);
  }
  if (o.manifestCount > 1) add('manifests', 'warn', `${o.manifestCount} OGraf manifests in the package`, `Using ${o.manifestPath}. Upload each graphic as its own package to use the others.`);
  if (files.some((f) => f.path === 'index.html')) add('entry-html', 'warn', 'index.html is not used', 'The OGraf manifest is the entry. Volt serves its own host page for the component in place of index.html.');
  if (!o.supportsRealTime) add('realtime', 'error', 'Not a real-time graphic', 'The manifest sets supportsRealTime to false. Volt plays graphics live, in the player and over the picture, so it needs a real-time graphic.');

  const main = o.main ? files.find((f) => f.path === o.main) : undefined;
  if (o.main && !main) add('entry', 'error', `${o.main} is not in the package`, 'The manifest\'s main file is missing, so there is no graphic to load.');
  if (main && !/\.m?js$/i.test(main.path)) add('entry', 'warn', `${main.path} is not a JavaScript module`, 'OGraf main files are ES modules (.mjs or .js).');
  if (main) {
    const js = stripJsComments(main.data.toString('utf8'));
    if (!/\bexport\s+default\b|\bexport\s*\{[^}]*\bas\s+default\b/.test(js)) {
      add('export', 'error', 'No default export', `${main.path} must export the graphic's class as its default export (export default class ... extends HTMLElement).`);
    }
    const has = (n: string) => new RegExp(`\\b${n}\\s*\\(|\\b${n}\\s*[:=]\\s*(?:async\\b|function\\b|\\()`).test(js);
    const missing = ['load', 'playAction', 'stopAction', 'updateAction'].filter((n) => !has(n));
    const visible = m.fields.filter((f) => !f.hidden).length;
    if (missing.length) {
      add('transport', missing.includes('load') || missing.includes('playAction') ? 'error' : 'warn', `No ${missing.join(', ')} in ${main.path}`,
        missing.includes('updateAction') && visible ? 'Fields would not reach the graphic on air.' : 'OGraf v1 requires these methods. If they come from a base class in another file, this is safe to ignore.');
    } else {
      add('transport', 'ok', 'load, playAction, stopAction and updateAction found',
        o.stepCount === 1 || o.stepCount === 0 ? 'Take on and off play its animations; changing a field calls updateAction.'
          : `It has ${o.stepCount === -1 ? 'a variable number of' : o.stepCount} steps: Next in live control steps through them.`);
    }
  }
  if (o.customActions.length) {
    add('custom', 'warn', `${o.customActions.length} custom action${o.customActions.length === 1 ? '' : 's'} not driven yet`,
      `${o.customActions.map((a) => a.name).slice(0, 4).join(', ')}${o.customActions.length > 4 ? ' ...' : ''}. Volt runs take on, next, update and take off; custom actions are not in live control yet.`);
  }
  if (o.unmapped.length) add('unmapped', 'warn', `${o.unmapped.length} schema propert${o.unmapped.length === 1 ? 'y' : 'ies'} without an input`, `${o.unmapped.slice(0, 4).join(', ')}: nested objects are left at the graphic's own defaults.`);
  if (o.requiresInternet) add('internet', 'error', 'Requires the public internet', 'Its render requirements need internet access. Graphics run with no network in Volt, so it would not render on air.');
  return checks;
}

const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[c]!));

/**
 * The host page served at /gfx/<version>/index.html for an OGraf package. It
 * exposes update / play / next / stop for the bridge (injected after, at
 * serve time) and queues every call behind load(), as OGraf requires.
 */
export function ografHostPage(m: Manifest): string {
  const o = m.ograf!;
  const [w, h] = m.canvas;
  const cfg = { main: './' + o.main.split('/').map(encodeURIComponent).join('/'), w, h, fps: m.fps ?? 25, name: m.name ?? o.id };
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="generator" content="Volt OGraf host">
<title>${(m.name ?? o.id).replace(/[<&]/g, '')}</title>
${(o.css ?? []).filter((c) => /^[\w./-]+\.css$/.test(c)).map((c) => `<link rel="stylesheet" href="./${c}">`).join('\n')}
<style>html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}
volt-ograf-graphic{position:absolute;left:0;top:0;width:${w}px;height:${h}px;display:block;overflow:hidden}</style>
<script>(function(){
var C=${esc(JSON.stringify(cfg))};
var el=null,data={},started=false;
function err(e){try{parent.postMessage({type:'volt-gfx-error',message:'OGraf: '+String(e&&e.message||e)},'*')}catch(_){}}
function check(r){if(r&&typeof r.statusCode==='number'&&r.statusCode>=400)err(new Error(r.statusMessage||('status '+r.statusCode)));return r}
var chain=new Promise(function(ok){if(document.body)ok();else addEventListener('DOMContentLoaded',function(){ok()})})
.then(function(){return import(C.main)})
.then(function(mod){
  var K=mod&&mod.default;
  if(typeof K!=='function')throw new Error(C.main.slice(2)+' has no default export');
  if(!customElements.get('volt-ograf-graphic'))customElements.define('volt-ograf-graphic',K);
  el=document.createElement('volt-ograf-graphic');
  document.body.appendChild(el);
  started=true;
  return el.load({data:JSON.parse(JSON.stringify(data)),renderType:'realtime',renderCharacteristics:{resolution:{width:C.w,height:C.h},frameRate:C.fps}});
}).then(check).catch(function(e){el=null;err(e)});
function run(name,params){chain=chain.then(function(){if(!el||typeof el[name]!=='function')return;return el[name](params)}).then(check).catch(err);return chain}
window.update=function(json){var d;try{d=typeof json==='string'?JSON.parse(json||'{}'):(json||{})}catch(e){err(e);return}
  for(var k in d)if(Object.prototype.hasOwnProperty.call(d,k))data[k]=d[k];
  if(started)run('updateAction',{data:JSON.parse(JSON.stringify(data))})};
window.play=function(){run('playAction',{goto:0})};
window.next=function(){run('playAction',{delta:1})};
window.stop=function(){run('stopAction',{})};
window.voltOgraf={customAction:function(id,payload){return run('customAction',{id:id,payload:payload})},ready:function(){return chain}};
addEventListener('pagehide',function(){try{el&&el.dispose&&el.dispose({})}catch(_){}});
})();</script>
</head><body></body></html>
`;
}
