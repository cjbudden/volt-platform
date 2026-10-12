// ============================================================================
//  ENGINES — registration point.
//
//  To add a vendor: write services/engines/vendors/<id>.ts implementing
//  EncodeEngine, then register it below behind its own config switch so a
//  deployment without the vendor's credentials never offers it. Step by step
//  in volt/ENGINES.md.
// ============================================================================
import { registerEngine, getEngine } from './registry';
import { builtinEngine } from './builtin';

let registered = false;

export function registerEngines(): void {
  if (registered) return;
  registered = true;
  if (!getEngine('builtin')) registerEngine(builtinEngine);

  // Vendor adapters go here, each gated on its own configuration, e.g.
  //   if (process.env.MEDIALIVE_ROLE_ARN) registerEngine(makeMediaLiveEngine());
  //   if (process.env.BITMOVIN_API_KEY)   registerEngine(makeBitmovinEngine());
  //   if (process.env.WOWZA_API_URL)      registerEngine(makeWowzaEngine());
}

export * from './types';
export { listEngines, describeEngine, getEngine, validateForEngine, checkCapabilities } from './registry';
export { withEngines, ENGINE_ARN_PREFIX } from './launcher';
