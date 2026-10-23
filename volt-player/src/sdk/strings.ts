// Every word a built-in skin shows, so a client can translate without forking
// a skin: pass `strings: { live: 'EN DIRECT', … }` to the player.
export const STRINGS: Record<string, string> = {
  play: 'Play', pause: 'Pause', replay: 'Play again',
  live: 'LIVE', goLive: 'Go live', behindLive: '{time} behind',
  startOver: 'Start over', startOverHint: 'Watch {title} from the beginning',
  back10: 'Back 10 seconds', fwd10: 'Forward 10 seconds',
  mute: 'Mute', unmute: 'Unmute', volume: 'Volume',
  quality: 'Quality', auto: 'Auto', autoNow: 'Auto ({q})',
  subtitles: 'Subtitles', off: 'Off', audio: 'Audio', speed: 'Speed', normal: 'Normal',
  fullscreen: 'Full screen', exitFullscreen: 'Exit full screen', pip: 'Picture in picture',
  cast: 'Cast to a TV', stopCasting: 'Stop casting', castingTo: 'Playing on {device}', airplay: 'AirPlay',
  upNext: 'Up next', skipIntro: 'Skip intro', skipRecap: 'Skip recap', skipCredits: 'Skip credits', skip: 'Skip', nextIn: 'Next in {time}', startsIn: 'Starts in {time}', playNow: 'Play now', cancel: 'Cancel',
  schedule: 'Schedule', playlist: 'Playlist', now: 'Now', next: 'Next', later: 'Later', onNow: 'On now',
  nowPlaying: 'Now playing', recentlyPlayed: 'Recently played', comingUp: 'Coming up',
  comingUpIn: 'Coming up in {time}', startsAt: 'Starts at {time}', dismiss: 'Dismiss', onAir: 'On air',
  timeLeft: '{time} left', nextAt: 'Next at {time}', laterToday: 'Later',
  offline: 'This is not on air right now.', stopped: 'The stream stopped unexpectedly.', retry: 'Try again',
  loading: 'Loading', previous: 'Previous', nextItem: 'Next',
  startsIn2: 'Starts in', days: 'days', hours: 'hrs', mins: 'min', secs: 'sec',
  addToCalendar: 'Add to calendar', postponed: 'Postponed', cancelled: 'Cancelled', newDateTba: 'A new date will be announced.',
  wasAt: 'Was {when}', nowAt: 'Now {when}', startingSoon: 'Starting soon', startingSoonText: 'The stream will play as soon as it begins.',
  ended: 'This event has ended', watchReplay: 'Watch the replay', replayHint: 'The full event, from the start.',
  buyTitle: 'Get access', buy: 'Buy', alreadyBought: 'Already bought? Check again', signInTitle: 'Sign in to watch', signIn: 'Sign in',
  regionBlocked: 'This event is not available in your region.', liveNow: 'Live now', backToEvent: 'Back to the event',
  stats: 'Stats', playbackStats: 'Playback stats', copyDebug: 'Copy debug info', resolution: 'Resolution', bitrate: 'Bitrate', buffer: 'Buffer', latency: 'Behind live',
};

export function format(s: string, v?: Record<string, string | number>): string {
  return v ? s.replace(/\{(\w+)\}/g, (_m, k) => (v[k] != null ? String(v[k]) : '')) : s;
}
