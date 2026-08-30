import {DependencyGraph, Cycle} from './types'

export class CycleDetector {
  private graph: DependencyGraph
  private visited: Set<string> = new Set()
  private recursionStack: Set<string> = new Set()
  private cycles: Cycle[] = []
  private cycleSet: Set<string> = new Set()

  constructor(graph: DependencyGraph) {
    this.graph = graph
  }

  detectCycles(): Cycle[] {
    this.cycles = []
    this.visited = new Set()
    this.recursionStack = new Set()
    this.cycleSet = new Set()

    for (const node of Object.keys(this.graph)) {
      if (!this.visited.has(node)) {
        this.dfs(node, [])
      }
    }

    return this.cycles
  }

  private dfs(node: string, path: string[]) {
    this.visited.add(node)
    this.recursionStack.add(node)
    path.push(node)

    const neighbors = this.graph[node] || new Set()

    for (const neighbor of neighbors) {
      if (!this.visited.has(neighbor)) {
        this.dfs(neighbor, path)
      } else if (this.recursionStack.has(neighbor)) {
        const cycleStartIndex = path.indexOf(neighbor)
        if (cycleStartIndex !== -1) {
          const cycle = path.slice(cycleStartIndex)
          cycle.push(neighbor)
          this.addCycle(cycle)
        }
      }
    }

    path.pop()
    this.recursionStack.delete(node)
  }

  private addCycle(files: string[]) {
    const normalized = this.normalizeCycle(files)
    const key = normalized.join('|')

    if (!this.cycleSet.has(key)) {
      this.cycleSet.add(key)
      this.cycles.push({files: normalized})
    }
  }

  private normalizeCycle(files: string[]): string[] {
    if (files.length === 0) {
      return files
    }

    let minIndex = 0
    for (let i = 1; i < files.length; i++) {
      if (files[i] < files[minIndex]) {
        minIndex = i
      }
    }

    const normalized: string[] = []
    for (let i = 0; i < files.length; i++) {
      normalized.push(files[(minIndex + i) % files.length])
    }

    return normalized
  }
}
