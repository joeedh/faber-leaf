import {Curve1D, util} from '../path.ux/scripts/pathux.js'
import {nstructjs} from '../path.ux/pathux.js'
import type {StructReader} from '../path.ux/scripts/util/nstructjs.js'

const _bdhash = new util.HashDigest()

export class BrushDynChannel {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
BrushDynChannel {
  name        : string;
  useDynamics : bool;
  curve       : Curve1D; 
}
`
  )

  name: string
  curve = new Curve1D()
  useDynamics = false

  constructor(name = '') {
    this.name = name
  }

  calcHashKey(digest: util.HashDigest = _bdhash.reset()): number {
    const d = digest

    d.add(this.name)
    d.add(this.useDynamics)
    this.curve.calcHashKey(d)

    return d.get()
  }

  equals(b: this): boolean {
    let r = this.name === b.name

    r = r && this.curve.equals(b.curve)
    r = r && this.useDynamics === b.useDynamics

    return r
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)

    if (!this.name) {
      this.name = 'unnamed'
    }
  }

  copyTo(b: this): void {
    b.curve = this.curve.copy()
    b.useDynamics = this.useDynamics
    b.name = this.name
  }
}

const radius_curve_json = {
  generators: [
    {type: 'EquationCurve', equation: 'x'},
    {
      type     : 'GuassianCurve',
      height   : 1,
      offset   : 1,
      deviation: 0.3,
    },
    {
      type         : 'BSplineCurve',
      interpolating: false,
      points: [
        {'0': 0.02344, '1': 0.12891, eid: 1, flag: 1, tangent: 1},
        {
          '0'    : 0.29297,
          '1'    : 0.85156,
          eid    : 3,
          flag   : 0,
          tangent: 1,
        },
        {'0': 1, '1': 1, eid: 2, flag: 0, tangent: 1},
      ],
      deg          : 6,
      eidgen       : {_cur: 4},
    },
    {
      type  : 'BounceCurve',
      params: {decay: 1, scale: 1, freq: 1, phase: 0, offset: 0},
    },
    {type: 'ElasticCurve', params: {mode: false, amplitude: 1, period: 1}},
    {
      type  : 'EaseCurve',
      params: {mode_in: true, mode_out: true, amplitude: 1},
    },
    {type: 'RandCurve', params: {amplitude: 1, decay: 1, in_mode: true}},
  ],
  uiZoom          : 1,
  VERSION         : 1,
  active_generator: 'BSplineCurve',
}

const reverse_brush_curve = {
  generators: [
    {type: 'EquationCurve', equation: 'x'},
    {
      type     : 'GuassianCurve',
      height   : 1,
      offset   : 1,
      deviation: 0.3,
    },
    {
      type         : 'BSplineCurve',
      interpolating: false,
      points: [
        {'0': 0.0, '1': 1.0, eid: 1, flag: 0, tangent: 1},
        {
          '0'    : 0.24219,
          '1'    : 0.91406,
          eid    : 3,
          flag   : 0,
          tangent: 1,
        },
        {'0': 0.6562525, '1': 0.09766125000000003, eid: 4, flag: 1, tangent: 1},
        {
          '0'    : 1.0,
          '1'    : 0.0,
          eid    : 2,
          flag   : 0,
          tangent: 1,
        },
      ],
      deg          : 6,
      eidgen       : {_cur: 5},
    },
    {
      type  : 'BounceCurve',
      params: {decay: 1, scale: 1, freq: 1, phase: 0, offset: 0},
    },
    {type: 'ElasticCurve', params: {mode: false, amplitude: 1, period: 1}},
    {
      type  : 'EaseCurve',
      params: {mode_in: true, mode_out: true, amplitude: 1},
    },
    {type: 'RandCurve', params: {amplitude: 1, decay: 1, in_mode: true}},
  ],
  uiZoom          : 0.9414801494010006,
  VERSION         : 1,
  active_generator: 'BSplineCurve',
}

const _digest2 = new util.HashDigest()

export class BrushDynamics {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
  BrushDynamics {
    channels : array(BrushDynChannel);
  }
`
  )
  channels: BrushDynChannel[] = []

  strength!: BrushDynChannel
  radius!: BrushDynChannel
  autosmooth!: BrushDynChannel
  concaveFilter!: BrushDynChannel
  rake!: BrushDynChannel
  pinch!: BrushDynChannel
  smoothProj!: BrushDynChannel
  sharp!: BrushDynChannel
  autosmoothInflate!: BrushDynChannel

  constructor() {
    let ch = this.getChannel('strength', true)
    ch.useDynamics = false
    ch.curve.loadJSON(radius_curve_json)

    ch = this.getChannel('radius', true)
    ch.useDynamics = false
    //ch.curve.loadJSON(radius_curve_json);

    ch = this.getChannel('autosmooth', true)
    ch.useDynamics = true
    ch.curve.loadJSON(reverse_brush_curve)

    ch = this.getChannel('concaveFilter', true)
    ch.useDynamics = true
    ch.curve.loadJSON(reverse_brush_curve)

    ch = this.getChannel('rake', true)
    ch.useDynamics = false
    ch.curve.loadJSON(reverse_brush_curve)

    ch = this.getChannel('pinch', true)
    ch.useDynamics = false

    ch = this.getChannel('smoothProj', true)
    ch.useDynamics = false

    ch = this.getChannel('sharp', true)
    ch.useDynamics = false

    ch = this.getChannel('autosmoothInflate', true)
    ch.useDynamics = false
  }

  calcHashKey(d = _digest2.reset()) {
    for (const ch of this.channels) {
      ch.calcHashKey(d)
    }

    return d.get()
  }

  equals(b: this): boolean {
    for (const ch1 of this.channels) {
      const ch2 = b.getChannel(ch1.name, false)

      if (!ch2?.equals(ch1)) {
        return false
      }
    }

    return true
  }

  loadDefault(name: string): void {
    const json = new BrushDynamics().getChannel(name, true).curve.toJSON()
    //let json = radius_curve_json;
    //let json2 = new BrushDynamics().radius.curve.toJSON();

    this.getChannel(name, true).curve.loadJSON(json)
  }

  hasChannel(name: string) {
    return this.getChannel(name, false) !== undefined
  }

  getChannel<T extends true | false>(
    name: string,
    autoCreate: T = true as T
  ): T extends true ? BrushDynChannel : BrushDynChannel | undefined {
    for (const ch of this.channels) {
      if (ch.name === name) {
        return ch
      }
    }

    if (autoCreate) {
      const ch = new BrushDynChannel(name)
      this.channels.push(ch)

      if (!Object.prototype.hasOwnProperty.call(this, name)) {
        Object.defineProperty(this, name, {
          get: function () {
            return this.getChannel(name)
          },
        })
      }

      return ch
    }

    // this case never happens if autoCreate is true
    // but we have to ast to BrushDynChannel to make
    // the type system happen since it doesn't infer that
    return undefined as unknown as BrushDynChannel
  }

  getCurve(channel: string): Curve1D {
    return this.getChannel<true>(channel, true).curve
  }

  loadSTRUCT(reader: StructReader<this>): void {
    reader(this)

    const defineProp = (name: string) => {
      if (Object.prototype.hasOwnProperty.call(this, name)) {
        return
      }

      Object.defineProperty(this, name, {
        get: function () {
          return this.getChannel(name)
        },
      })
    }

    if (!this.hasChannel('autosmooth')) {
      this.loadDefault('autosmooth')
    }

    for (const ch of this.channels) {
      defineProp(ch.name)
    }
  }

  copyTo(b: this) {
    for (const ch1 of this.channels) {
      const ch2 = b.getChannel(ch1.name, true)
      ch1.copyTo(ch2)
    }
  }
}
