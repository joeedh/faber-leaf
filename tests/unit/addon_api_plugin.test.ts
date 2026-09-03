/**
 * Tests parseExportNames from tools/addon_api_plugin.js. The full plugin
 * runs through esbuild in tests/integration/addon_api_resolver.test.ts —
 * this file just covers the parser's pattern matching. Step 12 follow-up #2.
 */

import {parseExportNames} from '../../tools/addon_api_plugin.js'

describe('parseExportNames', () => {
  test('named re-exports are returned', () => {
    expect(parseExportNames(`export {A, B, C} from './x.js'`).sort()).toEqual(['A', 'B', 'C'])
  })

  test('type-only re-exports are filtered out', () => {
    const src = `
      export {A} from './x.js'
      export type {B} from './y.js'
    `
    expect(parseExportNames(src)).toEqual(['A'])
  })

  test('per-item type aliasing inside a brace is filtered', () => {
    const src = `export {A, type B, C as D} from './x.js'`
    expect(parseExportNames(src).sort()).toEqual(['A', 'D'])
  })

  test('export * as ns is captured', () => {
    expect(parseExportNames(`export * as utils from './u.js'`)).toEqual(['utils'])
  })

  test('export const/let/var', () => {
    const src = `
      export const A = 1
      export let B = 2
      export var C = 3
    `
    expect(parseExportNames(src).sort()).toEqual(['A', 'B', 'C'])
  })

  test('export function / class / enum / abstract class', () => {
    const src = `
      export function foo() {}
      export class Bar {}
      export enum Baz {}
      export abstract class Qux {}
    `
    expect(parseExportNames(src).sort()).toEqual(['Bar', 'Baz', 'Qux', 'foo'])
  })

  test('plain local export braces (no from)', () => {
    const src = `
      const A = 1; const B = 2
      export {A, B}
    `
    // Note: this picks up A,B from both the brace AND from `const A/B`
    // declarations once they're exported via local braces. Here we only have
    // bare `const`, no `export const`, so the brace is the only source.
    expect(parseExportNames(src).sort()).toEqual(['A', 'B'])
  })

  test('handles the real mesh api.ts surface', () => {
    const src = `
      export {Mesh, MeshFlags, MeshTypes} from './mesh.js'
      export type {Vertex, Handle, Edge, Loop, LoopList, Face, Element} from './mesh_types.js'
      export {CustomDataElem, CustomData, AttrRef, CDFlags} from './customdata.js'
      export type {CDRef, ICustomDataElemConstructor, ICustomDataElemDef} from './customdata.js'
      export {CDElemArray, EmptyCDArray} from './mesh_base.js'
      export type {ICustomDataCapable} from './mesh_base.js'
      export {BVH, BVHFlags, BVHSettings, BVHTri} from './bvh.js'
      export type {IBVHCreateArgs, IBVHVertex} from './bvh.js'
      export * as mesh_utils from './mesh_utils.js'
      export * as customdata from './customdata.js'
    `
    const names = parseExportNames(src).sort()
    expect(names).toEqual([
      'AttrRef',
      'BVH',
      'BVHFlags',
      'BVHSettings',
      'BVHTri',
      'CDElemArray',
      'CDFlags',
      'CustomData',
      'CustomDataElem',
      'EmptyCDArray',
      'Mesh',
      'MeshFlags',
      'MeshTypes',
      'customdata',
      'mesh_utils',
    ])
    // Type-only names must NOT be present.
    expect(names).not.toContain('Vertex')
    expect(names).not.toContain('CDRef')
    expect(names).not.toContain('IBVHCreateArgs')
    expect(names).not.toContain('ICustomDataCapable')
  })

  test('block-commented exports are ignored', () => {
    const src = `
      /* export {Removed} from './x.js' */
      export {Kept} from './x.js'
    `
    expect(parseExportNames(src)).toEqual(['Kept'])
  })

  test('line-commented exports are ignored', () => {
    const src = `
      // export {Removed} from './x.js'
      export {Kept} from './x.js'
    `
    expect(parseExportNames(src)).toEqual(['Kept'])
  })
})
