// ============================================================================
//  OS, BROWSER AND DEVICE CLASS FROM THE USER AGENT (QOE_REPORTING.md section 6).
//
//  Read by the collector from the report POST's own headers (User-Agent and,
//  on Chromium, the low-entropy Client Hints). Major versions only: minor
//  versions multiply the rows and nobody filters by them. Device class uses
//  the same rules as the Analytics beacons (services/analytics.ts
//  parseDevice), so the two count a phone the same way. A native app's own
//  device model arrives in the report itself (com.volt-dm) and wins.
// ============================================================================

export interface UaFacts { os: string | null; osVersion: string | null; browser: string | null; browserVersion: string | null; deviceClass: string }

const major = (v: string | undefined | null) => (v ? String(v).split(/[._]/)[0] : null);

export function deviceClass(ua: string): string {
  const u = ua.toLowerCase();
  if (/smart-tv|smarttv|tizen|web0s|webos|appletv|crkey|roku|bravia|aft|googletv|android tv/.test(u)) return 'TV';
  if (/ipad|tablet/.test(u)) return 'Tablet';
  if (/mobile|iphone|android/.test(u)) return 'Mobile';
  if (/mozilla|chrome|safari|firefox|edge/.test(u)) return 'Desktop';
  return 'Unknown';
}

export function parseUa(ua = '', hints: { platform?: string | null; platformVersion?: string | null } = {}): UaFacts {
  let os: string | null = null, osVersion: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /Tizen ?([\d.]+)?/i.exec(ua))) { os = 'Tizen'; osVersion = major(m[1]); }
  else if ((m = /Web0S|webOS/i.exec(ua))) { os = 'webOS'; }
  else if ((m = /(?:iPhone|iPad|iPod).*? OS (\d+)/i.exec(ua))) { os = 'iOS'; osVersion = m[1]; }
  else if ((m = /Android ?([\d.]+)?/i.exec(ua))) { os = 'Android'; osVersion = major(m[1]); }
  else if ((m = /Windows NT ([\d.]+)/i.exec(ua))) { os = 'Windows'; osVersion = m[1] === '10.0' ? '10' : major(m[1]); }
  else if ((m = /Mac OS X (\d+)[_.](\d+)/i.exec(ua))) { os = 'macOS'; osVersion = m[1] === '10' ? `10.${m[2]}` : m[1]; }
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  // Client Hints say Windows 11 and macOS releases the frozen UA string cannot.
  const hp = (hints.platform ?? '').replace(/"/g, '');
  if (hp) {
    const hv = (hints.platformVersion ?? '').replace(/"/g, '');
    if (hp === 'Windows') { os = 'Windows'; if (hv) osVersion = Number(major(hv)) >= 13 ? '11' : '10'; }
    else if (hp === 'macOS') { os = 'macOS'; if (hv) osVersion = major(hv); }
    else if (!os) os = hp;
  }
  let browser: string | null = null, browserVersion: string | null = null;
  if ((m = /Edg(?:e|A|iOS)?\/(\d+)/.exec(ua))) { browser = 'Edge'; browserVersion = m[1]; }
  else if ((m = /SamsungBrowser\/(\d+)/.exec(ua))) { browser = 'Samsung Internet'; browserVersion = m[1]; }
  else if ((m = /(?:OPR|Opera)\/(\d+)/.exec(ua))) { browser = 'Opera'; browserVersion = m[1]; }
  else if ((m = /(?:Firefox|FxiOS)\/(\d+)/.exec(ua))) { browser = 'Firefox'; browserVersion = m[1]; }
  else if ((m = /(?:Chrome|CriOS|HeadlessChrome)\/(\d+)/.exec(ua))) { browser = 'Chrome'; browserVersion = m[1]; }
  else if ((m = /Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//.exec(ua))) { browser = 'Safari'; browserVersion = m[1]; }
  else if (/AppleWebKit/.test(ua) && os === 'iOS') browser = 'WebView';
  return { os, osVersion, browser, browserVersion, deviceClass: deviceClass(ua) };
}
