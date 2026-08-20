import * as util from '../util/util.js'
import {AppState} from '../core/appstate.js'
import {
  getAppState,
  registerAppInstance,
  setActiveAppInstance,
  unregisterAppInstance,
} from '../core/app_instance.js'
import {FuncAction, PathSetAction, PromiseAction, RedrawAction, ToolAction, WaitAction} from './test_base.js'

export class TestSet extends Array {
  constructor() {
    super()

    this.i = 0
    this.time = 0

    this.running = false
    this.donecb = undefined
    this.ctx = undefined

    this.timeLog = []
    this.lastLogTimes = {}
    this.lastLogDeltas = {}

    this.msgDiv = undefined
    this.msgDivTime = 0
    this.msgLines = []
    this.msgMaxLines = 24
  }

  showMessage() {
    if (this.msgDiv === undefined) {
      this.msgDiv = document.createElement('div')
      this.msgDivTime = util.time_ms()

      let timer
      timer = window.setInterval(() => {
        if (util.time_ms() - this.msgDivTime > 3500) {
          window.clearInterval(timer)

          this.msgDiv.remove()
          this.msgDiv = undefined
        }
      }, 8)

      let div = this.msgDiv
      this.msgDivTime = util.time_ms()

      div.style['position'] = 'fixed'
      div.style['left'] = '200px'
      div.style['top'] = '200px'

      div.style['background-color'] = 'rgba(25, 25, 25, 0.25)'
      div.style['color'] = 'rgba(235, 235, 235, 1.0)'
      div.style['border-radius'] = '25px'
      div.style['padding'] = '25px'
      document.body.appendChild(this.msgDiv)
    }

    let s = ''
    for (let i = 0; i < arguments.length; i++) {
      if (i > 0) {
        s += ' '
      }

      s += '' + arguments[i]
    }

    let maxline = this.msgMaxLines

    let lines = this.msgLines
    if (lines.length > maxline) {
      lines.shift()
    }
    lines.push('' + s)

    let buf = '<p><pre>' + lines.join('</pre></p><br><p><pre>')
    buf += '</pre></p>'

    this.msgDiv.innerHTML = buf
  }

  reset() {
    for (let action of this) {
      action.reset()
    }

    this.i = 0

    return this
  }

  add(action) {
    this.push(action)
    return action
  }

  redraw() {
    return this.add(new RedrawAction())
  }

  tool(toolpath, args, delay) {
    return this.add(new ToolAction(toolpath, args, delay))
  }

  perfStart(tag = 'time') {
    return this.func(() => {
      this.lastLogTimes[tag] = util.time_ms()
    })
  }

  perfLog(tag = 'time') {
    return this.func(() => {
      let time = util.time_ms()
      let delta = time

      if (tag in this.lastLogTimes) {
        delta -= this.lastLogTimes[tag]
      } else {
        delta = 0
      }

      this.timeLog.push({
        tag,
        time,
        delta,
      })

      this.lastLogDeltas[tag] = delta
      this.lastLogTimes[tag] = time
    })
  }

  func(func, preDelay = 0, postDelay = 0) {
    return this.add(new FuncAction(func, preDelay, postDelay))
  }

  wait(delay) {
    return this.add(new WaitAction(delay))
  }

  end() {
    if (!this.running) {
      return
    }

    this.running = false
    this.i = 0

    let log = this.timeLog
    if (log.length === 0) {
      return
    }

    console.log('=== Performance Log ===')

    for (let entry of log) {
      let line = `${entry.tag}: delta=${entry.delta.toFixed(2)}ms`
      line += ` time=${entry.time.toFixed(2)}ms`

      console.log(line)
    }
  }

  pushAppState() {
    let ret = this.add(new PromiseAction(pushAppState))
    this.func(() => {
      this.ctx = getAppState().ctx
    })

    return ret
  }

  popAppState() {
    let ret = this.add(new PromiseAction(popAppState))
    this.func(() => {
      this.ctx = getAppState().ctx
    })

    return ret
  }

  pathSet(path, val_or_func) {
    return this.add(new PathSetAction(path, val_or_func))
  }

  next() {
    let ctx = this.ctx

    if (this.i >= this.length) {
      this.end()

      if (this.donecb) {
        this.donecb()
      }

      return
    }

    let action = this[this.i]
    this.time = util.time_ms()

    try {
      action.exec(ctx).then(() => {
        if (!this.running) {
          this.end()
          return
        }

        window.updateDataGraph(true)

        this.i++
        window.setTimeout(() => this.next(ctx), 0)
      })
    } catch (error) {
      util.print_stack(error)
      this.end()

      if (this.rejectcb) {
        this.rejectcb(error)
      }
    }
  }

  run(ctx = getAppState().ctx) {
    this.i = 0
    this.running = true
    this.ctx = ctx

    this.lastLogTime = util.time_ms()

    return new Promise((accept, reject) => {
      this.donecb = accept
      this.rejectcb = reject

      this.next()
    })
  }
}

let statestack = (window._statestack = [])

import {contextWrangler} from '../path.ux/scripts/pathux.js'

export function pushAppState() {
  return new Promise((accept, reject) => {
    const prev = getAppState()

    statestack.push({
      state : prev,
      screen: prev.screen,
    })

    prev.screen.purgeUpdateStack()
    prev.stopEvents()
    prev.screen.unlisten()
    HTMLElement.prototype.remove.call(prev.screen)

    // Two instances are registered at once here -- the pushed one keeps its
    // datalib alive for popAppState, it just stops being the active one.
    const state = new AppState()
    registerAppInstance(state)
    setActiveAppInstance(state)
    window._appstate = state

    contextWrangler.reset()
    state.start(false)
    _genDefaultFile(state, 1)

    window.setTimeout(() => {
      window.updateDataGraph(true)
      window.redraw_viewport_p().then(accept)
    }, 500)
  })
}

export function popAppState() {
  return new Promise((accept, reject) => {
    let {state, screen} = statestack.pop()

    const cur = getAppState()
    cur.screen.purgeUpdateStack()
    cur.screen.unlisten()
    cur.screen.remove()

    unregisterAppInstance(cur)
    setActiveAppInstance(state)
    window._appstate = state

    document.body.appendChild(screen)
    contextWrangler.reset()
    screen.listen()
    state.startEvents()

    window.setTimeout(() => {
      window.updateDataGraph(true)
      window.redraw_viewport_p().then(accept)
    }, 500)
  })
}

window._pushAppState = pushAppState
window._popAppState = popAppState

window._testAppStateStack = function () {
  pushAppState()
    .then(() => {
      return popAppState()
    })
    .then(() => {
      console.log('Done!')
    })
}
