/* eslint-disable no-console */
import * as ts from 'typescript'
import * as path from 'path'
import * as fs from 'fs'
import {DependencyGraph, CliOptions} from './types'

export class DependencyAnalyzer {
  private graph: DependencyGraph = {}
  private options: CliOptions
  private sourceFile: ts.SourceFile | null = null
  declare program: ts.Program
  declare host: ts.CompilerHost

  constructor(options: CliOptions) {
    this.options = options
  }

  analyze(): DependencyGraph {
    const files = this.getSourceFiles()

    if (this.options.verbose) {
      console.log(`Analyzing ${files.length} files...`)
    }

    const opt = {
      target          : ts.ScriptTarget.Latest,
      module          : ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs         : true,
      noResolve       : false,
      noEmit          : true,
    }

    const filePaths = [] as string[]

    function createCustomHost(options: ts.CompilerOptions): ts.CompilerHost {
      // 1. Create the default host
      const host = ts.createCompilerHost(options, true)

      // 2. Cache the module resolution cache if you want performance (optional but recommended)
      const moduleResolutionCache = ts.createModuleResolutionCache(
        host.getCurrentDirectory(),
        (s) => host.getCanonicalFileName(s),
        options
      )

      // 3. Override resolveModuleNameLiterals
      host.resolveModuleNameLiterals = (
        moduleLiterals,
        containingFile,
        redirectedReference,
        options,
        containingSourceFile,
        reusedNames
      ) => {
        return moduleLiterals.map((moduleLiteral) => {
          const moduleName = moduleLiteral.text

          // --- YOUR CUSTOM RESOLUTION LOGIC HERE ---
          // Example: Intercepting a specific virtual module
          if (moduleName === '@my-custom-alias/core') {
            return {
              resolvedModule: {
                resolvedFileName       : '/absolute/path/to/virtual/core.ts',
                extension              : ts.Extension.Ts,
                isExternalLibraryImport: false,
              },
            }
          }

          // --- FALLBACK TO DEFAULT RESOLUTION ---
          // Use ts.resolveModuleName to let TS handle the heavy lifting (node_modules, paths, etc.)
          const result = ts.resolveModuleName(
            moduleName,
            containingFile,
            options,
            host,
            moduleResolutionCache,
            redirectedReference
          )

          const spath = result.resolvedModule?.resolvedFileName
          if (spath) {
            filePaths.push(spath)
          }
          return {
            resolvedModule: result.resolvedModule,
          }
        })
      }

      return host
    }
    const host = createCustomHost(opt)
    this.host = host
    const program = ts.createProgram(files, opt, host)
    program.getTypeChecker()
    this.program = program
    const result = program.emit()

    const ignored = [
      //
      /\.*node_modules\.*/,
    ]

    const skip = (s: string) => ignored.some((r) => s.search(r) !== -1)

    console.log(result?.diagnostics)

    const filePathsToScan = Array.from(new Set(filePaths)).filter((f) => this.shouldIncludeFile(f))
    let i = 0
    for (const sourcePath of filePathsToScan) {
      const sourceFile = program.getSourceFile(sourcePath)

      if (sourceFile && !sourceFile.isDeclarationFile) {
        console.log(++i, 'of', filePathsToScan.length, sourcePath)
        this.analyzeFile(sourceFile, sourcePath, program)
      }
    }

    return this.graph
  }

  private getSourceFiles(): string[] {
    return [path.resolve(this.options.dir)]
  }

  private shouldExclude(filePath: string): boolean {
    const normalized = path.normalize(filePath)

    for (const pattern of this.options.exclude) {
      if (normalized.includes(pattern)) {
        return true
      }
    }

    return false
  }

  private shouldIncludeFile(filePath: string): boolean {
    if (filePath.search(/node_modules/) !== -1) {
      return false
    }
    if (this.shouldExclude(filePath)) {
      return false
    }

    const ext = path.extname(filePath)
    const validExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']

    if (!validExtensions.includes(ext)) {
      return false
    }

    if (this.options.include.length > 0) {
      const normalized = path.normalize(filePath)
      return this.options.include.some((pattern) => {
        if (pattern.includes('*')) {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'))
          return regex.test(normalized)
        }
        return normalized.includes(pattern)
      })
    }

    return true
  }

  normPath(pathin: string) {
    return pathin
  }

  private analyzeFile(sourceFile: ts.SourceFile, sourcePath, program: ts.Program) {
    this.sourceFile = sourceFile
    const filePath = sourcePath

    if (!this.graph[filePath]) {
      this.graph[filePath] = new Set<string>()
    }

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        this.processImport(node, filePath, program)
      } else if (ts.isExportDeclaration(node)) {
        this.processExport(node, filePath, program)
      } else if (ts.isCallExpression(node)) {
        this.processRequire(node, filePath, program)
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  private getModPath(node: ts.StringLiteral, filePath: string, program: ts.Program): string | undefined {
    const res = this.host.resolveModuleNameLiterals!(
      [node],
      filePath,
      undefined,
      program.getCompilerOptions(),
      this.sourceFile!,
      undefined
    )[0]?.resolvedModule?.resolvedFileName
    return res
  }

  private processImport(node: ts.ImportDeclaration, filePath: string, program: ts.Program) {
    if (node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
      return
    }
    if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const mpath = this.getModPath(node.moduleSpecifier, filePath, program)
      if (mpath) {
        this.addDependency(filePath, mpath, program)
      }
    }
  }

  private processExport(node: ts.ExportDeclaration, filePath: string, program: ts.Program) {
    if (node.isTypeOnly) {
      return
    }

    if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const exportPath = this.normPath(node.moduleSpecifier.text)
      this.addDependency(filePath, exportPath, program)
    }
  }

  private processRequire(node: ts.CallExpression, filePath: string, program: ts.Program) {
    if (node.expression.kind === ts.SyntaxKind.Identifier) {
      const identifier = node.expression as ts.Identifier
      if (identifier.text === 'require' && node.arguments.length > 0) {
        const arg = node.arguments[0]
        if (ts.isStringLiteral(arg)) {
          this.addDependency(filePath, arg.text, program)
        }
      }
    }
  }

  private addDependency(fromFile: string, importPath: string, program: ts.Program) {
    if (this.shouldIncludeFile(importPath)) {
      this.graph[fromFile].add(importPath)
    }
  }

  private resolveImportPath(fromFile: string, importPath: string): string | null {
    const dir = path.dirname(fromFile)
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']

    const resolved = path.resolve(dir, importPath)

    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved)
      if (stat.isFile()) {
        return path.normalize(resolved)
      } else if (stat.isDirectory()) {
        const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx']
        for (const indexFile of indexFiles) {
          const indexPath = path.join(resolved, indexFile)
          if (fs.existsSync(indexPath)) {
            return path.normalize(indexPath)
          }
        }
      }
    }

    for (const ext of extensions) {
      const withExt = resolved + ext
      if (fs.existsSync(withExt)) {
        return path.normalize(withExt)
      }
    }

    return null
  }

  getGraph(): DependencyGraph {
    return this.graph
  }
}
