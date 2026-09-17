// The pure modules live in volt-app (the source of truth, where the tests run).
// This copies them into the package and patches the two imports that reach
// outside the core, so the package builds with no dependency on volt-app.
const fs = require('node:fs'); const path = require('node:path');
const from = path.resolve(__dirname, '../../../volt-app/src/services/ingest');
const to = path.resolve(__dirname, '../src');
const FILES = ['naming.ts', 'rules.ts', 'duplicates.ts', 'sniff.ts', 'id3.ts', 'metadata.ts', 'payload.ts', 'events.ts', 'tus.ts', 's3.ts', 'destinations.ts',
  'sources/types.ts', 'sources/fetcher.ts', 'sources/url.ts', 'sources/dropbox.ts', 'sources/onedrive.ts', 'sources/gdrive.ts', 'sources/index.ts',
  'providers/types.ts', 'providers/aspera.ts', 'providers/masv.ts', 'providers/signiant.ts', 'providers/s3accel.ts', 'providers/index.ts'];
try { fs.rmSync(to, { recursive: true, force: true }); } catch { /* a read-only mount: files are overwritten below */ }
for (const f of FILES) {
  let s = fs.readFileSync(path.join(from, f), 'utf8');
  s = s.replace("import { globToRegExp } from '../watchfolder/rules';", "import { globToRegExp } from './glob';");
  s = s.replace("import type { SchemaField } from '../metadataValidator';", "import type { SchemaField } from './schemaField';");
  fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
  fs.writeFileSync(path.join(to, f), s);
}
fs.writeFileSync(path.join(to, 'glob.ts'), [
  "/** Glob to RegExp, identical to volt-app's watchfolder rules: * any run, ? one char, case-insensitive. */",
  'export function globToRegExp(pattern: string): RegExp {',
  "  const escaped = pattern.replace(/[.+^${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*').replace(/\\?/g, '.');",
  '  return new RegExp(`^${escaped}$`, \'i\');',
  '}', ''].join('\n'));
fs.writeFileSync(path.join(to, 'schemaField.ts'), `/** The shape of a content type field the metadata merge needs. Volt's own is a superset. */
export interface SchemaField { key: string; type?: string; required?: boolean; options?: any[]; [k: string]: any }
`);
fs.writeFileSync(path.join(to, 'index.ts'), `export * from './naming';
export * from './rules';
export * from './duplicates';
export * from './sniff';
export * from './id3';
export * from './metadata';
export * from './payload';
export * from './events';
export * from './tus';
export * from './s3';
export * from './destinations';
export * as sources from './sources';
export * as providers from './providers';
export { globToRegExp } from './glob';
export type { SchemaField } from './schemaField';
`);
console.log(`synced ${FILES.length} modules into ${to}`);
