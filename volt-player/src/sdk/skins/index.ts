// ============================================================================
//  SKIN REGISTRY.
//
//  The built-in skins, plus any a client registers:
//
//    VoltPlayer.registerSkin('acme', () => ({ mount(ctx) {…}, update(state) {…} }))
//
//  and then `skin: 'acme'`. An unknown name renders the default video skin
//  rather than a blank box (a config saved by a newer console must still play).
//
//  The names a saved player config may hold (player_configs.layout) are
//  checked against this registry and the migration by test/player-layouts.check.ts.
//  `admin` is the console's own and is never saved in a config.
// ============================================================================
import type { SkinFactory } from '../types';
import { videoSkin } from './video';
import { eventSkin } from './event';
import { adminSkin } from './admin';
import { audioNowPlayingSkin, audioSquareSkin, audioWaveSkin } from './audio';

const SKINS: Record<string, SkinFactory> = {
  video: videoSkin,
  event: eventSkin,
  audio_square: audioSquareSkin,
  audio_wave: audioWaveSkin,
  audio_nowplaying: audioNowPlayingSkin,
  admin: adminSkin,
};

export const BUILT_IN_SKINS = ['video', 'event', 'audio_square', 'audio_wave', 'audio_nowplaying', 'admin'] as const;

export function getSkin(name: string): SkinFactory {
  return SKINS[name] ?? SKINS.video;
}

export function registerSkin(name: string, factory: SkinFactory): void {
  if (!/^[a-z][a-z0-9_-]{1,40}$/.test(name)) throw new Error('volt-player: a skin name is 2-41 lowercase letters, digits, - or _');
  if ((BUILT_IN_SKINS as readonly string[]).includes(name)) throw new Error(`volt-player: "${name}" is a built-in skin`);
  SKINS[name] = factory;
}

export function skinNames(): string[] { return Object.keys(SKINS); }

export function isSdkSkin(name: string | null | undefined): boolean { return !!name && name in SKINS; }
