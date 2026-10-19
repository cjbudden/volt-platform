// Minimal static file handler: /templates/*, /preview/*, /lib/gsap.min.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
const MAP = { '/lib/gsap.min.js': path.join(ROOT, 'node_modules/gsap/dist/gsap.min.js') };

function serveStatic(req, res) {
  const u = new URL(req.url, 'http://x');
  let p = MAP[u.pathname];
  if (!p && /^\/(templates|preview)\//.test(u.pathname)) {
    p = path.join(ROOT, path.normalize(u.pathname).replace(/^\/+/, ''));
    if (p.endsWith('/')) p += 'index.html';
    if (!p.startsWith(ROOT)) p = null;
  }
  if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return false;
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
  return true;
}
module.exports = { serveStatic, ROOT };
