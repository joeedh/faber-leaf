import {Editor} from '../editor_base.ts'
import {color2css, css2color, UIBase, keymap, util, nstructjs, Vector2} from '../../path.ux/scripts/pathux.js'
import {termColorMap} from '../../path.ux/scripts/util/util.js'
import {Icons} from '../icon_enum.js'

let g_screen = undefined
let ignore = 0

const _silence = () => ignore++
const _unsilence = (force = false) => {
  if (force) {
    ignore = 0
  } else {
    ignore = Math.max(ignore - 1, 0)
  }
}

let _patched = false

function patch_console() {
  if (_patched) {
    return
  }

  _patched = true

  let methods = {}
  let handlers = {}

  function patch(key) {
    handlers[key] = function () {
      let stack = new Error().stack

      setTimeout(() => {
        if (ignore || !g_screen) {
          return
        }

        for (let sarea of g_screen.sareas) {
          if (sarea.area instanceof ConsoleEditor) {
            sarea.area._lastStack = stack
            sarea.area[key](...arguments)
          }
        }
      }, 0)
    }

    methods[key] = console[key].bind(console)
    console[key] = function () {
      methods[key](...arguments)
      handlers[key](...arguments)
    }
  }

  patch('log')
  patch('warn')
  patch('error')
  patch('trace')
}

const NO_CHILDREN = 0x7ffff
const LineFlags = {
  ACTIVE  : 1,
  TWO_LINE: 2,
}

export class ConsoleLineEntry {
  constructor(line, loc = '', fg = '', bg = '') {
    this.line = '' + line
    this.loc = '' + loc
    this.bg = '' + bg
    this.fg = '' + fg
    this.closed = false
    this.parent = 0
    this.children = NO_CHILDREN
    this.flag = 0
  }

  loadSTRUCT(reader) {
    reader(this)
  }
}

ConsoleLineEntry.STRUCT = `
ConsoleLineEntry {
    line     : string;
    loc      : string;
    bg       : string;
    fg       : string; 
    closed   : bool;
    parent   : int;
    children : int;
    flag     : int | this.flag & ~1;
}
`
nstructjs.register(ConsoleLineEntry)

export class ConsoleCommand {
  constructor(cmd) {
    this.command = cmd
  }

  loadSTRUCT(reader) {
    reader(this)
  }
}

ConsoleCommand.STRUCT = `
ConsoleCommand {
    command : string;
}
`
nstructjs.register(ConsoleCommand)

export const HitBoxTypes = {
  TOGGLE_CHILDREN: 0,
  CUSTOM         : 1,
}

export class HitBox {
  constructor(x, y, w, h) {
    this.pos = new Vector2([x, y])
    this.size = new Vector2([w, h])
    this.type = HitBoxTypes.TOGGLE_CHILDREN
    this.onhit = null

    this.lines = []
  }

  toggle(e, editor) {
    _silence()

    console.log(this.lines)

    for (let l of this.lines) {
      let i = editor.lines.indexOf(l)

      //console.log(l.children);

      if (l.children === NO_CHILDREN) {
        continue
      }

      i += l.children
      let j = 0

      while (j++ < editor.lines.length) {
        let l2 = editor.lines[i]

        //console.log(i+l2.parent, starti);
        if (editor.lines[i + l2.parent] !== l) {
          break
        }

        l2.closed ^= 1

        i++
      }
    }

    editor.queueRedraw()

    _unsilence()
  }

  click(e, editor) {
    if (this.type === HitBoxTypes.TOGGLE_CHILDREN) {
      _silence()
      console.log('click!')
      _unsilence()
      this.toggle(e, editor)
    }
  }
}

export class ConsoleEditor extends Editor {
  static STRUCT = nstructjs.inlineRegister(
    this,
    `
ConsoleEditor {
    fontsize    :  float;
    bufferSize  :  int;
    lines       :  array(ConsoleLineEntry);
    history     :  array(ConsoleCommand);
    head        :  int;
    scroll      :  vec2;
}
  `
  )

