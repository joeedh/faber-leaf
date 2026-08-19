/**
 * P17 §4: a distribution's addon list is data, and a third party will write it
 * in whatever order reads well. So the resulting state must be a function of
 * the *set*, not of the order — this walks all 120 permutations of a five-addon
 * distribution and asserts every one produces byte-identical state.
 *
 * Both modules under test are deliberate zero-import leaves, which is what lets
 * this be a unit test at all: `addon.ts` itself pulls path.ux and the shader
 * stack in at module load (see tests/unit/addon_registries.test.ts).
 *
 * The fixture is not a straight line — it carries an optional dependency, a
 * diamond, and an addon whose required dependency is absent — because a shuffle
 * test over a trivially-ordered set proves nothing.
 */

import {
  bundled,
  defineDistribution,
  external,
  activeDefaultScene,
  distributionEnabled,
  getActiveDistribution,
  isInDistribution,
  setActiveDistribution,
  type DistributionAddon,
} from '../../scripts/addon/distribution'
import {resolveManifests, type IAddonManifest} from '../../scripts/addon/manifest'

function manifest(over: Partial<IAddonManifest> & {id: string}): IAddonManifest {
  return {
    name        : over.id,
    version     : '1.0.0',
    entry       : 'src/main.ts',
    dependencies: [],
    buildMode   : 'prebuilt',
    ...over,
  }
}

const MANIFESTS = [
  manifest({id: 'base'}),
  manifest({id: 'geom', dependencies: ['base']}),
  manifest({id: 'overlay', dependencies: ['base']}),
  manifest({id: 'tools', dependencies: ['geom'], optionalDependencies: ['overlay']}),
  manifest({id: 'orphan', dependencies: ['absent_by_design']}),
]

/** The distribution entry each id contributes, mixing both authoring forms. */
const ENTRIES: Record<string, DistributionAddon> = {
  base   : bundled(MANIFESTS[0], {register: () => {}}),
  geom   : bundled(MANIFESTS[1], {register: () => {}}, {enabled: true}),
  overlay: external('overlay', {enabled: false}),
  tools  : external('tools'),
  orphan : external('orphan', {enabled: true}),
}

const IDS = Object.keys(ENTRIES).sort()

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) {
    return [items]
  }
  const out: T[][] = []
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of permutations(rest)) {
      out.push([items[i], ...tail])
    }
  }
  return out
}

/** Everything an order could plausibly perturb, in one comparable value. */
function snapshot(order: string[]) {
  setActiveDistribution(
    defineDistribution({
      id          : 'shuffle-fixture',
      title       : 'Shuffle Fixture',
      addons      : order.map((id) => ENTRIES[id]),
      defaultScene: 'fixture-scene',
    })
  )

  const byId = new Map(MANIFESTS.map((m) => [m.id, m]))
  const {loaded, disabled} = resolveManifests(order.map((id) => byId.get(id)!))

  return {
    // Distribution state, read the way the addon manager reads it.
    allowed     : IDS.map((id) => [id, isInDistribution(id)] as const),
    enabled     : IDS.map((id) => [id, distributionEnabled(id)] as const),
    defaultScene: activeDefaultScene(),
    title       : getActiveDistribution()?.title ?? null,
    // Resolver state, for the same set in the same order.
    loaded      : loaded.map((m) => m.id),
    disabled    : disabled.map((d) => `${d.id}:${d.reason}:${d.dependency ?? ''}`),
  }
}

afterEach(() => {
  setActiveDistribution(null)
})

describe('a distribution is order-independent', () => {
  const orders = permutations(IDS)

  test('the fixture exercises all 120 orders', () => {
    expect(orders).toHaveLength(120)
  })

  test('every order produces identical state', () => {
    const first = snapshot(orders[0])
    for (const order of orders) {
      expect(snapshot(order)).toEqual(first)
    }
  })

  test('and that state is the right one, not merely a stable one', () => {
    const s = snapshot(IDS)

    // Dependencies precede dependents; the optional one orders too.
    expect(s.loaded).toEqual(['base', 'geom', 'overlay', 'tools'])
    // A required dependency nobody ships disables just that addon.
    expect(s.disabled).toEqual(['orphan:missing-dep:absent_by_design'])

    expect(s.allowed).toEqual([
      ['base', true],
      ['geom', true],
      ['orphan', true],
      ['overlay', true],
      ['tools', true],
    ])
    // `external(id)` with no opts leaves the manifest's own default alone.
    expect(s.enabled).toEqual([
      ['base', undefined],
      ['geom', true],
      ['orphan', true],
      ['overlay', false],
      ['tools', undefined],
    ])
    expect(s.defaultScene).toBe('fixture-scene')
  })
})

describe('the allow-list is the set, not the order', () => {
  test('an id the distribution omits is out however the rest are ordered', () => {
    for (const order of permutations(['base', 'geom', 'tools'])) {
      setActiveDistribution(
        defineDistribution({
          id    : 'partial',
          title : 'Partial',
          addons: order.map((id) => ENTRIES[id]),
        })
      )
      expect(isInDistribution('overlay')).toBe(false)
      expect(isInDistribution('orphan')).toBe(false)
      expect(isInDistribution('base')).toBe(true)
      expect(activeDefaultScene()).toBeNull()
    }
  })

  test('with no distribution active every id is allowed', () => {
    setActiveDistribution(null)
    expect(isInDistribution('anything-at-all')).toBe(true)
    expect(distributionEnabled('anything-at-all')).toBeUndefined()
    expect(activeDefaultScene()).toBeNull()
  })
})
