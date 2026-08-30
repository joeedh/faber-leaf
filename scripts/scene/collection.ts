import {nstructjs, util} from '../path.ux/scripts/pathux.js'

import {BlockFlags, BlockLoader, BlockLoaderAddUser, DataBlock, DataRef} from '../core/lib_api'
import {SceneObject} from '../sceneobject/sceneobject'
import {IntSocket} from '../core/graphsockets'
import {INodeSocketSet} from '../core/graph.js'
import {StructReader} from '../path.ux/scripts/util/nstructjs.js'

//sceneobjet collection
export enum CollectFlags {
  SELECT = 1,
  INTERNAL = 2,
}

export class Collection<InputSet extends INodeSocketSet = {}, OutputSet extends INodeSocketSet = {}> extends DataBlock<
  InputSet & {},
  OutputSet & {
    onObjectAdd: IntSocket
    onObjectRem: IntSocket
    onChildAdd: IntSocket
    onChildRem: IntSocket
  }
> {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
Collection {
  parent     : DataRef | DataRef.fromBlock(obj);
  children   : array(e, DataRef) | DataRef.fromBlock(e);
  objects    : array(e, DataRef) | DataRef.fromBlock(e);
  memo       : string;
  flag       : int;  
}
  `
  )

  name: string
  parent?: Collection = undefined
  children: Collection[] = [] //child collections
  objects: SceneObject[] = []
  memo = ''

  flag = 0

  object_idmap: {[key: number]: SceneObject} = {}
  child_idmap: {[key: number]: Collection} = {}

  constructor(name: string = 'Collection') {
    super()

    this.name = name
  }

  static nodedef() {
    return {
      name   : 'collection',
      uiname : 'collection',
      inputs : {},
      outputs: {
        onObjectAdd: new IntSocket(),
        onObjectRem: new IntSocket(),
        onChildAdd : new IntSocket(),
        onChildRem : new IntSocket(),
      },
    }
  }

  get flatChildren(): Iterable<Collection> {
    const this2 = this

    return (function* () {
      const stack = [] as Collection[]
      const visit = new util.set<Collection>()

      for (const c of this2.children) {
        stack.push(c)
      }

      while (stack.length > 0) {
        const c = stack.pop()!

        yield c

        visit.add(c)

        for (const c2 of c.children) {
          if (!visit.has(c2)) {
            stack.push(c2)
          }
        }
      }
    })()
  }

  add(ob_or_collection: SceneObject | Collection): boolean {
    if (ob_or_collection instanceof Collection) {
      const cl = ob_or_collection

      if (cl.lib_id in this.child_idmap) {
        // eslint-disable-next-line no-console
        console.warn('Tried to add same collection twice')
        return false
      }

      let ok = true

      const rec = (cl2: Collection, test: Collection) => {
        if (cl2 === test) {
          ok = false
          return
        }
        for (const cl3 of cl2.children) {
          rec(cl3, test)
        }
      }

      for (const cl2 of cl.children) {
        rec(cl2, this)
        rec(this, cl2)
      }

      if (!ok) {
        // eslint-disable-next-line no-console
        console.warn('Loop in collections')
        return false
      }

      this.children.push(cl)
      cl.parent = this

      this.child_idmap[cl.lib_id] = cl
      cl.lib_addUser(this)

      this.outputs.onChildAdd.value = cl.lib_id
      this.outputs.onChildAdd.immediateUpdate()

      return true
    } else if (ob_or_collection instanceof SceneObject) {
      const ob = ob_or_collection

      if (ob.lib_id in this.object_idmap) {
        // eslint-disable-next-line no-console
        console.warn('Tried to add same object to collection twice')
        return false
      }

      this.objects.push(ob)
      this.object_idmap[ob.lib_id] = ob
      ob.lib_addUser(this)

      this.outputs.onObjectAdd.value = ob.lib_id
      this.outputs.onObjectAdd.immediateUpdate()

      return true
    }

    throw new Error('invalid value passed to Collection.prototype.add: ' + ob_or_collection)
  }

  getChild(name: string) {
    for (const child of this.children) {
      if (child.name === name) {
        return child
      }
    }
  }

  remove(ob_or_collection: SceneObject | Collection): boolean {
    if (ob_or_collection instanceof Collection) {
      const cl = ob_or_collection

      if (cl.lib_id in this.child_idmap) {
        delete this.child_idmap[cl.lib_id]
        this.children.remove(cl)
        cl.lib_remUser(this)

        this.outputs.onChildRem.value = cl.lib_id
        this.outputs.onChildRem.immediateUpdate()

        return true
      } else {
        // eslint-disable-next-line no-console
        console.warn('Child not part of collection', cl, this)
        return false
      }
    } else if (ob_or_collection instanceof SceneObject) {
      const ob = ob_or_collection

      if (ob.lib_id in this.object_idmap) {
        delete this.object_idmap[ob.lib_id]
        this.objects.remove(ob)
        ob.lib_remUser(this)

        this.outputs.onObjectRem.value = ob.lib_id
        this.outputs.onObjectRem.immediateUpdate()

        return true
      } else {
        // eslint-disable-next-line no-console
        console.warn('object not in collection:', ob, this)
        return false
      }
    }

    throw new Error('invald call to Collection.remove: ' + ob_or_collection)
  }

  dataLink(getblock: BlockLoader, getblock_us: BlockLoaderAddUser): void {
    this.parent = getblock_us(this.parent as unknown as DataRef, this) as Collection | undefined

    for (let i = 0; i < this.objects.length; i++) {
      this.objects[i] = getblock_us(this.objects[i], this) as SceneObject
      this.object_idmap[this.objects[i].lib_id] = this.objects[i]
    }

    for (let i = 0; i < this.children.length; i++) {
      this.children[i] = getblock_us(this.children[i], this) as Collection
      this.child_idmap[this.children[i].lib_id] = this.children[i]
    }
  }

  has(ob_or_collection: SceneObject | Collection): boolean {
    if (ob_or_collection instanceof Collection) {
      return ob_or_collection.lib_id in this.child_idmap
    } else {
      return ob_or_collection.lib_id in this.object_idmap
    }
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)
    super.loadSTRUCT(reader)
  }

  static blockDefine() {
    return {
      typeName   : 'collection',
      defaultName: 'Collection',
      uiName     : 'Collection',
      flag       : BlockFlags.FAKE_USER, //always have user count > 0
      icon       : -1,
    }
  }
}

DataBlock.register(Collection)