  constructor() {
    super()

    this._lastStack = ''
    this._animreq = 0

    this.redraw = this.redraw.bind(this)

    this.hitboxes = []

    this.fontsize = 12
    this.lines = []
    this.lines.active = undefined
    this.history = []
    this.history.cur = 0
    this.head = 0
    this.bufferSize = 512

    this.scroll = new Vector2()

    this.colors = {
      error     : 'red',
      error_bg  : 'rgb(55,55,55,1.0)',
      warning   : 'yellow',
      object    : 'blue',
      loc       : 'blue',
      source    : 'white',
      warning_bg: 'rgb(50, 50, 0)',
    }

    this.colormap = {
      red : 'rgb(255, 100, 100)',
      blue: 'rgb(125, 125, 255)',
    }
  }

  on_area_active() {
    patch_console()
  }

  formatMessage() {
    let s = ''

    function safestr(obj) {
      if (typeof obj === 'object' && Array.isArray(obj)) {
        let s2 = '[\n'
        let i = 0

        for (let item of obj) {
          if (i > 0) {
            s2 += ',\n'
          }

          s2 += '  ' + safestr(item)
          i++
        }

        s2 += ']\n'
        return s2
      } else if (typeof obj === 'object' && (!obj.toString || obj.toString === Object.prototype.toString)) {
        return `[object ${obj.constructor.name}]`
      }

      return typeof obj === 'symbol' ? obj.toString() : '' + obj
    }

    for (let i = 0; i < arguments.length; i++) {
      let arg = safestr(arguments[i])

      //Reflect.ownKeys(window)
      let s2 = '' + arg
      let next = i < arguments.length - 1 ? safestr(arguments[i + 1]).trim() : ''

      if (s2.startsWith('%c')) {
        s2 = s2.slice(2, s2.length)

        let style = next.replace(/\n/g, '').split(';')

        for (let line of style) {
          line = ('' + line).trim().split(':')

          if (line.length === 2 && ('' + line[0]).trim() === 'color') {
            let color = ('' + line[1]).trim().toLowerCase()

            if (color in util.termColorMap) {
              s2 = termColor(s2, color)
            }
          }
        }

        i++
      }

      s += s2 + ' '
    }

    return ('' + s).trim()
  }

  formatStackLine(stack, parts = false) {
    if (stack.search('at') < 0) {
      if (parts) {
        return ['', '']
      } else {
        return ''
      }
    }

    stack = '' + stack
    stack = stack.replace('at ', '').trim()
    let i = stack.length - 1

    while (i > 0 && stack[i] !== '/' && stack[i] !== '\\') {
      i--
    }

    let i2 = stack.search('\\(')
    let prefix = i2 >= 0 ? ('' + stack.slice(0, i2)).trim() : ''

    if (prefix.length > 0) {
      prefix += ':'
    }

    stack = stack.slice(i + 1, stack.length - 1)
    if (parts) {
      return [prefix, stack]
    }

    return util.termColor(prefix, this.colors['object']) + util.termColor(stack, this.colors['source'])
  }

  push(msg, linefg = '', linebg = '', childafter = false) {
    msg = '' + msg
    if (msg.length > 1000) {
      msg = msg.slice(0, 1000)
    }

    let stack = '' + new Error().stack

    stack = ('' + stack.split('\n')[5]).trim()
    stack = this.formatStackLine(stack)

    let ls = msg.split('\n')

    for (let i = 0; i < ls.length; i++) {
      let l = ls[i]
      let loc = ''

      if (i === ls.length - 1) {
        loc = stack
      }

      l = new ConsoleLineEntry(l, loc, linefg, linebg)

      if (childafter) {
        l.children = ls.length - i
      }

      this.pushLine(l)
    }
  }

  pushLine(line) {
    if (line === undefined) {
      line = ''
    }

    if (typeof line === 'string') {
      line = new ConsoleLineEntry(line, '')
    }

    if (this.lines.length >= this.bufferSize) {
      this.lines[this.head] = line
      this.head = (this.head + 1) % this.lines.length
    } else {
      this.lines.push(line)
      this.head = this.lines.length
    }

    _silence()
    this.queueRedraw()
    _unsilence()

    if (Math.abs(this.scroll[1]) > 10) {
      //this.scroll[1] -= this.lineHeight;
    }
  }

  get lineHeight() {
    return this.fontsize * 1.3 * UIBase.getDPI()
  }

