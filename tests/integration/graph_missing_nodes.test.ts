/**
 * Seam coverage for "preserve unknown graph nodes & sockets across
 * (de)serialization" (documentation/plans/fixGraphMissingNodes.md).
 *
 * The real placeholder wiring lives in scripts/core/graph.ts (MissingNode /
 * MissingNodeSocket) + scripts/core/missing_addon.ts (the onUnknownClass /
 * onSerializeUnknown hooks, applyMissingAddonHooks, registerMissingStructGlobally,
 * reinjectGraphGetters). Those modules transitively import path.ux, which the
 * jsdom/swc harness can't transform (see node_editor_ops.test.ts / isect_frustum
 * test) — so they can't be imported here. Instead this drives the *same*
 * nstructjs engine the app bundles (the `nstructjs` workspace package =
 * vendor/nstructjs) directly, reproducing the exact load/save seam the plan
 * fixes, with stand-in base/sub classes that mirror graph.Node /
 * graph.NodeSocketType (inlineRegister-flattened subclass schemas,
 * `array(e,int) | e.graph_id` getters, abstract-typed refs).
 *
 * It guards three claims the plan/code depend on:
 *   1. `parse_structs` auto-registers a *dummy* class for every unknown struct.
 *      The vendor engine flags that dummy (isParseStructsDummy) and the read
 *      path treats a flagged dummy as unknown whenever an onUnknownClass hook is
 *      installed — so the hook fires with NO app-side scrub needed.
 *   2. Reading an unknown class through an abstract field then routes to the
 *      placeholder, walks the *file* schema (data preserved) and stamps
 *      `_origClsname`; onSerializeUnknown re-emits under it.
 *   3. `write_scripts(include_code=false)` strips the `| getter` transforms, so
 *      the save path packs object-valued fields (`edges`) as raw objects where
 *      ints are expected — reinjecting the base getter onto the registered
 *      schema restores correct object→int packing (reinjectGraphGetters).
 */

import fs from 'node:fs'
import Path from 'node:path'
import * as nstructjs from 'nstructjs'
import {REPO_ROOT} from './nwjs_boot'
import {isDefaultBackendPass} from './split'

type AnyManager = any

// Engine marker for a parse_structs-synthesized dummy (struct_util.ts).
const PARSE_STRUCTS_DUMMY = Symbol.for('nstructjs.parseStructsDummy')

// ── stand-in base classes (mirror graph.NodeSocketType / graph.Node) ──────────

class Sock {
  graph_id = -1
  node: any = undefined
  edges: any[] = []
  name = ''
  socketName = ''
  socketType = 0
  _value = 0

  loadSTRUCT(reader: (o: this) => void): void {
    reader(this)
  }

  static STRUCT = `
Sock {
  graph_id   : int;
  node       : int | this.node !== undefined ? this.node : -1;
  edges      : array(e, int) | e.graph_id;
  name       : string;
  socketName : string;
  socketType : int;
}`
}

// Unknown socket subclass (simulates an unloaded addon's socket).
class SubSock extends Sock {
  extra = 0
  static STRUCT = `SubSock {\n  extra : int;\n}`
}

// A holder with an abstract(Sock) field so reads dispatch through the
// tstruct/abstract path — the path that stamps `_origClsname` (mirrors how a
// graph stores nodes/sockets via abstract types).
class Holder {
  sock: Sock = new Sock()
  loadSTRUCT(reader: (o: this) => void): void {
    reader(this)
  }
  static STRUCT = `Holder {\n  sock : abstract(Sock);\n}`
}

/** Build a fully-populated manager (the "addon loaded" saver). */
function makeFullManager(): AnyManager {
  const m = new (nstructjs as any).STRUCT()
  m.inlineRegister(Sock, Sock.STRUCT)
  m.inlineRegister(SubSock, SubSock.STRUCT)
  m.register(Holder)
  return m
}

// No NW.js boot, so no backend: runs once, in the wasm pass (see ./split).
const describeOnce = isDefaultBackendPass() ? describe : describe.skip

