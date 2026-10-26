// ============================================================================
//  REFRAME FORMATS AND SETTINGS (volt/REFRAME.md).
//
//  The three social shapes Volt makes from a wider picture, and the account's
//  choices about them. PURE; the settings row is read and written by
//  services/reframe/store.ts and modules/reframe.ts.
// ============================================================================
import { z } from 'zod';

export const FORMATS = {
  '9x16': { key: '9x16', label: '9:16 vertical', ratio: '9:16', width: 1080, height: 1920, aspect: 9 / 16,
    for: 'TikTok, YouTube Shorts, Instagram Reels and Stories, Facebook Reels' },
  '1x1': { key: '1x1', label: '1:1 square', ratio: '1:1', width: 1080, height: 1080, aspect: 1,
    for: 'Facebook, X and LinkedIn feeds' },
  '4x5': { key: '4x5', label: '4:5 portrait', ratio: '4:5', width: 1080, height: 1350, aspect: 4 / 5,
    for: 'Instagram and Facebook feeds' },
} as const;

export type FormatKey = keyof typeof FORMATS;
export const FORMAT_KEYS: FormatKey[] = ['9x16', '1x1', '4x5'];
export const isFormatKey = (v: unknown): v is FormatKey => typeof v === 'string' && (FORMAT_KEYS as string[]).includes(v);

/** What a platform receives: the source framing, or one of the made formats. */
export type TargetFormat = FormatKey | '16x9';
export const TARGET_FORMATS: TargetFormat[] = ['16x9', ...FORMAT_KEYS];

/** The platforms a publication can go to (publish_platform), less the portal. */
export const SOCIAL_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'dailymotion'] as const;

export type Follow = 'faces' | 'people' | 'centre';

export interface ReframeSettings {
  /** Which formats are made for every analysed asset. */
  formats: Record<FormatKey, boolean>;
  /** What to keep in frame, first found in a shot wins. */
  priority: Follow[];
  /** steady: still inside a shot unless the subject would leave; responsive: follows closely; locked: one framing per shot. */
  movement: 'steady' | 'responsive' | 'locked';
  /** When the subjects of a shot cannot all fit: show the whole picture over a blurred fill, or follow the main one. */
  fallback: 'fill' | 'follow';
  /** 9:16 only: keep the subject left of the right-hand buttons the platforms draw. */
  safeArea: boolean;
  /** Analyse every new asset with video (cheap: tracking only). */
  autoAnalyse: boolean;
  /** A platform mapped to a format gets that format when published to, rendered then if needed. Off by default. */
  renderOnPublish: boolean;
  /** A format must be approved by a person before it is published. */
  requireApproval: boolean;
  /** Approve automatically when every shot's framing confidence is at least this (null: never). */
  autoApproveAbove: number | null;
  /** The format each platform receives. */
  targets: Record<string, TargetFormat>;
}

export const DEFAULT_SETTINGS: ReframeSettings = {
  formats: { '9x16': true, '1x1': true, '4x5': true },
  priority: ['faces', 'people', 'centre'],
  movement: 'steady',
  fallback: 'fill',
  safeArea: true,
  autoAnalyse: true,
  // OFF until an admin turns it on: it changes which file every mapped platform
  // receives, and an account that never looked at formats must publish as before.
  renderOnPublish: false,
  requireApproval: true,
  autoApproveAbove: null,
  targets: { youtube: '16x9', tiktok: '9x16', instagram: '9x16', facebook: '1x1', x: '1x1', dailymotion: '16x9' },
};

const followEnum = z.enum(['faces', 'people', 'centre']);
const targetEnum = z.enum(['16x9', '9x16', '1x1', '4x5']);

/** A partial update: anything left out keeps its current value. */
export const settingsPatch = z.object({
  formats: z.object({ '9x16': z.boolean(), '1x1': z.boolean(), '4x5': z.boolean() }).partial().optional(),
  priority: z.array(followEnum).min(1).max(3).optional()
    .refine((a) => !a || new Set(a).size === a.length, 'each item may appear once'),
  movement: z.enum(['steady', 'responsive', 'locked']).optional(),
  fallback: z.enum(['fill', 'follow']).optional(),
  safeArea: z.boolean().optional(),
  autoAnalyse: z.boolean().optional(),
  renderOnPublish: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  autoApproveAbove: z.number().min(0.5).max(1).nullable().optional(),
  targets: z.record(z.enum(SOCIAL_PLATFORMS), targetEnum).optional(),
}).strict();

/** Stored JSON (possibly old or partial) to a complete, valid settings object. */
export function resolveSettings(stored: unknown): ReframeSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, any>;
  const out: ReframeSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (s.formats && typeof s.formats === 'object') for (const k of FORMAT_KEYS) if (typeof s.formats[k] === 'boolean') out.formats[k] = s.formats[k];
  if (Array.isArray(s.priority)) {
    const p = s.priority.filter((x: unknown): x is Follow => followEnum.safeParse(x).success);
    if (p.length) out.priority = [...new Set(p)];
  }
  if (['steady', 'responsive', 'locked'].includes(s.movement)) out.movement = s.movement;
  if (['fill', 'follow'].includes(s.fallback)) out.fallback = s.fallback;
  for (const k of ['safeArea', 'autoAnalyse', 'renderOnPublish', 'requireApproval'] as const) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (s.autoApproveAbove === null || (typeof s.autoApproveAbove === 'number' && s.autoApproveAbove >= 0.5 && s.autoApproveAbove <= 1)) out.autoApproveAbove = s.autoApproveAbove;
  if (s.targets && typeof s.targets === 'object') {
    for (const [k, v] of Object.entries(s.targets)) if ((SOCIAL_PLATFORMS as readonly string[]).includes(k) && targetEnum.safeParse(v).success) out.targets[k] = v as TargetFormat;
  }
  return out;
}

/** Apply a validated patch to the current settings. */
export function applyPatch(cur: ReframeSettings, patch: z.infer<typeof settingsPatch>): ReframeSettings {
  const next: ReframeSettings = JSON.parse(JSON.stringify(cur));
  if (patch.formats) Object.assign(next.formats, patch.formats);
  if (patch.priority) next.priority = patch.priority;
  for (const k of ['movement', 'fallback', 'safeArea', 'autoAnalyse', 'renderOnPublish', 'requireApproval', 'autoApproveAbove'] as const) {
    if (patch[k] !== undefined) (next as any)[k] = patch[k];
  }
  if (patch.targets) Object.assign(next.targets, patch.targets);
  return resolveSettings(next);
}
