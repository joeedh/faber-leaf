import * as util from '../util/util.js'
import {AppState} from '../core/appstate.js'

export const TestFlags = {}

export class TestAction {
  exec(ctx) {
    throw new Error('implement me (returns a Promise)')
  }

  reset() {
    //reset internal action state
  }
}

export class ToolAction extends TestAction {
  constructor(action, args = {}, delay_ms = 0) {
    super()

    this.toolpath = action
    this.args = {}
    this.delay = delay_ms
  }

  exec(ctx) {
    return new Promise((accept, reject) => {
      const run = () => ctx.api.execTool(ctx, this.toolpath, this.args).then(accept, reject)
      if (this.delay) {
        window.setTimeout(run, this.delay)
      } else {
        run()
      }
    })
  }
}

export class RedrawAction extends TestAction {
  constructor() {
    super()
  }

  exec(ctx) {
    return window.redraw_viewport_p(true)
  }
}

export class PathSetAction extends TestAction {
  constructor(path, getValueCB) {
    super()

    if (typeof getValueCB !== 'function') {
      this.cb = () => getValueCB
    } else {
      this.cb = getValueCB
    }

    this.path = path
  }

  exec(ctx) {
    return new Promise((accept, reject) => {
      let val = this.cb()

      console.log('VAL', val)
      ctx.api.setValue(ctx, this.path, val)
      accept()
    })
  }
}

export class PromiseAction extends TestAction {
  constructor(func) {
    super()
    this.func = func
  }

  exec(ctx) {
    return this.func()
  }
}

export class FuncAction extends TestAction {
  constructor(func, preDelay = 0, postDelay = 0) {
    super()

    this.func = func
    this.preDelay = preDelay
    this.postDelay = postDelay
  }

  exec(ctx) {
    return new Promise((accept, reject) => {
      if (this.preDelay && this.postDelay) {
        window.setTimeout(() => {
          this.func()
          window.setTimeout(accept, this.postDelay)
        }, this.preDelay)
      } else if (this.preDelay) {
        window.setTimeout(() => {
          this.func()
          accept()
        }, this.preDelay)
      } else if (this.postDelay) {
        this.func()
        window.setTimeout(accept, this.postDelay)
      } else {
        this.func()
        accept()
      }
    })
  }
}

export class WaitAction extends TestAction {
  constructor(delay = 0) {
    super()

    this.delay = delay
  }

  exec(ctx) {
    return new Promise((accept, reject) => {
      window.setTimeout(accept, this.delay)
    })
  }
}
