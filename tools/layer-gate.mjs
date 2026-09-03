/**
 * The pure decision half of tools/check-layers.js: turn a dependency-cruiser result
 * plus a ratchet baseline into a list of failures.
 *
 * Split out from check-layers.js so it can be unit-tested against canned cruise JSON
 * — the gate is what P9 promoted to `error`, and a gate nothing exercises is a gate
 * that can rot silently. check-layers.js keeps the I/O (cruise, argv, reporting).
 *
 * See documentation/plans/2026-08-15-0340-w1-layer-ratchet.md §5.
 */

/** Severities that fail the run outright, regardless of any budget. */
export const EXIT_SEVERITIES = new Set(['error'])

/** @typedef {{rule: {name: string, severity: string}, from: string, to: string}} Violation */

/**
 * rule name -> {severity, count, violations}, seeded with every configured rule so a
 * rule that starts firing is a budget overrun rather than an unnoticed new key.
 *
 * @param {{summary: {violations: Violation[]}}} cruiseResult
 * @param {string[]} ruleNames
 * @param {Record<string, string>} [ruleSeverities] name -> severity from the config,
 *   so a rule that fired zero times still reports the severity it was declared with.
 */
export function tally(cruiseResult, ruleNames, ruleSeverities = {}) {
  const rules = new Map(
    ruleNames.map((name) => [
      name,
      {
        count     : 0,
        severity  : ruleSeverities[name] ?? 'warn',
        violations: /** @type {Violation[]} */ ([]),
      },
    ])
  )

  for (const violation of cruiseResult.summary.violations) {
    const name = violation.rule.name
    if (!rules.has(name)) {
      rules.set(name, {count: 0, severity: violation.rule.severity, violations: []})
    }
    const entry = rules.get(name)
    entry.count++
    entry.severity = violation.rule.severity
    entry.violations.push(violation)
  }

  return rules
}

/**
 * @param {Map<string, {count: number, severity: string}>} rules
 * @param {{baseline?: {total?: number, rules?: Record<string, number>} | null,
 *          maxWarnings?: number | null, warnCount?: number}} [options]
 *   `warnCount` is the cruise summary's total warn count, checked against the overall
 *   budget separately from the per-rule ones.
 * @returns {string[]} human-readable failure lines; empty means the gate passes.
 */
export function evaluate(rules, {baseline = null, maxWarnings = null, warnCount = 0} = {}) {
  const failures = []

  for (const [name, entry] of rules) {
    if (EXIT_SEVERITIES.has(entry.severity) && entry.count > 0) {
      failures.push(`${name}: ${entry.count} violation(s) at severity ${entry.severity}`)
      continue
    }

    const budget = baseline?.rules?.[name]
    if (budget !== undefined && entry.count > budget) {
      failures.push(`${name}: ${entry.count} > budget ${budget} (+${entry.count - budget})`)
    }
  }

  const totalBudget = maxWarnings ?? baseline?.total
  if (totalBudget !== undefined && totalBudget !== null && warnCount > totalBudget) {
    failures.push(`total warnings: ${warnCount} > budget ${totalBudget} (+${warnCount - totalBudget})`)
  }

  return failures
}
