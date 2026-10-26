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
export * from './triggers';
export {
  StatsPanel, attachStats, bindDebugMenu, combineProbes, mediaProbe, hlsJsProbe, dashJsProbe,
  statsRows, statsReport, codecName, splitCodecs, redactUrl, optimalFor, SDK_VERSION,
} from './stats';
export type { StatsSample, StatsProbe, StatsRow, AttachedStats } from './stats';
export { PlayAttempt, CmcdSender, cmcdEventLine, cmcdRequestUrl, newSid } from './cmcd';
export { VoltJourney, ga4Forward, parseEntry } from './journey';
export type { JourneyOptions, JourneyEvent, JourneyForward, EntryKind, ScreenType, RouteMap } from './journey';
