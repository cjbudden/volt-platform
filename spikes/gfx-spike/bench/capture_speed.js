const { chromium } = require('playwright-core');
const { findChrome } = require('../sidecar/renderer');
(async () => {
  for (const flags of [[], ['--disable-frame-rate-limit', '--disable-gpu-vsync']]) {
    const b = await chromium.launch({ executablePath: findChrome(), args: ['--disable-gpu', ...flags] });
    const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    const c = await p.context().newCDPSession(p);
    await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await p.goto('file://' + require('path').resolve(__dirname, '../templates') + '/scorebug/index.html?preview');
    const t = [];
    for (const clip of [[64,44,672,112],[0,1010,1920,56],[0,0,1920,1080]]) {
      const ts = [];
      for (let i = 0; i < 30; i++) {
        await p.evaluate((i) => { document.getElementById('clock').textContent = '00:' + i; }, i);
        const s = process.hrtime.bigint();
        await c.send('Page.captureScreenshot', { format: 'png', clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: 1 }, fromSurface: true, optimizeForSpeed: true });
        ts.push(Number(process.hrtime.bigint() - s) / 1e6);
      }
      ts.sort((a, b) => a - b); t.push(`${clip[2]}x${clip[3]}: med ${ts[15].toFixed(1)} p95 ${ts[28].toFixed(1)}`);
    }
    console.log(JSON.stringify(flags), t.join(' | '));
    await b.close();
  }
})();
