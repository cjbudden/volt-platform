// Headless Chromium renderer for one graphics template.
// Clock modes:
//   vclock   - sidecar/vclock.js shim (virtual performance.now/Date/rAF/timers + WAAPI)
//   cdp      - Chromium's own virtual time (Emulation.setVirtualTimePolicy budgets)
//   seek     - template-exposed window.seek(t) (e.g. a GSAP timeline), no shim
//   realtime - no control; capture whatever is on screen (the naive baseline)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

function findChrome() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const c = [path.join(base, 'chromium_headless_shell-1194/chrome-linux/headless_shell'),
             path.join(base, 'chromium-1194/chrome-linux/chrome')];
  return c.find(p => fs.existsSync(p));
}

class Renderer {
  constructor(opts = {}) {
    this.fps = opts.fps || 25;
    this.clock = opts.clock || 'vclock';
    this.bbox = opts.bbox || null;          // [x,y,w,h]; null = from manifest
    this.vt = 0;                            // seconds of animation time (seek mode)
  }

  async init(url) {
    this.browser = await chromium.launch({
      executablePath: findChrome(),
      args: ['--disable-gpu', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling',
             '--disable-renderer-backgrounding', '--font-render-hinting=none'],
    });
    this.context = await this.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    this.page = await this.context.newPage();
    if (this.clock === 'vclock') await this.page.addInitScript({ path: path.join(__dirname, 'vclock.js') });
    this.cdp = await this.context.newCDPSession(this.page);
    await this.cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await this.page.goto(url, { waitUntil: 'load' });
    // CDP virtual time: load normally, then freeze the page clock and advance it in budgets
    if (this.clock === 'cdp') await this.cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    this.manifest = await this.page.evaluate(() => {
      const m = document.getElementById('volt-manifest'); return m ? JSON.parse(m.textContent) : null;
    }).catch(() => null);
    if (!this.bbox) this.bbox = (this.manifest && this.manifest.bbox) || [0, 0, 1920, 1080];
    if (this.clock === 'vclock') await this.page.evaluate(() => window.__vstep(0));
    return this;
  }

  advanceCdp(ms) {
    return new Promise((resolve) => {
      this.cdp.once('Emulation.virtualTimeBudgetExpired', resolve);
      this.cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: ms }).catch(resolve);
    });
  }

  // Call a CasparCG API function (update/play/stop/next) in the page.
  async call(fn, arg) {
    const t = Date.now();
    await this.page.evaluate(([fn, arg]) => {
      const f = window[fn]; if (typeof f !== 'function') return false;
      f(arg === undefined ? undefined : (typeof arg === 'string' ? arg : JSON.stringify(arg)));
      if (window.__vstep) window.__vstep(0);
      return true;
    }, [fn, arg]);
    if (fn === 'play' || fn === 'stop') {
      this.vt = 0;
      if (this.clock === 'seek') await this.page.evaluate(() => window.seek && window.seek(0));
    }
    return Date.now() - t;
  }

  // Advance the animation clock by one frame.
  async step() {
    const ms = 1000 / this.fps;
    if (this.clock === 'vclock') return this.page.evaluate((ms) => window.__vstep(ms), ms);
    if (this.clock === 'cdp') return this.advanceCdp(ms);
    if (this.clock === 'seek') { this.vt += ms / 1000; return this.page.evaluate((t) => window.seek && window.seek(t), this.vt); }
    return null; // realtime: nothing to drive
  }

  async busy() {
    return this.page.evaluate(() => (window.__vbusy ? window.__vbusy() : 0)).catch(() => 0);
  }

  // PNG with alpha of the bbox only.
  async capture() {
    const [x, y, w, h] = this.bbox;
    const r = await this.cdp.send('Page.captureScreenshot', {
      format: 'png', clip: { x, y, width: w, height: h, scale: 1 },
      fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true,
    });
    return Buffer.from(r.data, 'base64');
  }

  // Render frames from "now" until the graphic settles (2 identical frames and nothing
  // animating) or maxFrames. onFrame(png, idx) is called as each frame is ready, so
  // playout can start before the whole transition is rendered.
  async renderTransition(onFrame, { maxFrames = 100, minFrames = 1 } = {}) {
    let last = null, same = 0, n = 0;
    const timings = [];
    for (; n < maxFrames; n++) {
      const t0 = process.hrtime.bigint();
      if (n > 0) await this.step();
      const png = await this.capture();
      timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
      const h = crypto.createHash('md5').update(png).digest('hex');
      if (h === last) same++; else same = 0;
      last = h;
      await onFrame(png, n, h);
      if (n + 1 >= minFrames && same >= 1 && (await this.busy()) === 0) { n++; break; }
    }
    return { frames: n, timings };
  }

  async close() { try { await this.browser.close(); } catch (_) {} }
}

module.exports = { Renderer, findChrome };