  printStack(start = 3, fg = '', bg = '', closed = true) {
    //let stack = ("" + new Error().stack).split("\n");
    let stack = ('' + this._lastStack).split('\n')

    //_silence()
    //console.log(stack);
    //_unsilence()

    let off = -1
    for (let i = start; i < stack.length; i++) {
      let s = stack[i]
      let l = this.formatStackLine(s, true)
      l[0] = '  ' + ('' + l[0]).trim()

      l = new ConsoleLineEntry(l[0], l[1], fg, bg)
      l.closed = closed
      l.parent = off--

      this.pushLine(l)
    }
  }

  warn() {
    let msg = this.formatMessage(...arguments)

    msg = util.termColor(msg, 1)

    this.push(msg, this.colors['warning'], this.colors['warning_bg'], true)

    this.printStack(undefined, undefined, this.colors['warning_bg'], true)
  }

  error() {
    let msg = this.formatMessage(...arguments)

    msg = util.termColor(msg, 1)
    this.push(msg, this.colors['error'], this.colors['error_bg'], true)

    this.printStack(undefined, undefined, this.colors['error_bg'], true)
  }

  trace() {
    let msg = this.formatMessage(...arguments)
    this.push(msg)
    this.printStack(undefined, undefined, undefined, false)
  }

  log() {
    let msg = this.formatMessage(...arguments)

    this.push(msg)
  }

  _mouse(e) {
    let x = e.x
    let y = e.y

    let rect = this.canvas.getClientRects()[0]
    let dpi = UIBase.getDPI()
    if (rect) {
      x -= rect.x
      y -= rect.y

      x *= dpi
      y *= dpi
    }

    let e2 = {
      preventDefault : e.preventDefault.bind(e),
      stopPropagation: e.stopPropagation.bind(e),
      buttons        : e.buttons,
      button         : e.button,
      shiftKey       : e.shiftKey,
      ctrlKey        : e.ctrlKey,
      altKey         : e.altKey,
      metaKey        : e.metaKey,
      x              : x,
      y              : y,
      pageX          : x,
      pageY          : y,
      touches        : e.touches,
    }

    return e2
  }

  on_mousedown(e) {
    e = this._mouse(e)

    let hb = this.updateActive(e.x, e.y)

    if (hb) {
      hb.click(e, this)
    }

    _silence()
    //console.log(e.x, e.y);
    _unsilence()
  }

  on_mousemove(e) {
    _silence()
    e = this._mouse(e)

    this.updateActive(e.x, e.y)
    _unsilence()
  }

  updateActive(x, y) {
    let found = 0

    for (let hb of this.hitboxes) {
      let ok = 1

      ok = ok && x > hb.pos[0] && x <= hb.pos[0] + hb.size[0]
      ok = ok && y > hb.pos[1] && y <= hb.pos[1] + hb.size[1]

      if (ok) {
        found = 1

        if (this.lines.active !== undefined) {
          this.lines.active.flag &= ~LineFlags.ACTIVE
        }

        if (hb.lines.length > 0) {
          if (this.lines.active !== hb.lines[0]) {
            hb.lines[0].flag |= LineFlags.ACTIVE

            this.lines.active = hb.lines[0]
            this.queueRedraw()
          }

          return hb
        }
      }
    }

    if (!found && this.lines.active) {
      this.lines.active.flag &= ~LineFlags.ACTIVE
      this.queueRedraw()
    }
  }

  on_mouseup(e) {
    this._mouse(e)
  }

  init() {
    super.init()

    this.addEventListener('mousewheel', (e) => {
      this.scroll[1] += -e.deltaY
      this.queueRedraw()
    })

    let container = this.container
    let col = container.col()
    let canvas = (this.canvas = document.createElement('canvas'))

    canvas.addEventListener('mousemove', this.on_mousemove.bind(this))
    canvas.addEventListener('mousedown', this.on_mousedown.bind(this))
    canvas.addEventListener('mouseup', this.on_mouseup.bind(this))

    col.shadow.appendChild(canvas)

    let textbox = (this.textbox = document.createElement('input'))
    textbox.type = 'text'
    col.shadow.appendChild(textbox)

    textbox.style['width'] = '100%'
    textbox.style['height'] = '25px'
    textbox.style['padding-left'] = '5px'
    textbox.style['padding-top'] = '1px'
    textbox.style['padding-bottom'] = '1px'

    textbox.oninput = this._on_change.bind(this)
    textbox.onkeydown = this._on_keydown.bind(this)

    this.setCSS()
    this.update()
    this.queueRedraw()
  }

