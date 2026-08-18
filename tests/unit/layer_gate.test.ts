/**
 * The layer gate is what P9 converted from advisory warnings into a merge gate, so
 * it needs a test that does not depend on the live module graph: a canned cruise
 * result with a known violation must fail, and the same result must pass once the
 * violation is gone. Feeds tools/layer-gate.mjs directly — the real cruise is far
 * too slow, and its counts move every phase.
 */

import {evaluate, tally} from '../../tools/layer-gate.mjs'

interface Violation {
  rule: {name: string; severity: string}
  from: string
  to: string
}

const RULE_NAMES = ['core-no-mesh', 'core-no-addons', 'no-circular']
const SEVERITIES = {'core-no-mesh': 'error', 'core-no-addons': 'error', 'no-circular': 'warn'}

function cruiseResult(violations: Violation[]) {
  return {summary: {violations}}
}

function violation(rule: string, severity: string, from: string, to: string): Violation {
  return {rule: {name: rule, severity}, from, to}
}

describe('tally', () => {
  test('seeds every configured rule with its declared severity', () => {
    const rules = tally(cruiseResult([]), RULE_NAMES, SEVERITIES)

    expect([...rules.keys()]).toEqual(RULE_NAMES)
    expect(rules.get('core-no-mesh')).toMatchObject({count: 0, severity: 'error'})
    expect(rules.get('no-circular')).toMatchObject({count: 0, severity: 'warn'})
  })

  test('counts violations per rule and keeps the offending edges', () => {
    const rules = tally(
      cruiseResult([
        violation('no-circular', 'warn', 'scripts/a.ts', 'scripts/b.ts'),
        violation('no-circular', 'warn', 'scripts/b.ts', 'scripts/a.ts'),
      ]),
      RULE_NAMES,
      SEVERITIES
    )

    expect(rules.get('no-circular').count).toBe(2)
    expect(rules.get('no-circular').violations[0].to).toBe('scripts/b.ts')
  })

  test('a rule absent from the config still gets counted rather than dropped', () => {
    const rules = tally(cruiseResult([violation('brand-new-rule', 'error', 'a', 'b')]), RULE_NAMES, SEVERITIES)

    expect(rules.get('brand-new-rule')).toMatchObject({count: 1, severity: 'error'})
  })
})

describe('evaluate', () => {
  const baseline = {total: 10, rules: {'core-no-mesh': 0, 'core-no-addons': 0, 'no-circular': 5}}

  test('passes when nothing fires and every count is within budget', () => {
    const rules = tally(cruiseResult([]), RULE_NAMES, SEVERITIES)

    expect(evaluate(rules, {baseline, warnCount: 0})).toEqual([])
  })

  test('a single error-severity violation fails the gate', () => {
    const rules = tally(
      cruiseResult([violation('core-no-mesh', 'error', 'scripts/core/context.ts', 'addons/builtin/mesh/src/mesh.ts')]),
      RULE_NAMES,
      SEVERITIES
    )

    const failures = evaluate(rules, {baseline, warnCount: 0})

    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/^core-no-mesh: 1 violation\(s\) at severity error$/)
  })

  test('an error-severity rule fails even when its budget would allow it', () => {
    const rules = tally(
      cruiseResult([violation('core-no-addons', 'error', 'scripts/core/a.ts', 'addons/b.ts')]),
      RULE_NAMES,
      SEVERITIES
    )

    const failures = evaluate(rules, {baseline: {total: 99, rules: {'core-no-addons': 50}}, warnCount: 0})

    expect(failures).toEqual(['core-no-addons: 1 violation(s) at severity error'])
  })

  test('a warn rule over its per-rule budget fails, and the delta is reported', () => {
    const warns = Array.from({length: 7}, (_unused, i) => violation('no-circular', 'warn', `a${i}.ts`, `b${i}.ts`))
    const rules = tally(cruiseResult(warns), RULE_NAMES, SEVERITIES)

    expect(evaluate(rules, {baseline, warnCount: 7})).toEqual(['no-circular: 7 > budget 5 (+2)'])
  })

  test('a warn rule at or under budget passes -- the ratchet is not a moving target', () => {
    const warns = Array.from({length: 5}, (_unused, i) => violation('no-circular', 'warn', `a${i}.ts`, `b${i}.ts`))
    const rules = tally(cruiseResult(warns), RULE_NAMES, SEVERITIES)

    expect(evaluate(rules, {baseline, warnCount: 5})).toEqual([])
  })

  test('the total-warning budget is checked independently of the per-rule ones', () => {
    const rules = tally(cruiseResult([]), RULE_NAMES, SEVERITIES)

    expect(evaluate(rules, {baseline, warnCount: 11})).toEqual(['total warnings: 11 > budget 10 (+1)'])
  })

  test('--max-warnings overrides the baseline total', () => {
    const rules = tally(cruiseResult([]), RULE_NAMES, SEVERITIES)

    expect(evaluate(rules, {baseline, maxWarnings: 20, warnCount: 11})).toEqual([])
  })

  test('with no baseline only error severity can fail', () => {
    const warns = Array.from({length: 99}, (_unused, i) => violation('no-circular', 'warn', `a${i}.ts`, `b${i}.ts`))
    const rules = tally(cruiseResult(warns), RULE_NAMES, SEVERITIES)

    expect(evaluate(rules, {warnCount: 99})).toEqual([])
  })
})
