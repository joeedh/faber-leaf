/**
 * The jest face of the `IUVSource` conformance suite — P18 §6.
 *
 * The rules themselves live in `scripts/core/uv_source_conformance.ts`, because
 * the LiteMesh and LeafMesh providers can only be reached from inside the
 * running app (an addon imports `@framework/api`, which jest does not resolve)
 * and so need a checker that does not need jest. This file exists so a source
 * that *is* reachable from here still reports one failure per rule rather than
 * one lump.
 */

import {checkUVSourceCase, uvConformanceCaseNames} from '../../scripts/core/uv_source_conformance'
import type {IUVSource} from '../../scripts/core/geometry_contract'

export {csrRow} from '../../scripts/core/uv_source_conformance'

export interface UVConformanceCase {
  /** A source with at least one UV layer and at least one face. */
  make(): IUVSource
}

export function runUVSourceConformance(name: string, testCase: UVConformanceCase): void {
  describe(`IUVSource conformance: ${name}`, () => {
    for (const caseName of uvConformanceCaseNames()) {
      test(caseName, () => {
        expect(checkUVSourceCase(caseName, () => testCase.make())).toBeNull()
      })
    }
  })
}
