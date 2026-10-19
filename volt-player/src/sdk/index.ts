// The SDK's public surface, for the bundle (window.VoltPlayer) and for the
// console, which imports it as source.
export { VoltPlayer, initialState } from './player';
export { registerSkin, getSkin, skinNames, isSdkSkin, BUILT_IN_SKINS } from './skins';
export { resolveTheme, applyTheme, themeVars, themeFromConfig, inkFor, contrast, DEFAULT_THEME, DEFAULT_CONTROLS } from './theme';
export { STRINGS } from './strings';
export { eventIcs, splitCountdown } from './skins/event';
export { fmtPrice, fmtTerm, fillUrl } from './resolver';
export * as kit from './skins/kit';
export * from './schedule';
export type * from './types';
