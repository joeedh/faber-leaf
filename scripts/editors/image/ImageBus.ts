/**
 * Bus token for "something changed under the image editors, redraw".
 *
 * It holds no imports on purpose: both the emitters (the image / UV editor
 * areas, which register themselves and implement `onTrigger`) and the senders
 * (`image.open`, and anything else that mutates a displayed `ImageBlock`) reach
 * it without either side importing the other.
 */
export class ImageBus {
  static busDefine() {
    return {
      // Triggers only: nothing subscribes *to* an image editor.
      events  : [],
      triggers: ['flagRedraw', 'resetDrawLines', 'addDrawLine'],
    } as const
  }
}

/** `addDrawLine`'s payload: two UV-space points and an optional CSS colour. */
export interface ImageDrawLine {
  x1: number
  y1: number
  x2: number
  y2: number
  color?: string
}

// `resetDrawLines` / `addDrawLine` are an overlay channel rather than a redraw
// one: a sender pushes UV-space segments the editor draws over its own
// geometry, and they stay until the next reset. The island packer is the only
// sender today -- it reports the bins it chose, which is how a bad layout gets
// diagnosed at all.