  _on_change(e) {
    _silence()
    _unsilence()
  }

  pushHistory(cmd) {
    let lasti = this.history.cur - 1 //(this.history.cur + this.history.length - 1) % this.history.length;
    let last = this.history.length > 0 && this.history.cur > 0 ? this.history[lasti].command : undefined

    if (cmd === last) {
      return
    }

    _silence()
    console.log('history insert')
    _unsilence()

    let command = new ConsoleCommand(cmd)

    this.history.push(command)
    this.history.cur = this.history.length
  }

  doCommand(cmd) {
    this.scroll[1] = 0.0

    this.pushHistory(cmd)
    let v

    try {
      v = eval(cmd)
    } catch (error) {
      console.error(error)
      return
    }

    console.log(v)
  }

  doTab(cmd = '') {
    let i = cmd.length - 1
    while (i >= 0) {
      if (cmd[i] === '.' || cmd[i] === ']' || cmd[i] === ')') {
        break
      }

      i--
    }

    let prefix
    let suffix
    let join = ''

    if (i <= 0) {
      prefix = ''
      suffix = ('' + cmd).trim()
    } else {
      prefix = cmd.slice(0, i).trim()
      suffix = cmd.slice(i + 1, cmd.length).trim()
      join = cmd[i]
    }

    _silence()
    console.log('p:', prefix)
    console.log('s:', suffix)
    _unsilence()

    let obj

    try {
      obj = prefix === '' ? window : eval(prefix)
    } catch (_error) {
      obj = undefined
    }

    _silence()
    console.log(obj)
    _unsilence()

    if (typeof obj !== 'object' && typeof obj !== 'function') {
      return
    }

    let keys = Reflect.ownKeys(obj)
    keys = keys.concat(Object.keys(Object.getOwnPropertyDescriptors(obj)))
    keys = keys.concat(Object.keys(Object.getOwnPropertyDescriptors(obj.__proto__)))
    keys = new Set(keys)
    let keys2 = []
    for (let k of keys) {
      keys2.push(k)
    }
    keys = keys2

    let list = []
    let lsuffix = suffix.toLowerCase()
    let hit = suffix
    let hit2 = undefined

    keys.sort((a, b) => a.length - b.length)

    for (let k of keys) {
      if (typeof k !== 'string') {
        continue
      }

      if (suffix.length === 0) {
        list.push(k)
        continue
      }

      if (k.startsWith(suffix) && (hit2 === undefined || k.length < hit2.length)) {
        hit = k
        hit2 = k
      }
      if (k.toLowerCase().startsWith(lsuffix)) {
        list.push(k)
      }
    }

    _silence()
    console.log(hit)
    console.log(list)
    _unsilence()
    let printall = 0

    if (hit) {
      let s = (prefix + join + hit).trim()

      if (s === this.textbox.value) {
        printall = 1
      }

      this.textbox.value = s
      this.textbox.setSelectionRange(s.length, s.length)

      window.tb = this.textbox
    } else {
      printall = 1
    }

    if (printall) {
      this.scroll[1] = 0.0

      this.pushLine(new ConsoleLineEntry(''))
      for (let k of list) {
        let l = new ConsoleLineEntry('  ' + k)
        this.pushLine(l)
      }
    }
  }

  goHistory(di) {
    if (this.history.length === 0) {
      return
    }

    let i = this.history.cur

    let push = this.textbox.value.trim().length > 0
    if (push) {
      this.pushHistory(this.textbox.value.trim())
    }

    i = Math.min(Math.max(i + di, 0), this.history.length - 1)
    this.history.cur = i

    let s = this.history[i].command.trim()

    this.textbox.value = s
    this.textbox.setSelectionRange(s.length, s.length)
  }

  popup(x, y) {}

  _on_keydown(e) {
    _silence()
    console.log(e.keyCode)
    _unsilence()

    e.stopPropagation()

    switch (e.keyCode) {
      case keymap['R']:
        if (e.ctrlKey | e.metaKey && !e.shiftKey && !e.altKey) {
          location.reload()
        }
        break
      case keymap['Tab']:
        this.doTab(this.textbox.value)
        e.preventDefault()
        e.stopPropagation()
        break
      case keymap['Enter']:
        this.doCommand(this.textbox.value)
        this.textbox.value = ''
        break
      case keymap['Up']:
        this.goHistory(-1)
        break
      case keymap['Down']:
        this.goHistory(1)
        break
    }
  }

