// Generate a 2400x1350 (16:9) test card so transforms are verifiable by eye and by
// pixels: a grid (squares reveal stretch), corner labels, a centre crosshair, and a
// bright FOCUS badge off-centre near the top-right (reveals focus/gravity on crop).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
mkdirSync('media/live_channel', { recursive: true });

const W = 2400, H = 1350;
let grid = '';
for (let x = 0; x <= W; x += 150) grid += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#2b3346" stroke-width="2"/>`;
for (let y = 0; y <= H; y += 150) grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#2b3346" stroke-width="2"/>`;
const fx = Math.round(W * 0.82), fy = Math.round(H * 0.20);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
 <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
   <stop offset="0" stop-color="#0b1020"/><stop offset="1" stop-color="#15213f"/></linearGradient></defs>
 <rect width="${W}" height="${H}" fill="url(#g)"/>
 ${grid}
 <rect x="4" y="4" width="${W - 8}" height="${H - 8}" fill="none" stroke="#2563eb" stroke-width="8"/>
 <line x1="${W / 2}" y1="0" x2="${W / 2}" y2="${H}" stroke="#3b82f6" stroke-width="2" stroke-dasharray="12 10"/>
 <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#3b82f6" stroke-width="2" stroke-dasharray="12 10"/>
 <g font-family="DejaVu Sans, sans-serif" fill="#8ab4ff" font-weight="bold">
   <text x="30" y="60" font-size="42">TOP-LEFT</text>
   <text x="${W - 320}" y="60" font-size="42">TOP-RIGHT</text>
   <text x="30" y="${H - 30}" font-size="42">BOTTOM-LEFT</text>
   <text x="${W - 470}" y="${H - 30}" font-size="42">BOTTOM-RIGHT</text>
   <text x="${W / 2 - 190}" y="${H / 2 - 30}" font-size="54" fill="#e7e9ee">2400 x 1350</text>
 </g>
 <circle cx="${fx}" cy="${fy}" r="120" fill="#ef4444"/>
 <text x="${fx}" y="${fy + 16}" font-size="52" fill="#fff" font-weight="bold" text-anchor="middle" font-family="DejaVu Sans, sans-serif">FOCUS</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile('media/live_channel/TV1.png');
console.log('generated media/live_channel/TV1.png (2400x1350, focus badge at ~82%,20%)');