describeOnce('unknown graph node/socket preservation seam', () => {
  test('parse_structs flags its dummy so onUnknownClass can fire without scrubbing', () => {
    const full = makeFullManager()
    const src = new SubSock()
    src.graph_id = 5
    src.extra = 42
    const data: number[] = []
    full.write_object(data, src)
    const schema = (nstructjs as any).write_scripts(full, false)

    // istruct: only Sock is "loaded"; SubSock is unknown.
    const istruct = new (nstructjs as any).STRUCT()
    istruct.inlineRegister(Sock, Sock.STRUCT)
    istruct.parse_structs(schema, istruct)

    // parse_structs registered a dummy for the unknown SubSock...
    expect('SubSock' in istruct.struct_cls).toBe(true)
    // ...and flagged it, so the engine can route it through onUnknownClass.
    expect((istruct.struct_cls['SubSock'] as any)[PARSE_STRUCTS_DUMMY]).toBe(true)
    // Real (registered) classes are NOT flagged.
    expect((istruct.struct_cls['Sock'] as any)[PARSE_STRUCTS_DUMMY]).toBeUndefined()
  })

  test('read routes to placeholder, preserves data + _origClsname (no scrub)', () => {
    const full = makeFullManager()
    const holder = new Holder()
    const sub = new SubSock()
    sub.graph_id = 7
    sub.extra = 99
    sub.name = 'mysock'
    holder.sock = sub

    const data: number[] = []
    full.write_object(data, holder)
    const schema = (nstructjs as any).write_scripts(full, false)

    const istruct = new (nstructjs as any).STRUCT()
    istruct.inlineRegister(Sock, Sock.STRUCT)
    istruct.register(Holder)
    istruct.parse_structs(schema, istruct)

    let hookName = ''
    istruct.onUnknownClass = (name: string) => {
      hookName = name
      return Sock // stand-in placeholder (base provides getValue/edges)
    }
    istruct.onSerializeUnknown = (o: any) => o?._origClsname || undefined

    // No scrubDummies() — the engine treats the flagged dummy as unknown because
    // an onUnknownClass hook is installed.
    const back: any = istruct.readObject(new Uint8Array(data), Holder)

    expect(hookName).toBe('SubSock')
    expect(back.sock).toBeInstanceOf(Sock)
    expect(back.sock._origClsname).toBe('SubSock') // stamped by abstract-field read
    expect(back.sock.graph_id).toBe(7) // base field preserved via file schema
    expect(back.sock.extra).toBe(99) // subclass-only field preserved too
    expect(back.sock.name).toBe('mysock')
  })

  test('without a hook, a flagged dummy still reads into the dummy (legacy behavior)', () => {
    const full = makeFullManager()
    const src = new SubSock()
    src.graph_id = 13
    src.extra = 1
    const data: number[] = []
    full.write_object(data, src)
    const schema = (nstructjs as any).write_scripts(full, false)

    const istruct = new (nstructjs as any).STRUCT()
    istruct.inlineRegister(Sock, Sock.STRUCT)
    istruct.parse_structs(schema, istruct)
    // No onUnknownClass installed → dummy is used as before, no throw.
    const back: any = istruct.readObject(new Uint8Array(data), istruct.struct_cls['SubSock'])
    expect(back.graph_id).toBe(13)
    expect(back.extra).toBe(1)
  })

  test('getter reinjection restores object→int packing for stripped edges', () => {
    // A live socket holds Sock OBJECTS in `edges`; the base getter `e.graph_id`
    // is what turns them into ints at save time. write_scripts strips it, so a
    // re-registered file schema must have the getter copied back from the base.
    const full = makeFullManager()
    const s = new SubSock()
    s.graph_id = 3
    s.edges = [{graph_id: 9}, {graph_id: 11}] // object-valued, like live links
    const data: number[] = []
    full.write_object(data, s)
    const schema = (nstructjs as any).write_scripts(full, false)

    // Re-register the (stripped) SubSock file schema into a fresh manager that
    // also has the base Sock (with getters). Then reinject edges getter.
    const reload = new (nstructjs as any).STRUCT()
    reload.inlineRegister(Sock, Sock.STRUCT)
    reload.parse_structs(schema, reload)

    const subSchema = reload.structs['SubSock']
    const edgesField = subSchema.fields.find((f: any) => f.name === 'edges')

    // After stripping, the getter is gone but the iter-var 'e' survives.
    expect(edgesField.type.data.iname).toBe('e')
    expect(edgesField.get).toBeUndefined()

    // Reinject from a manager whose base Sock schema is UNSTRIPPED — the real
    // reinjectGraphGetters copies from the global manager, never the per-file
    // istruct (whose base schema parse_structs just overwrote with the stripped
    // version). reload.structs['Sock'] is stripped here, so use a fresh source.
    const baseProvider = makeFullManager()
    const baseEdges = baseProvider.structs['Sock'].fields.find((f: any) => f.name === 'edges')
    expect(baseEdges.get).toBe('e.graph_id')
    edgesField.get = baseEdges.get
    expect(edgesField.get).toBe('e.graph_id')

    // Now packing the live object reads the ints back out correctly.
    const reread: any = reload.readObject(new Uint8Array(data), reload.struct_cls['SubSock'])
    reread.edges = reread.edges.map((id: number) => ({graph_id: id})) // relink to objects
    const data2: number[] = []
    reload.write_object(data2, reread)

    const finalMgr = makeFullManager()
    finalMgr.parse_structs((nstructjs as any).write_scripts(reload, false), finalMgr)
    const final: any = finalMgr.readObject(new Uint8Array(data2), SubSock)
    expect(final.edges).toEqual([9, 11]) // ints survived the object→int→object trip
    expect(final.graph_id).toBe(3)
  })
})

/**
 * The stand-ins above are a fixture, and a fixture that drifts from what it
 * stands in for passes while proving nothing (P10 step 8). `graph.ts` cannot be
 * imported here, so pin the two declarations that carry the seam against its
 * source text: `edges`'s int-packing transform is the whole subject of the
 * getter-reinjection test, and `node` is what makes the abstract dispatch fire.
 */
describeOnce('the stand-ins still mirror the real graph structs', () => {
  const GRAPH_TS = fs.readFileSync(Path.join(REPO_ROOT, 'scripts', 'core', 'graph.ts'), 'utf8')

  const socketStruct = () => {
    const start = GRAPH_TS.indexOf('graph.NodeSocketType {')
    expect(start).toBeGreaterThan(-1)
    return GRAPH_TS.slice(start, GRAPH_TS.indexOf('}', start))
  }

  test('NodeSocketType still declares every field Sock stands in for', () => {
    const declared = socketStruct()
      .split(/\r?\n/)
      .map((l) => l.trim().split(':')[0].trim())

    for (const field of ['graph_id', 'node', 'edges', 'name', 'socketName', 'socketType']) {
      expect([field, declared.includes(field)]).toEqual([field, true])
    }
  })

  test('edges is still an int-packed array, which is what the reinjection test fixes', () => {
    expect(socketStruct()).toMatch(/edges\s*:\s*array\(e,\s*int\)\s*\|\s*e\.graph_id;/)
  })

  test('node is still packed as an int through a transform', () => {
    expect(socketStruct()).toMatch(/node\s*:\s*int\s*\|/)
  })
})
