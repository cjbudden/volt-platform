// Code samples in the developer guides are FILES (docs-site/samples/), and a
// check suite in the API runs every one of them against a real Volt API. A
// guide shows one with an empty code block that names it:
//
//   ```bash file=apps-and-keys/register-app.sh
//   ```
//
// and this plugin fills the block from the file at build time, titled with the
// file name. So the code a customer copies is the code that was run, and it
// cannot drift from the product: change the API and the suite fails; change
// the sample and the page follows.
//
// A missing file, or a block that names a file and also has code typed into
// it, fails the build: a pasted copy is exactly the drift this is here to stop.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLES_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'samples');
const FILE_RE = /(?:^|\s)file=(\S+)/;

/** Walk the tree without a dependency: code blocks are all this needs. */
function each(node, fn) {
  if (node.type === 'code') fn(node);
  for (const child of node.children ?? []) each(child, fn);
}

export default function includeSamples() {
  return (tree, file) => {
    each(tree, (node) => {
      const m = FILE_RE.exec(node.meta ?? '');
      if (!m) return;
      const where = file?.path ?? 'a guide';
      const rel = m[1];
      if (rel.includes('..')) throw new Error(`${where}: sample path ${rel} leaves the samples folder`);
      const path = join(SAMPLES_DIR, rel);
      if (!existsSync(path)) throw new Error(`${where}: sample ${rel} does not exist in docs-site/samples`);
      if ((node.value ?? '').trim()) throw new Error(`${where}: the block for ${rel} has code typed into it. Leave it empty: the file is the sample`);
      node.value = readFileSync(path, 'utf8').replace(/\s+$/, '');
      const rest = (node.meta ?? '').replace(FILE_RE, '').trim();
      node.meta = `${rest ? rest + ' ' : ''}title="${basename(rel)}"`;
    });
  };
}
