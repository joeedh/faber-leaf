/**
 * The image-editor redraw trigger — P18 §5 step 5.
 *
 * `window.redraw_uveditors` walked the screen and redrew every `ImageEditor` it
 * found, which meant the host had to know the editor types that care. The bus
 * inverts that: an editor registers itself while it is on screen, and a sender
 * names only the trigger. This suite pins the trigger's spelling, which is the
 * one thing the sender and the two editors have to agree on, and the
 * registration lifecycle they use to do it. P19 added the two overlay triggers
 * back, so the spelling it pins now covers those as well.
 */

import bus, {MessageBus} from '../../scripts/core/bus'
import {ImageBus, type ImageDrawLine} from '../../scripts/editors/image/ImageBus'

describe('ImageBus', () => {
  test('declares exactly the triggers something handles', () => {
    // The two overlay triggers came back in P19 with the island packer, the
    // only sender; a trigger nothing handles is swallowed by sendTrigger.
    expect(ImageBus.busDefine().triggers).toEqual(['flagRedraw', 'resetDrawLines', 'addDrawLine'])
    expect(ImageBus.busDefine().events).toEqual([])
  })

  test('a registered emitter hears flagRedraw, and stops when it deregisters', () => {
    const local = new MessageBus()
    const heard: string[] = []
    const editor = {
      onTrigger(type: string) {
        heard.push(type)
      },
    }

    local.addEmitter(editor, ImageBus)
    local.sendTrigger(ImageBus, 'flagRedraw')
    expect(heard).toEqual(['flagRedraw'])

    local.removeEmitter(editor, ImageBus)
    local.sendTrigger(ImageBus, 'flagRedraw')
    expect(heard).toEqual(['flagRedraw'])
  })

  test('registering twice does not double-deliver', () => {
    const local = new MessageBus()
    let count = 0
    const editor = {
      onTrigger() {
        count++
      },
    }

    // on_area_active fires again whenever an area is swapped back in.
    local.addEmitter(editor, ImageBus)
    local.addEmitter(editor, ImageBus)
    local.sendTrigger(ImageBus, 'flagRedraw')

    expect(count).toBe(1)
  })

  test('the overlay channel carries its payload through', () => {
    const local = new MessageBus()
    const seen: [string, ImageDrawLine | undefined][] = []
    const editor = {
      onTrigger(type: string, line?: ImageDrawLine) {
        seen.push([type, line])
      },
    }

    local.addEmitter(editor, ImageBus)
    local.sendTrigger(ImageBus, 'resetDrawLines')
    local.sendTrigger(ImageBus, 'addDrawLine', {x1: 0, y1: 0, x2: 1, y2: 1, color: '#f00'})

    expect(seen).toEqual([
      ['resetDrawLines', undefined],
      ['addDrawLine', {x1: 0, y1: 0, x2: 1, y2: 1, color: '#f00'}],
    ])
  })

  test('a trigger with no emitters is a no-op, not a throw', () => {
    expect(() => bus.sendTrigger(ImageBus, 'flagRedraw')).not.toThrow()
  })
})
