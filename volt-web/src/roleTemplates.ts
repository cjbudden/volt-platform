// ============================================================================
//  ROLE TEMPLATES: starting points for a custom role (Users & Roles > New role).
//
//  A template only fills the form: the role is a normal custom role the
//  account owns and can change. Levels above the creator's own access are
//  lowered to what they hold (nobody can give more than they have).
//  docs/PERMISSIONS_MAP.md lists them.
// ============================================================================
import type { AccessLevel } from './api'

export interface RoleTemplate {
  key: string; name: string; description: string
  tier: 'operator' | 'viewer'
  permissions: Record<string, AccessLevel>
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'epg_admin', name: 'EPG Administrator', tier: 'operator',
    description: 'Creates and edits programme guides, enters programmes and runs XMLTV import and export feeds. Picks guide icons from the image library (any signed-in user can browse it for pickers).',
    permissions: { epg: 'manage' },
  },
  {
    key: 'channel_operator', name: 'Channel Operator', tier: 'operator',
    description: 'Runs channels, stations and events (start and stop, on and off air) and watches monitoring. Cannot create or change them.',
    permissions: { monitoring: 'view', channels: 'operate', radio: 'operate', events: 'operate', epg: 'view', recordings: 'view' },
  },
  {
    key: 'clip_editor', name: 'Clip Editor', tier: 'operator',
    description: 'Makes clips from recordings, publishes them and shares preview links.',
    permissions: { monitoring: 'view', recordings: 'manage', vod: 'operate', media: 'view', sharing: 'manage', epg: 'view' },
  },
  {
    key: 'media_librarian', name: 'Media Librarian', tier: 'operator',
    description: 'Looks after the media and image library: uploads, folders, metadata, publishing and withdrawing.',
    permissions: { media: 'manage', vod: 'manage', recordings: 'view', sharing: 'manage' },
  },
  {
    key: 'support_desk', name: 'Viewer Support', tier: 'operator',
    description: 'Helps the audience: finds public users, signs them out everywhere, sees analytics.',
    permissions: { viewers: 'operate', analytics: 'view', monitoring: 'view' },
  },
]
