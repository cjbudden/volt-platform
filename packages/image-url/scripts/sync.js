// The image URL SDK lives in volt-app (the source of truth, where the tests run).
// This copies it, byte for byte, into the package and into the console.
//   node packages/image-url/scripts/sync.js
// volt-app/test/images.check.ts fails if either copy drifts.
const fs = require('node:fs'); const path = require('node:path');
const from = path.resolve(__dirname, '../../../volt-app/src/services/images/sdk.ts');
const targets = [
  path.resolve(__dirname, '../src/index.ts'),
  path.resolve(__dirname, '../../../volt-web/src/lib/imageUrl.ts'),
];
const src = fs.readFileSync(from, 'utf8');
for (const t of targets) {
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, src);
  console.log(`synced ${path.relative(process.cwd(), t)}`);
}