  redraw() {
    this._animreq = 0

    this.hitboxes = []

    if (!this.canvas || !this.g) {
      return
    }

    let ts = this.fontsize * UIBase.getDPI()

    let canvas = this.canvas
    let g = this.g

    let c = this.getDefault('DefaultText').color
    let font = this.getDefault('DefaultText')

    c = css2color(c)

    for (let i = 0; i < 3; i++) {
      let f = 1.0 - c[i]
      c[i] += (f - c[i]) * 0.75
    }

    let bg = color2css(c)

    g.resetTransform()
    g.fillStyle = bg
    g.rect(0, 0, canvas.width, canvas.height)
    g.fill()

    g.font = font.genCSS(ts)
    g.fillStyle = font.color

    let lh = this.lineHeight
    let pad1 = 10 * UIBase.getDPI()

    let scroll = this.scroll
    let x = scroll[0] + 5 + ts
    let y = scroll[1] + 5 + canvas.height - lh

    let this2 = this
    let color = g.font.color

    let fontcpy = font.copy()

    let stateMachine = {
      stack: [],
      start(x2, y2, color2) {
        this.stack.length = 0
        this.x = x2
        this.y = y2
        this.state = this.base
        this.d = 0
        this.param1 = 0
        this.param2 = 0
        this.bgcolor = undefined

        this.color = color2
        this.font = g.font
      },

      escape(c2) {
        let ci = c2.charCodeAt(0)

        if (this.d === 0 && c2 === '[') {
          this.d++
        } else if (this.d === 1 && ci >= 48 && ci <= 57) {
          this.param1 = c2
          this.d++
        } else if (this.d === 2 && ci >= 48 && ci <= 57) {
          this.param2 = c2
          this.d++
        } else if (c2 === 'm' && this.d >= 2) {
          let tcolor = this.param1
          if (this.d > 2) {
            tcolor += this.param2
          }

          tcolor = parseInt(tcolor)
          if (tcolor === 0) {
            font.copyTo(fontcpy)
            fontcpy.color = color
            this.bgcolor = undefined
            this.color = fontcpy.color
            this.font = fontcpy.genCSS(ts)
          } else if (tcolor === 1) {
            fontcpy.weight = 'bold'
            this.font = fontcpy.genCSS(ts)
          } else if (tcolor === 4) {
            //underline?
            //ignore
            //this.font = font.genCSS(ts);
          } else if (tcolor >= 40) {
            this.bgcolor = termColorMap[tcolor - 10]
            if (this.bgcolor && this.bgcolor in this2.colormap) {
              this.bgcolor = this2.colormap[this.bgcolor]
            }
          } else {
            this.color = termColorMap[tcolor]
            if (this.color && this.color in this2.colormap) {
              this.color = this2.colormap[this.color]
            }
          }

          this.state = this.base
        } else {
          this.state = this.base
          return '?'
        }

        return false //ci > 27 ? c : "?";
      },

      base(c2) {
        let ci = c2.charCodeAt(0)

        if (ci === 27) {
          this.state = this.escape
          this.d = 0
          this.param1 = ''
          this.param2 = ''
          return false
        }

        if (c2 === ' ') {
          this.x += ts
          return false
        } else if (c2 == '\t') {
          this.x += ts * 2.0
          return false
        }

        if (ci < 30) {
          return '?'
        }
        return c2
      },
    }

    let fillText = (s, x2, y2, bg2) => {
      stateMachine.start(x2, y2, color)

      for (let i = 0; i < s.length; i++) {
        let c2 = s[i]

        c2 = stateMachine.state(c2)
        if (c2 === false) {
          continue
        }

        if (stateMachine.font !== g.font) {
          g.font = stateMachine.font
        }

        let ms = g.measureText(c2)
        if (ms.actualBoundingBoxLeft !== undefined) {
          stateMachine.x += ms.actualBoundingBoxLeft
        }

        if (stateMachine.bgcolor !== undefined) {
          g.beginPath()
          g.rect(stateMachine.x, stateMachine.y + 2, w, ts)
          let old = g.fillStyle
          g.fillStyle = stateMachine.bgcolor
          g.fill()
          g.fillStyle = old
        }

        g.fillStyle = stateMachine.color
        g.fillText(c2, stateMachine.x, stateMachine.y)

        if (ms.actualBoundingBoxRight !== undefined) {
          stateMachine.x += ms.actualBoundingBoxRight
        } else {
          stateMachine.x += ms.width
        }
      }
    }

    let measureText = (s) => {
      stateMachine.start(0, 0, color)

      for (let i = 0; i < s.length; i++) {
        let c2 = s[i]

        c2 = stateMachine.state(c2)
        if (c2 === false) {
          continue
        }
        if (stateMachine.font !== g.font) {
          g.font = stateMachine.font
        }

        let w = g.measureText(c2).width
        stateMachine.x += w

        g.fillStyle = stateMachine.color
        g.fillText(c2, stateMachine.x, stateMachine.y)
      }

      return {width: stateMachine.x}
    }

    let lines = this.lines
    for (let li2 = lines.length - 1; li2 >= 0; li2--) {
      let li = (li2 + this.head) % this.lines.length
      //for (let li=0; li<lines.length; li++) {
      let l = lines[li]
      let s = l.line

      if (l.closed || y < -lh * 4 || y >= canvas.height + lh * 3) {
        if (!l.closed) {
          y -= lh
          if (l.flag & LineFlags.TWO_LINE) {
            y -= lh
          }
        }
        continue
      }

      //HitBox
      if (l.bg) {
        g.beginPath()
        g.fillStyle = l.bg
        g.rect(x, y - ts + 2, canvas.width, ts + 3)
        g.fill()
      }

      if (l.flag & LineFlags.ACTIVE) {
        g.beginPath()
        g.fillStyle = 'rgb(255,255,255,0.2)'
        g.rect(x, y - ts + 2, canvas.width, ts + 3)
        g.fill()
      }

      color = l.fg ? l.fg : font.color

      g.fillStyle = font.color

      let w1 = measureText(s).width

      if (l.loc.length > 0) {
        let w2 = measureText(l.loc).width
        if (w1 + w2 + pad1 * 2 < canvas.width) {
          l.flag &= ~LineFlags.TWO_LINE

          g.fillStyle = this.colors['loc']
          fillText(l.loc, canvas.width - pad1 - w2, y)
        } else {
          l.flag |= LineFlags.TWO_LINE

          g.fillStyle = this.colors['loc']
          fillText(l.loc, canvas.width - pad1 - w2, y)
          y -= lh
        }
      }

      if (l.children !== NO_CHILDREN) {
        let hb = new HitBox(x, y - ts + 2, canvas.width, ts + 3)
        hb.lines.push(l)
        this.hitboxes.push(hb)
      }

      fillText(s, x, y)
      y -= lh
    }
  }

