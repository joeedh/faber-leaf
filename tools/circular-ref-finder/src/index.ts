#!/usr/bin/env node
/* eslint-disable no-console */

import {DependencyAnalyzer} from './analyzer'
import {CycleDetector} from './cycle-detector'
import {CLI} from './cli'

function main() {
  const cli = new CLI()
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    process.exit(0)
  }

  const options = cli.parseOptions(args)

  if (options.verbose) {
    console.log('Options:', options)
  }

  try {
    const analyzer = new DependencyAnalyzer(options)
    const graph = analyzer.analyze()

    const detector = new CycleDetector(graph)
    const cycles = detector.detectCycles()

    const output = cli.formatCycles(cycles, options.dir, options.verbose)
    console.log(output)

    cli.printSummary(Object.keys(graph).length, cycles.length)

    if (cycles.length > 0) {
      process.exit(1)
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function printHelp() {
  console.log(`
Circular Reference Finder - Detect circular import dependencies in TypeScript/JavaScript codebases

Usage:
  circular-ref-finder [directory] [options]

Options:
  -d, --dir <path>         Directory to analyze (default: current directory)
  -e, --exclude <patterns> Comma-separated patterns to exclude (default: node_modules,dist,build,.git)
  -i, --include <patterns> Comma-separated patterns to include (optional)
  -v, --verbose            Enable verbose output
  -h, --help               Show this help message

Examples:
  circular-ref-finder                    # Analyze current directory
  circular-ref-finder ./src              # Analyze src directory
  circular-ref-finder -e "test,*.spec.ts" # Exclude test files
  circular-ref-finder -v                 # Verbose output

Exit codes:
  0 - No circular dependencies found
  1 - Circular dependencies found or error occurred
`)
}

main()
