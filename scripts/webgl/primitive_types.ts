/*
 * The vertex-attribute vocabulary: which primitive a draw batch holds and which
 * attribute layers its vertices carry.
 *
 * These live apart from simplemesh.ts, which owns them logically, because that
 * module pulls in the shader stack and the WebGPU queue — so importing it just
 * to name an enum drags all of that along, and closed a cycle through
 * render/queue_factory.ts. simplemesh.ts re-exports everything here.
 */

export enum PrimitiveTypes {
  NONE = 0,
  POINTS = 1,
  LINES = 2,
  TRIS = 4,
  ADVANCED_LINES = 8,
  ALL = 1 | 2 | 4 | 8,
}

export enum LayerTypes {
  LOC = 1,
  UV = 2,
  COLOR = 4,
  NORMAL = 8,
  ID = 16,
  CUSTOM = 32,
  INDEX = 64,
}

export const LayerTypeNames = {
  [LayerTypes.LOC]   : 'position',
  [LayerTypes.UV]    : 'uv',
  [LayerTypes.COLOR] : 'color',
  [LayerTypes.ID]    : 'id',
  [LayerTypes.NORMAL]: 'normal',
  [LayerTypes.CUSTOM]: 'custom',
}

export const TypeSizes = {
  [LayerTypes.LOC]   : 3,
  [LayerTypes.UV]    : 2,
  [LayerTypes.COLOR] : 4,
  [LayerTypes.NORMAL]: 3,
  [LayerTypes.ID]    : 1,
  [LayerTypes.CUSTOM]: 4,
  [LayerTypes.INDEX] : 1,
}
