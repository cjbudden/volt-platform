// ============================================================================
//  GROUP CAPACITY: why "Create" is or is not available, in words.
//
//  A group's max_channels counts TV channels AND radio stations together, so a
//  group holding 2 TV channels can be full because of 8 stations. Every place
//  that offers "New channel" / "New station" uses these so the button is
//  disabled with the reason on screen, never disabled silently, and never
//  enabled only to fail with a 409.
// ============================================================================
import type { Group, PlanView } from '../api'

export const isFull = (g: Group) => g.channel_count >= g.max_channels

/** "2 TV channels and 8 radio stations" */
export function occupants(g: Group): string {
  const radio = g.radio_count ?? 0
  const tv = g.channel_count - radio
  const parts = [`${tv} TV channel${tv === 1 ? '' : 's'}`]
  if (radio) parts.push(`${radio} radio station${radio === 1 ? '' : 's'}`)
  return parts.join(' and ')
}

/** Option label for a group picker: "RTM Main: 10 of 10 (full)". */
export function groupLabel(g: Group): string {
  return `${g.name}: ${g.channel_count} of ${g.max_channels}${isFull(g) ? ' (full)' : ''}`
}

/** Why a group cannot take another channel or station, or null when it can. */
export function fullReason(g: Group): string | null {
  if (!isFull(g)) return null
  return `${g.name} is full: it is given ${g.max_channels} channels and stations of the plan and has ${occupants(g)}. ` +
    'Remove one, choose another group, or give this group a bigger share (Admin, Channel groups).'
}

/**
 * Why nothing new can be created in these groups, or null when at least one
 * has room. `what` is "channel" or "station".
 */
export function noRoomReason(groups: Group[], what: 'channel' | 'station'): string | null {
  if (!groups.length) return `This account has no group for a ${what} yet. An account administrator adds one under Channel groups.`
  if (groups.some(g => !isFull(g))) return null
  if (groups.length === 1) return fullReason(groups[0])
  return `Every group is full (${groups.map(g => `${g.name} ${g.channel_count}/${g.max_channels}`).join(', ')}). ` +
    `Remove a channel or station, or ask for a higher limit, to add a ${what}.`
}

/** The group to start with: the one asked for, else the first with room. */
export function pickGroup(groups: Group[], wanted?: string): Group | undefined {
  return groups.find(g => g.id === wanted)
    ?? groups.find(g => g.is_default && !isFull(g))
    ?? groups.find(g => !isFull(g)) ?? groups[0]
}

/** Why the ACCOUNT's plan has no room for another channel or station, or null. */
export function planFullReason(plan: PlanView | null | undefined, what: 'channel' | 'station'): string | null {
  if (!plan || plan.used.total < plan.maxChannels) return null
  return `Your plan allows ${plan.maxChannels} channels and stations together and all are in use ` +
    `(${plan.used.tv} TV, ${plan.used.radio} radio). Remove one, or raise the plan (Admin, Plan & limits), to add a ${what}.`
}
