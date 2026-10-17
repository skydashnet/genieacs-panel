import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ROLE,
  OPERATOR_ROLES,
  PERMISSIONS,
  ROLE_LABEL_KEYS,
  ROLE_SUMMARY_KEYS,
  normalizeRole,
  roleHas,
  type OperatorRole,
  type Permission
} from '@/lib/permissions'

/**
 * `lib/permissions.ts` opens by saying it is a mirror of the backend's matrix
 * and that diverging from it is a bug. Until this file existed, nothing checked
 * that — and the way it fails is the quiet way: the screen hides a button the
 * person is allowed to press, or offers one whose request comes back 403.
 * Neither shows up as an error anywhere, so the drift lives until somebody
 * complains.
 *
 * The backend module is reached through a computed path so TypeScript treats it
 * as a dynamic import. The alternative would be turning on `allowJs` for the
 * whole frontend to type one file that is not part of the frontend.
 */
const backendUrl = new URL('../../backend/src/config/permissions.js', import.meta.url).href

interface BackendPermissions {
  ROLES: readonly string[]
  DEFAULT_ROLE: string
  PERMISSIONS: readonly string[]
  permissionsOf(role: string): ReadonlySet<string>
  normalizeRole(role: unknown): string
  orphanPermissions(): readonly string[]
}

const backend = (await import(/* @vite-ignore */ backendUrl)) as BackendPermissions

describe('the permission matrix mirrors the backend', () => {
  it('knows the same roles, in the same order of power', () => {
    expect([...OPERATOR_ROLES]).toEqual([...backend.ROLES])
    expect(DEFAULT_ROLE).toBe(backend.DEFAULT_ROLE)
  })

  it('knows the same capabilities', () => {
    expect([...PERMISSIONS].sort()).toEqual([...backend.PERMISSIONS].sort())
  })

  /**
   * The one that matters. A capability that moved role on one side and not the
   * other is exactly the drift the file's own comment warns about, and it is
   * invisible until someone is denied something the screen offered them.
   */
  it('grants every role exactly what the backend grants it', () => {
    for (const role of OPERATOR_ROLES) {
      const here = PERMISSIONS.filter((permission) => roleHas(role, permission)).sort()
      const there = [...backend.permissionsOf(role)].sort()
      expect(here, `role "${role}" diverges from the backend`).toEqual(there)
    }
  })

  it('leaves no capability that no role can reach', () => {
    // An orphan is a route nobody opens, the provider's owner included.
    expect([...backend.orphanPermissions()]).toEqual([])
    const reachable = PERMISSIONS.filter(
      (permission) => OPERATOR_ROLES.some((role) => roleHas(role, permission))
    )
    expect(reachable.sort()).toEqual([...PERMISSIONS].sort())
  })
})

describe('a role the screen does not recognise', () => {
  /**
   * Both sides read an unknown role as `viewer`. An old account still carrying
   * `'user'`, or a role the backend starts emitting before this copy catches
   * up, must not read as "no restrictions".
   */
  it('reads as viewer, exactly as the backend reads it', () => {
    for (const role of ['user', 'superadmin', '', '   ', 'OWNER', 'Admin']) {
      expect(normalizeRole(role), role).toBe(backend.normalizeRole(role))
    }
  })

  it('accepts the roles it does know, whatever the casing', () => {
    expect(normalizeRole('OWNER')).toBe('owner')
    expect(normalizeRole('  tech  ')).toBe('tech')
  })

  it('falls back to viewer when there is no role at all', () => {
    expect(normalizeRole(undefined)).toBe('viewer')
    expect(normalizeRole(null)).toBe('viewer')
  })
})

describe('asking whether a role may do something', () => {
  /**
   * Absent role answers false rather than falling back to `viewer`'s reading
   * list: nobody signed in is not the same as somebody who may only look, and
   * the screen errs by hiding.
   */
  it('answers false when there is no role, without falling through to viewer', () => {
    expect(roleHas(undefined, 'devices.list')).toBe(false)
    expect(roleHas(null, 'devices.list')).toBe(false)
    expect(roleHas('viewer', 'devices.list')).toBe(true)
  })

  it('answers false for a capability nobody declared', () => {
    // Cast because the whole point is a name outside the union — a typo in a
    // route guard reaching this function at runtime.
    expect(roleHas('owner', 'devices.explode' as Permission)).toBe(false)
  })

  it('keeps the roles nested: what a viewer may do, an owner may do', () => {
    const may = (role: OperatorRole) => new Set(PERMISSIONS.filter((p) => roleHas(role, p)))
    const viewer = may('viewer')
    const tech = may('tech')
    const admin = may('admin')
    const owner = may('owner')

    expect([...viewer].every((p) => tech.has(p))).toBe(true)
    expect([...tech].every((p) => admin.has(p))).toBe(true)
    expect([...admin].sort()).toEqual([...owner].sort())
  })

  /**
   * `owner` and `admin` reach the same routes on purpose: what separates them
   * is who may change whose role, and that rule lives in the backend's operator
   * controller. If they ever diverge here, the copy has drifted.
   */
  it('gives owner and admin the same reach', () => {
    for (const permission of PERMISSIONS) {
      expect(roleHas('owner', permission), permission).toBe(roleHas('admin', permission))
    }
  })
})

describe('the role picker can describe every role it offers', () => {
  /**
   * A selector that offers a role without saying what it reaches is the screen
   * asking the person to guess what they are handing over.
   */
  it('has a label and a summary for each', () => {
    for (const role of OPERATOR_ROLES) {
      expect(ROLE_LABEL_KEYS[role], `${role} has no label key`).toBeTruthy()
      expect(ROLE_SUMMARY_KEYS[role], `${role} has no summary key`).toBeTruthy()
    }
    expect(Object.keys(ROLE_LABEL_KEYS).sort()).toEqual([...OPERATOR_ROLES].sort())
    expect(Object.keys(ROLE_SUMMARY_KEYS).sort()).toEqual([...OPERATOR_ROLES].sort())
  })
})
