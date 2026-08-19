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
      triggers: ['flagRedraw'],
    } as const
  }
}

// `resetDrawLines` / `addDrawLine` used to live beside `flagRedraw`, pushed by
// the UV unwrapper to draw its seam preview over the UV editor. P13 archived
// that stack (archive/unwrapping/) and P18 rebuilt the editor without a
// draw-line overlay, so both triggers had neither a caller nor a handler. P19
// re-adds them with the overlay that needs them.
