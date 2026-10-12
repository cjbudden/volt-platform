// The built-in engine: Volt's own FFmpeg + Shaka container.
//
// It is registered so it shows in the engine list and gets the same
// capability check as any vendor, but it is never driven through the
// provision/start/stop methods: EngineAwareLauncher short-circuits `builtin`
// straight to the TaskLauncher, exactly as the orchestrator did before engines
// existed. That is the "no behaviour change" guarantee.
import { BUILTIN } from './catalog';
import type { EncodeEngine } from './types';

const notDriven = () => {
  throw new Error('the builtin engine is launched by the TaskLauncher directly, not through the engine API');
};

export const builtinEngine: EncodeEngine = {
  descriptor: BUILTIN,
  validate: () => [],
  provision: async () => notDriven(),
  start: async () => notDriven(),
  stop: async () => notDriven(),
  isRunning: async () => notDriven(),
  normalize: () => [],
};
