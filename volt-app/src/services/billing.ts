// ============================================================================
//  Billing awareness (indicative). The billable unit is the encoder SERVER
//  (compute) while it is up. This module gives a recommended instance size and
//  an INDICATIVE hourly rate from the output profile + ladder, so the UI can
//  show "what this costs while running" without being in-your-face.
//
//  Rates here are indicative placeholders for the dev/preview UI. Real rates come
//  from the cloud pricing table (Tier-2). Anything shown must be labelled indicative.
// ============================================================================

export interface InstanceRec {
  instance: string;
  rateUsdPerHour: number;
  indicative: true;
  basis: string;   // short human explanation of the pick
}

/** Recommend an encoder instance + indicative rate from workflow + ladder. */
export function recommendInstance(
  workflow: 'transcode' | 'package_only' | string | undefined,
  ladder: { height: number }[],
): InstanceRec {
  const rungs = ladder?.length ?? 0;
  const maxH = ladder?.reduce((m, r) => Math.max(m, r.height || 0), 0) ?? 0;

  // package_only is a cheap re-mux (no re-encode): a small box copes with many rungs.
  if (workflow === 'package_only') {
    return { instance: 'c6i.large', rateUsdPerHour: 0.085, indicative: true,
             basis: `package-only (re-mux, ${rungs} rendition${rungs === 1 ? '' : 's'})` };
  }

  // transcode is CPU-heavy (x264). Size by ladder depth + top resolution.
  if (maxH <= 480 || rungs <= 1) {
    return { instance: 'c6i.large', rateUsdPerHour: 0.085, indicative: true,
             basis: `transcode ${rungs} rung(s), <=480p` };
  }
  if (maxH <= 1080 && rungs <= 3) {
    return { instance: 'c6i.xlarge', rateUsdPerHour: 0.17, indicative: true,
             basis: `transcode ${rungs} rungs, up to ${maxH}p` };
  }
  return { instance: 'c6i.2xlarge', rateUsdPerHour: 0.34, indicative: true,
           basis: `transcode ${rungs} rungs, up to ${maxH}p (heavy)` };
}

export interface Billing {
  billable: boolean;         // is the server up (i.e. metering) right now?
  since: number | null;      // epoch ms the server came up, or null
  elapsedSec: number;        // seconds billable so far this run
  instance: string;          // recommended/assigned instance type
  rateUsdPerHour: number;    // indicative hourly rate
  estRunUsd: number;         // indicative cost of the current run so far
  indicative: true;
  basis: string;
}

export function buildBilling(
  serverUp: boolean,
  sinceMs: number | null,
  nowMs: number,
  rec: InstanceRec,
): Billing {
  const elapsedSec = serverUp && sinceMs ? Math.max(0, Math.round((nowMs - sinceMs) / 1000)) : 0;
  const estRunUsd = Math.round((elapsedSec / 3600) * rec.rateUsdPerHour * 100) / 100;
  return {
    billable: serverUp,
    since: serverUp ? sinceMs : null,
    elapsedSec,
    instance: rec.instance,
    rateUsdPerHour: rec.rateUsdPerHour,
    estRunUsd,
    indicative: true,
    basis: rec.basis,
  };
}
