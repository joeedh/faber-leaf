let _monaco

let _stopped = false
let _api = undefined
let _get_screen
let _editors = new Set()

// This addon ships unbuilt, so no `@framework/api` rewrite runs over it and
// the mounted-instance registry has to be reached through the runtime global.
const _appState = () => globalThis._framework?.api?.peekAppState()

function _checkeditor(x, y) {
  console.log('check editor')
  let screen = _appState()?.screen
  if (!screen) {
    return
  }

  let editor = screen.findScreenArea(x, y)
  if (!editor) {
    return
  }

  console.log(editor.area.tagName, _editors)

  if (editor.area.tagName !== 'ADDON-CODE-EDITOR-X') {
    editor.area.focus()

    for (let meditor of _editors) {
      if (!meditor.editor) {
        continue
      }

      meditor.dom.blur()

      meditor = meditor.editor

      console.log('EDITOR', editor)
      //meditor._modelData.viewModel.setHasFocus(false);
    }

    editor.area.focus({preventScroll: true})
    let div = document.createElement('div')

    div.setAttribute('tabindex', '-1')
    document.body.appendChild(div)
    div.focus({preventScroll: true})
    window.setTimeout(() => {
      div.remove()
    }, 50)
  }
}

function _on_mousedown(e) {
  _checkeditor(e.x, e.y)
}

function _on_touchstart(e) {
  if (e.touches.length === 0) {
    return
  }

  e = e.touches[0]
  _checkeditor(e.pageX, e.pageY)
}

function stopEvents(editor) {
  if (_stopped || !_api) {
    return
  }

  _editors.add(editor)

  _stopped = true
  _get_screen = _api.pathux.stopEvents()

  window.addEventListener('mousedown', _on_mousedown)
  window.addEventListener('touchstart', _on_touchstart)
}

function startEvents(editor) {
  if (!_stopped || !_api) {
    return
  }

  if (editor !== undefined) {
    _editors.delete(editor)
  }

  _stopped = false
  _api.pathux.startEvents(_get_screen)
  window.removeEventListener('mousedown', _on_mousedown)
  window.removeEventListener('touchstart', _on_touchstart)
}

function getMonaco() {
  return new Promise((accept, reject) => {
    if (_monaco) {
      accept(_monaco)
      return
    }

    let path = 'addons/code_editor/node_modules/monaco-editor/min/vs'

    let script = document.createElement('script')
    script.setAttribute('src', 'addons/code_editor/node_modules/monaco-editor/min/vs/loader.js')
    script.setAttribute('type', 'application/javascript')
    script.setAttribute('async', true)
    script.onload = function () {
      require.config({paths: {vs: path}})

      require(['vs/editor/editor.main'], function () {
        console.log('Got monaco', window.monaco)
        _monaco = window.monaco

        accept(_monaco)

        /*
        var editor = monaco.editor.create(document.getElementById('container'), {
          value: ['function x() {', '\tconsole.log("Hello world!");', '}'].join('\n'),
          language: 'javascript'
        });

        window.onresize = function () {
          editor.layout();
        };*/
      })
    }

    document.body.appendChild(script)

    let path2 = path + '/editor/editor.main.css'
    let link = document.createElement('link')
    link.setAttribute('rel', 'stylesheet')
    link.setAttribute('data-name', 'vs/editor/editor.main')
    link.setAttribute('href', path2)

    document.head.appendChild(link)
  })
}

export const addonDefine = {
  name         : 'Code Editor',
  version      : 0,
  author       : '',
  url          : '',
  icon         : -1,
  description  : '',
  documentation: '',
}

export class MonacoContainer {
  constructor() {
    this.dom = undefined
    this.editor = undefined

    this.started = false
  }

  layout(editor) {
    if (this.editor) {
      //this.dom.style["position"] = "absolute";
      let r = editor.header.getBoundingClientRect()

      let h = 45
      if (r) {
        h = r.height + 5
      }

      this.dom.style['margin'] = this.dom.style['padding'] = '0px'
      this.dom.style['width'] = editor.size[0] + 'px'
      this.dom.style['height'] = editor.size[1] - h + 'px'
      this.dom.style['left'] = editor.pos[0] + 'px'
      this.dom.style['top'] = editor.pos[1] + h + 'px'

      this.editor.layout()
    }
  }

  start() {
    if (this.started || !this.dom) {
      return
    }

    this.started = true
    document.body.appendChild(this.dom)
    this.editor.layout()
  }

  stop() {
    if (!this.started) {
      return
    }

    this.dom.remove()
    this.started = false
  }

  init(parent, monaco, editor) {
    //this.started = true;

    let div = (this.dom = document.createElement('div'))
    div.style.position = 'absolute'
    div.style['z-index'] = '150'

    //parent.appendChild(div);
    //document.body.appendChild(div);

    this.dom.setAttribute('id', 'code-editor-container')
    this.dom.setAttribute('class', 'code-editor')

    this.dom.style['margin'] = this.dom.style['padding'] = '0px'
    this.dom.style['width'] = editor.size[0] + 'px'
    this.dom.style['height'] = editor.size[1] + 'px'

    this.editor = monaco.editor.create(div, {
      value               : `function test() {\n}\n`,
      language            : 'javascript',
      lineNumbersMinChars : 4,
      lineDecorationsWidth: 2,
    })

    this.editor.onDidBlurEditorText(() => this.onblur())
    this.editor.onDidBlurEditorWidget(() => this.onblur())

    this.editor.onDidFocusEditorText(() => this.onfocus())
    this.editor.onDidFocusEditorWidget(() => this.onfocus())
  }

  update() {
    if (!this.editor) {
      return
    }

    console.log(this.editor._focusTracker._hasFocus)
  }

  onblur(arg) {
    console.log('editor blur')
    startEvents(this)
  }

  onfocus(arg) {
    console.log('editor focus')
    stopEvents(this)
  }
}

let _CodeEditor

export function onAddonCreate(api) {
  _api = api
  let Editor = api.editor.Editor

  class CodeEditor extends api.editor.Editor {
    static STRUCT = api.nstructjs.inlineRegister(
      this,
      `
code_editor.CodeEditor {
  }
  `
    )

    constructor() {
      super()

      this.editor = new MonacoContainer()
    }

    on_resize() {
      super.on_resize()
      this.editor.layout(this)
    }

    init() {
      super.init()

      getMonaco().then((monaco) => {
        console.log('Init monaco')

        let col = this.container.col()
        let container = col.shadow

        this.editor.init(container, monaco, this)
      })
    }

    on_area_inactive() {
      startEvents(this.editor)
      this.editor.stop()
    }

    on_area_active() {
      this.editor.start()
    }

    update() {
      super.update()

      this.editor.update()
    }

    setCSS() {
      super.setCSS()

      this.editor.layout(this)
    }

    static define() {
      return {
        uiname  : 'Code Editor',
        areaname: 'code-editor',
        tagname : 'addon-code-editor-x',
      }
    }
  }
  api.register(CodeEditor)
  _CodeEditor = CodeEditor
}

export function register(api) {
  if (_CodeEditor) {
    api.nstructjs.register(_CodeEditor)
    api.register(_CodeEditor)
  }
}

export function unregister(api) {
  startEvents()
}
