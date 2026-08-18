/**
 * `addons/builtin/leafmesh/src/leafmesh.ts` casts between the leafmesh and host
 * vocabularies rather than converting: `Domain` and `ElementDomain` are the
 * same numbers, and so are the two `AttrType`s. TS enums are nominal, so that
 * agreement cannot be asserted at compile time — this suite is where it is
 * pinned instead. A renumbering on either side lands here, not in a silently
 * mis-addressed attribute column.
 */

import {AttrType, DOMAIN_COUNT, Domain} from '../../../addons/builtin/leafmesh/src/attrs'
import {AttrType as HostAttrType, ElementDomain} from '../../../scripts/core/geometry_contract'

describe('leafmesh / host vocabulary agreement', () => {
  test('Domain matches ElementDomain', () => {
    expect(Domain.VERT).toBe(ElementDomain.VERT as number)
    expect(Domain.EDGE).toBe(ElementDomain.EDGE as number)
    expect(Domain.CORNER).toBe(ElementDomain.CORNER as number)
    expect(Domain.LOOP).toBe(ElementDomain.LOOP as number)
    expect(Domain.FACE).toBe(ElementDomain.FACE as number)
  })

  test('every host domain is a leafmesh domain', () => {
    const hostValues = Object.values(ElementDomain).filter(v => typeof v === 'number') as number[]

    expect(hostValues.length).toBe(DOMAIN_COUNT)
    for (const v of hostValues) {
      expect(Domain[v]).toBeDefined()
    }
  })

  test('AttrType matches the host AttrType', () => {
    const names = Object.keys(HostAttrType).filter(k => isNaN(Number(k)))

    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const mine = (AttrType as unknown as Record<string, number | undefined>)[name]

      expect([name, mine]).toEqual([name, (HostAttrType as unknown as Record<string, number>)[name]])
    }
  })
})