  updateSize() {
    if (!this.canvas) return

    let dpi = UIBase.getDPI()
    let w1 = this.size[0]
    let h1 = this.size[1] - 100 / dpi

    let w2 = ~~(w1 * dpi)
    let h2 = ~~(h1 * dpi)

    let canvas = this.canvas

    if (w2 !== canvas.width || h2 !== canvas.height) {
      console.log('resizing console canvas')
      this.canvas.style['width'] = w2 / dpi + 'px'
      this.canvas.style['height'] = h2 / dpi + 'px'
      this.canvas.width = w2
      this.canvas.height = h2
      this.queueRedraw()
    }
  }

  queueRedraw() {
    if (this._animreq) {
      return
    }

    this._animreq = 1
    requestAnimationFrame(this.redraw)
  }

  setCSS() {
    this.updateSize()
  }

  update() {
    if (!this.ctx) {
      return
    }

    g_screen = this.ctx.screen

    super.update()
    this.updateSize()
  }

  static define() {
    return {
      tagname : 'console-editor-x',
      areaname: 'console_editor',
      uiname  : 'Console',
      icon    : Icons.CONSOLE,
      flag    : 0,
      style   : 'console',
    }
  }

  copy() {
    return document.createElement('console-editor-x')
  }

  loadSTRUCT(reader) {
    reader(this)
    super.loadSTRUCT(reader)

    this.history.cur = this.history.length

    for (let i = 0; i < this.lines.length; i++) {
      if (typeof this.lines[i] === 'string') {
        this.lines[i] = new ConsoleLineEntry(this.lines[i], '')
      }
    }
  }
}

Editor.register(ConsoleEditor)
