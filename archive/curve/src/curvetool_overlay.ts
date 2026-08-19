import {ViewContext} from '@framework/api'
import {BlockLoader, BlockLoaderAddUser, DataRef} from '@framework/api'
import type {Mesh} from '../../mesh/src/mesh'
import type {SceneObject} from '@framework/api'

export class CurveToolOverlay extends ViewContext {
  _toolclass: any
  _selectMask: number = -1
  _ob: DataRef = new DataRef(-1)

  constructor(state: any, toolmode?: any) {
    super(state)

    if (toolmode !== undefined) {
      this._toolclass = toolmode.constructor
      this._selectMask = toolmode.selectMask

      toolmode._getObject()
      this._ob = DataRef.fromBlock(toolmode.sceneObject)
    }
  }

  get selectMask(): number {
    return super.toolmode!.selectMask
    //return this._selectMask;
  }

  validate(): boolean {
    return super.scene.toolmode instanceof this._toolclass
  }

  get selectedObjects(): any[] {
    return [this.object]
  }

  get selectedMeshObjects() {
    return [this.object!]
  }

  get mesh(): Mesh | undefined {
    const ob: any = this.datalib.get<SceneObject>(this._ob)

    if (ob !== undefined) {
      return ob.data as Mesh
    }
  }

  get object(): SceneObject | undefined {
    return this.datalib.get<SceneObject>(this._ob)
  }
}

window._CurveToolOverlay = CurveToolOverlay
