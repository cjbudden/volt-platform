// Virtual clock shim, injected before any template script runs (addInitScript).
// Makes an UNMODIFIED CasparCG-style template deterministic and seekable:
//  - performance.now / Date.now / new Date() read a virtual clock
//  - requestAnimationFrame callbacks fire once per virtual step
//  - setTimeout / setInterval fire when virtual time passes their due time
//  - Web Animations (CSS transitions, CSS @keyframes, element.animate) are paused
//    and their currentTime is driven from the virtual clock
// GSAP, anime.js, Lottie-web etc. all drive themselves from rAF + performance.now
// or Date.now, so they follow the virtual clock without knowing about it.
(() => {
  if (window.__vclock) return;
  const realDateNow = Date.now.bind(Date);
  const RealDate = Date;
  const epoch = realDateNow();
  const V = { t: 0, timers: [], raf: [], seq: 1, anims: new WeakMap() };
  window.__vclock = V;
  performance.now = () => V.t;
  Date.now = () => epoch + V.t;
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(epoch + V.t); else super(...a); }
    static now() { return epoch + V.t; }
  };
  window.requestAnimationFrame = (cb) => { const id = V.seq++; V.raf.push({ id, cb }); return id; };
  window.cancelAnimationFrame = (id) => { V.raf = V.raf.filter(r => r.id !== id); };
  const addTimer = (cb, ms, args, repeat) => {
    const id = V.seq++;
    V.timers.push({ id, cb, due: V.t + Math.max(0, +ms || 0), every: repeat ? Math.max(1, +ms || 0) : 0, args });
    return id;
  };
  window.setTimeout = (cb, ms, ...args) => addTimer(cb, ms, args, false);
  window.setInterval = (cb, ms, ...args) => addTimer(cb, ms, args, true);
  window.clearTimeout = window.clearInterval = (id) => { V.timers = V.timers.filter(t => t.id !== id); };

  function syncAnimations() {
    let running = 0;
    for (const a of document.getAnimations()) {
      let start = V.anims.get(a);
      if (start === undefined) { start = V.t; V.anims.set(a, start); a.pause(); }
      const local = V.t - start;
      const end = a.effect ? a.effect.getComputedTiming().endTime : 0;
      if (local >= end && isFinite(end)) { a.currentTime = end; try { a.finish(); } catch (_) {} }
      else { a.currentTime = local; running++; }
    }
    return running;
  }
  // Advance virtual time by ms: fire due timers in order, then one rAF tick.
  window.__vstep = (ms) => {
    const target = V.t + ms;
    for (;;) {
      V.timers.sort((a, b) => a.due - b.due);
      const t = V.timers[0];
      if (!t || t.due > target) break;
      V.t = t.due;
      if (t.every) t.due += t.every; else V.timers.shift();
      try { typeof t.cb === 'function' ? t.cb(...(t.args || [])) : eval(t.cb); } catch (e) { console.error(e); }
    }
    V.t = target;
    const q = V.raf; V.raf = [];
    for (const r of q) { try { r.cb(V.t); } catch (e) { console.error(e); } }
    return syncAnimations();
  };
  // How busy is the page: running WAAPI animations + active GSAP tweens.
  window.__vbusy = () => {
    let n = 0;
    for (const a of document.getAnimations()) if (a.playState !== 'finished') n++;
    if (window.gsap && gsap.globalTimeline) n += gsap.globalTimeline.getChildren(true, true, false).filter(t => t.isActive()).length;
    return n;
  };
})();
