// ============================================================================
//  ENGINE REGISTRY + the generic capability check.
//
//  Adapters register themselves here (see engines/index.ts). The registry is
//  also where the CATALOGUE lives, so the console can list vendors that are
//  planned but not installed: a customer conversation needs "what would
//  Bitmovin give us" before anyone has written the adapter.
// ============================================================================
import { CATALOG } from './catalog';
import type { EncodeEngine, EngineDescriptor, EngineMode, JobSpec, ValidationIssue } from './types';

const engines = new Map<string, EncodeEngine>();

export function registerEngine(e: EncodeEngine): void {
  const id = e.descriptor.id;
  if (engines.has(id)) throw new Error(`[engines] engine already registered: ${id}`);
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id)) throw new Error(`[engines] bad engine id: ${id}`);
  engines.set(id, e);
}

/** For tests only: forget a registered engine. */
export function unregisterEngine(id: string): void { engines.delete(id); }

export function getEngine(id: string): EncodeEngine | null {
  return engines.get(id) ?? null;
}

/** Installed engines first, then catalogue entries that have no adapter yet. */
export function listEngines(): EngineDescriptor[] {
  const out: EngineDescriptor[] = [...engines.values()].map((e) => ({ ...e.descriptor, availability: 'installed' }));
  for (const d of CATALOG) if (!engines.has(d.id)) out.push({ ...d, availability: 'planned' });
  return out;
}

export function describeEngine(id: string): EngineDescriptor | null {
  return listEngines().find((d) => d.id === id) ?? null;
}

/**
 * Check a neutral job against what an engine declares it can do.
 *
 * Generic on purpose: it reads the job config the orchestrator already builds
 * and the descriptor's caps, so an adapter gets these checks for free and only
 * adds vendor-specific ones in its own validate(). An `error` refuses the
 * start (and the profile save); a `warning` is shown but allowed.
 */
export function checkCapabilities(d: EngineDescriptor, job: JobSpec, mode: EngineMode): ValidationIssue[] {
  const c = d.caps;
  const out: ValidationIssue[] = [];
  const err = (field: string, message: string) => out.push({ field, severity: 'error', message });
  const warn = (field: string, message: string) => out.push({ field, severity: 'warning', message });
  /** A feature Volt provides downstream only exists while our packager sees the segments. */
  const usable = (v: boolean | 'volt' | 'vendor') => v === true || v === 'vendor' || (v === 'volt' && mode === 'encode_only');

  if (!c.modes.includes(mode)) err('engine.mode', `${d.name} does not support ${mode.replace('_', ' ')} mode.`);

  if (job.workflow === 'transcode' && !c.transcodeLadder) err('workflow', `${d.name} cannot build an ABR ladder from a mezzanine.`);
  if (job.workflow === 'package_only' && !c.packageOnly) err('workflow', `${d.name} cannot take a ready-made ladder; use a transcode profile.`);

  const ladder: Array<{ height?: number }> = Array.isArray(job.ladder) ? job.ladder : [];
  if (c.maxRenditions && ladder.length > c.maxRenditions) err('ladder', `${d.name} supports at most ${c.maxRenditions} renditions (profile has ${ladder.length}).`);
  const top = Math.max(0, ...ladder.map((r) => Number(r.height) || 0));
  if (c.maxHeight && top > c.maxHeight) err('ladder', `${d.name} tops out at ${c.maxHeight}p (profile asks for ${top}p).`);
  if (job.gpu && !c.gpu) warn('gpu', `${d.name} chooses its own encode hardware; the GPU setting is ignored.`);

  if (job.drm && !usable(c.drm)) err('drm', `DRM is not available on ${d.name} in ${mode.replace('_', ' ')} mode.`);
  if (job.captions?.enabled && !usable(c.captions)) err('captions', `Live captions are not available on ${d.name} in ${mode.replace('_', ' ')} mode.`);
  if (job.redundancy?.input_failover && !usable(c.inputFailover)) err('redundancy', `Input failover is not available on ${d.name}.`);
  if (job.redundancy && job.redundancy.input_loss_behavior && job.redundancy.input_loss_behavior !== 'none' && !usable(c.slateOnInputLoss)) {
    err('redundancy', `Slate or loop on input loss is not available on ${d.name} in this mode.`);
  }
  if (job.watermark && !usable(c.burnInOverlay)) err('watermark', `Burned-in watermark is not available on ${d.name}.`);
  if (job.watermark && mode === 'encode_only' && c.burnInOverlay === 'vendor') {
    warn('watermark', `The watermark is burned in by ${d.name}, so its placement follows the vendor's overlay rules.`);
  }

  if (mode === 'full') {
    for (const [k, label] of [['recording', 'Recordings and DVR'], ['clipping', 'Clipping'], ['geoSlate', 'Geo slate replacement'], ['thumbnails', 'Thumbnails']] as const) {
      if (!usable(c[k])) warn(k, `${label} will not be available: ${d.name} packages and originates the stream itself.`);
    }
  }
  if (mode === 'encode_only' && c.returnPaths.length === 0) err('engine.mode', `${d.name} has no way to return renditions to Volt.`);
  return out;
}

/** Generic caps check plus the engine's own vendor checks. */
export function validateForEngine(engineId: string, job: JobSpec, mode?: EngineMode): ValidationIssue[] {
  const d = describeEngine(engineId);
  if (!d) return [{ field: 'engine', severity: 'error', message: `Unknown encode engine "${engineId}".` }];
  const m = mode ?? d.defaultMode;
  const issues = checkCapabilities(d, job, m);
  const e = getEngine(engineId);
  if (!e) issues.push({ field: 'engine', severity: 'error', message: `${d.name} is planned but not installed on this deployment.` });
  else issues.push(...e.validate(job, m));
  return issues;
}
