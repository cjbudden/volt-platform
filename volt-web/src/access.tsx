/* ============================================================================
   ACCESS IN THE CONSOLE. See ACCESS_CONTROL.md, "The admin interface".

   The API is the authority: every admin request is checked server side. The
   console mirrors the same rules so people are not offered things they will
   be refused. Everything here reads ONE map, `me.permissions` from
   GET /api/auth/me: feature -> none | view | operate | manage.

     view     the section is in the menu; lists and detail pages open
     operate  run controls show (start/stop, on/off air, auto connect, publish)
     manage   create / edit / delete controls show

   Hooks for a page:

     const { can } = useAccess()
     {can('radio', 'operate') && <button>Start</button>}
     <Can feature="radio" level="manage"><button>New station</button></Can>
     <Can feature="radio" level="manage" fallback={<span>Read only</span>}>…</Can>

   Radio stations are channels with kind 'radio': use featureForChannel(kind)
   to pick 'radio' or 'channels' for a channel row.

   Fail closed: until /auth/me answers nothing privileged is shown, and if it
   cannot be read the console behaves as if every feature were 'none'.
   ========================================================================== */
import { createContext, useContext, type ReactNode } from 'react'
import type { Me, AccessLevel } from './api'

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, operate: 2, manage: 3 }

export interface AccessApi {
  me: Me | null
  loaded: boolean
  /** True when the signed-in user holds at least `level` on `feature`. */
  can: (feature: string, level: AccessLevel) => boolean
  level: (feature: string) => AccessLevel
  /** Owner or admin tier: full access, and the only tiers that may mint account secret keys. */
  isAdminTier: boolean
}

export function makeAccess(me: Me | null, loaded: boolean): AccessApi {
  const map = me?.permissions ?? me?.features ?? {}
  const level = (f: string): AccessLevel => (me ? ((map[f] as AccessLevel) ?? 'none') : 'none')
  return {
    me, loaded,
    level,
    can: (f, l) => RANK[level(f)] >= RANK[l],
    isAdminTier: me?.role === 'admin' || me?.role === 'owner',
  }
}

const Ctx = createContext<AccessApi>(makeAccess(null, false))

export function AccessProvider({ value, children }: { value: AccessApi; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAccess(): AccessApi {
  return useContext(Ctx)
}

/** Render children only when the user holds `level` on `feature`. */
export function Can({ feature, level, fallback = null, children }: {
  feature: string; level: AccessLevel; fallback?: ReactNode; children: ReactNode
}) {
  const { can } = useAccess()
  return <>{can(feature, level) ? children : fallback}</>
}

/** The feature a channel row belongs to: radio stations are channels too. */
export const featureForChannel = (kind?: string | null) => (kind === 'radio' ? 'radio' : 'channels')

/** A small, consistent "read only" marker for pages a user can see but not change. */
export function ReadOnlyBadge({ feature }: { feature: string }) {
  const { can } = useAccess()
  if (can(feature, 'manage')) return null
  const op = can(feature, 'operate')
  return (
    <span className="tag type chan" title={op ? 'Your role lets you run this, not change its settings' : 'Your role lets you view this, not change or run it'}
      style={{ marginLeft: 8, fontSize: 'var(--fs-xs, 11px)' }}>
      {op ? 'Operate only' : 'View only'}
    </span>
  )
}
