/* eslint-disable no-console */
import * as path from 'path'
import {Cycle, CliOptions} from './types'

export class CLI {
  formatCycles(cycles: Cycle[], baseDir: string, verbose: boolean): string {
    if (cycles.length === 0) {
      return '✓ No circular dependencies found!'
    }

    const lines: string[] = []
    lines.push(`\n❌ Found ${cycles.length} circular ${cycles.length === 1 ? 'dependency' : 'dependencies'}:\n`)

    for (let i = 0; i < cycles.length; i++) {
      const cycle = cycles[i]
      lines.push(`Cycle ${i + 1}:`)

      const relativePaths = cycle.files.map((f) => this.getRelativePath(f, baseDir))

      for (let j = 0; j < relativePaths.length; j++) {
        const isLast = j === relativePaths.length - 1
        const arrow = isLast ? ' → (back to start)' : ' →'
        lines.push(`  ${relativePaths[j]}${arrow}`)
      }

      lines.push('')
    }

    return lines.join('\n')
  }

  private getRelativePath(filePath: string, baseDir: string): string {
    const relative = path.relative(baseDir, filePath)
    return relative || filePath
  }

  printSummary(fileCount: number, cycleCount: number) {
    console.log(`\nAnalyzed ${fileCount} files`)
    console.log(`Found ${cycleCount} circular ${cycleCount === 1 ? 'dependency' : 'dependencies'}`)
  }

  parseOptions(args: string[]): CliOptions {
    const options: CliOptions = {
      dir    : process.cwd(),
      exclude: ['node_modules', 'dist', 'build', '.git'],
      include: [],
      verbose: false,
    }

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '--dir' || arg === '-d') {
        options.dir = args[++i]
      } else if (arg === '--exclude' || arg === '-e') {
        const excludePatterns = args[++i].split(',')
        options.exclude.push(...excludePatterns)
      } else if (arg === '--include' || arg === '-i') {
        const includePatterns = args[++i].split(',')
        options.include.push(...includePatterns)
      } else if (arg === '--verbose' || arg === '-v') {
        options.verbose = true
      } else if (!arg.startsWith('-')) {
        options.dir = arg
      }
    }

    return options
  }
}
