export type EventCallback = (data: any) => void

export class EventBase {
  private _eventcbs: {[k: string]: EventCallback[]}

  constructor() {
    this._eventcbs = {}
  }

  _getEventList(event: string) {
    if (!(event in this._eventcbs)) {
      this._eventcbs[event] = []
    }

    return this._eventcbs[event]
  }

  on(event: string, cb: EventCallback) {
    this._getEventList(event).push(cb)
  }

  fire(event: string, data: any) {
    for (const cb of this._getEventList(event)) {
      cb(data)
    }
  }
}
