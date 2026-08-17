/**
 * Registry of properties-editor panels, keyed by data kind.
 *
 * `PropsEditor` used to build the object-data tab by branching on concrete type
 * (`data instanceof ProceduralMesh`, `data.lib_type === 'mesh'`), which is the
 * pattern the host geometry contract exists to remove: a new geometry type
 * could not contribute UI without editing `scripts/`. A panel is contributed
 * through `AddonAPI.registerPropsPanel` instead, and disappears with its addon.
 *
 * `kindId` is a data kind (`dataDefine().dataKind`) or `'*'` for a panel that
 * applies to every kind. Panels are returned sorted by `(order, id)`; neither
 * registration order nor addon load order may be load-bearing.
 *
 * `Ctx` is the app context, left generic so this module does not import the
 * host it serves — the same rule `core/geometry_contract.ts` follows, and for
 * the same reason. `AddonAPI` binds it to the real `ToolContext`.
 */

import type {Container} from '../path.ux/scripts/pathux'
import type {GeometryDataRef} from './geometry_contract'

/** Matches any data kind. */
export const ANY_DATA_KIND = '*'

export interface IPropsPanel<Ctx = unknown> {
  /** Stable id, unique across all kinds. Also the de-dup key. */
  id: string

  /** Data kind this panel serves, or {@link ANY_DATA_KIND}. */
  kindId: string

  /** Panel label, when the host wraps the contribution in a titled panel. */
  uiName?: string

  /** Lower sorts first; defaults to 0. Ties break on `id`. */
  order?: number

  /**
   * Whether this panel applies to the given instance. Use it for state that the
   * kind alone cannot express (a modifier being present, say) — not to
   * re-derive the kind, which `kindId` already selected on.
   */
  poll?(ctx: Ctx, data: GeometryDataRef): boolean

  /** Add widgets to `container`. Called on rebuild, so it must be idempotent. */
  build(container: Container, ctx: Ctx, data: GeometryDataRef): void
}

const _panels = new Map<string, IPropsPanel>()

export function registerPropsPanel(panel: IPropsPanel): void {
  if (_panels.has(panel.id)) {
    throw new Error(`props panel "${panel.id}" is already registered`)
  }
  _panels.set(panel.id, panel)
}

export function unregisterPropsPanel(id: string): void {
  _panels.delete(id)
}

function byOrderThenId(a: IPropsPanel, b: IPropsPanel): number {
  const d = (a.order ?? 0) - (b.order ?? 0)
  return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function listPropsPanels(kindId?: string): IPropsPanel[] {
  const all = Array.from(_panels.values())
  const matching = kindId === undefined ? all : all.filter((p) => p.kindId === kindId || p.kindId === ANY_DATA_KIND)

  return matching.sort(byOrderThenId)
}

/** Test-only helper. */
export function _resetPropsPanelsForTests(): void {
  _panels.clear()
}
