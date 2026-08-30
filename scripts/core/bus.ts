/*
# Message bus system.  

This system is a kind of global event bus.  It's for more fundamental 
cases then what the dependency graph might handle (e.g. informing
any open uv editors to refresh themselves).

the system used pseudo-weak-references by, instead of
passing subscriber owner references directly, a callback
function that returns owners is passed instead; if it
returns undefined owner is assumed to be unreferenced.

We strongly enforce event type names. 


import messageBus from 'core/bus'

class EmitterClass {
  static busDefine() {
    return {
      // events that go from emitters
      events : ["REGISTER", "BLEH", "UNREGISTER"]
      // events that go to emitters
      triggers: ['TRIGGER1', 'TRIGGER2']
    } as const
  }

  constructor() {
    messageBus.addEmitter(this, EmitterClass)
  }

  onDestroy() {
    messageBus.removeEmitter(this, EmitterClass)
  }
}
*/

export type EventCallback = (msg: BusMessage) => void

export class Subscriber<CLS extends IBusEmitterClass, T = any> {
  getter: () => T
  events: BusEvents<CLS>[]
  callback: EventCallback
  sourceClass: CLS
  priority: number

  constructor(
    getter_cb: () => T,
    sourceClass: any,
    events: BusEvents<CLS>[],
    callback: EventCallback,
    priority: number
  ) {
    this.getter = getter_cb
    this.events = events
    this.callback = callback
    this.sourceClass = sourceClass
    this.priority = priority
  }
}

export class BusMessage<T = any, D = any, CLS extends IBusEmitterClass = IBusEmitterClass> {
  event: string
  data: D
  sourceClass: any
  emitter?: IBusEmitter<CLS>
  target?: T

  constructor(sourceClass: any, key: string, data: D) {
    this.event = key
    this.data = data
    this.sourceClass = sourceClass
    this.target = undefined
  }
}

export interface IBusEmitter<EmitterClass extends IBusEmitterClass> {
  onTrigger?(event: BusTriggers<EmitterClass>, data?: any): void
}

export interface IBusEmitterClass {
  busDefine(): {
    events: readonly string[] //e.g. ["REGISTER", "UNREGISTER"
    triggers: readonly string[]
  }
}

export type BusTriggers<EmitterClass extends IBusEmitterClass> = ReturnType<
  EmitterClass['busDefine']
>['triggers'][number]
export type BusEvents<EmitterClass extends IBusEmitterClass> = ReturnType<EmitterClass['busDefine']>['events'][number]

export class MessageBus {
  subscribers: Subscriber<IBusEmitterClass>[]
  emitters: {emitter: any; emitterClass: IBusEmitterClass}[]

  constructor() {
    this.subscribers = []
    this.emitters = [] //list of classes
  }

  private findEmitter<T extends boolean, CLS extends IBusEmitterClass>(
    emitter: IBusEmitter<CLS>,
    emitterClass: CLS,
    createSpace?: T
  ): T extends true ? number : number | undefined {
    const index = this.emitters.findIndex((e) => e.emitter === emitter && e.emitterClass === emitterClass)
    if (index === -1 && createSpace) {
      this.emitters.length++
      return this.emitters.length - 1
    }

    // TS's inference isn't quite smart enough for the undefined here
    return index === -1 ? (undefined as unknown as number) : index
  }

  addEmitter<CLS extends IBusEmitterClass>(emitter: IBusEmitter<CLS>, emitterClass: CLS) {
    const index = this.findEmitter(emitter, emitterClass, true)
    this.emitters[index] = {emitter, emitterClass}
    return this
  }
  hasEmitter<CLS extends IBusEmitterClass>(emitter: IBusEmitter<CLS>, emitterClass: CLS) {
    return this.findEmitter(emitter, emitterClass) !== undefined
  }

  removeEmitter<CLS extends IBusEmitterClass>(emitter: IBusEmitter<CLS>, emitterClass: CLS) {
    const i = this.findEmitter(emitter, emitterClass)
    if (i === undefined) {
      //throw new Error('emitter not found')
      console.warn('emitter not found', this, i)
      return
    }
    this.emitters.splice(i, 1)
    return this
  }
  /** getter_cb is a function that returns
   * subscriber object, or undefined if subscriber is dead. */
  subscribe<T = any>(
    getter_cb: () => T,
    sourceClass: any,
    callback: EventCallback,
    _events: string | string[] = 'ANY',
    priority = 100000
  ) {
    let events: Set<string>

    if (typeof _events === 'string' && _events === 'ANY') {
      events = new Set(['ANY'])
    } else {
      if (typeof _events === 'string') {
        events = new Set([_events])
      } else {
        events = new Set(_events)
      }
    }

    for (const event of events) {
      if (event === 'ANY') {
        continue
      }

      if (!this.isValidEvent(sourceClass, event)) {
        throw new Error('invalid message type ' + event)
      }
    }

    const sub = new Subscriber(getter_cb, sourceClass, Array.from(events), callback, priority)
    this.subscribers.push(sub)

    this.sortSubscribers()

    return sub
  }

  validateSubscribers(): void {
    for (const sb of new Set(this.subscribers)) {
      if (!sb.getter()) {
        console.warn('Dead subscriber', sb)
        this.subscribers.remove(sb)
      }
    }
  }

  unsubscribe(sub: Subscriber<IBusEmitterClass>): this {
    if (this.subscribers.includes(sub)) {
      this.subscribers.remove(sub)
    }

    this.sortSubscribers()

    return this
  }

  sortSubscribers(): this {
    this.subscribers.sort((a, b) => a.priority - b.priority)
    return this
  }

  isValidEvent(sourceClass: IBusEmitterClass, messageType: string): boolean {
    const types = sourceClass.busDefine().events

    let ok = false
    for (const type of types) {
      if (type === messageType) {
        ok = true
      }
    }

    if (!ok) {
      console.warn('Invalid message type ' + messageType, 'valid ones are', types)
    }

    return ok
  }

  emit<CLS extends IBusEmitterClass>(
    sourceEmitter: IBusEmitter<CLS>,
    sourceClass: CLS,
    messageType: BusEvents<CLS>,
    data: any
  ): void {
    if (!this.isValidEvent(sourceClass, messageType)) {
      throw new Error('invalid message type ' + messageType)
    }

    window.setTimeout(() => {
      this.emitSync(sourceEmitter, sourceClass, messageType, data)
    }, 0)
  }

  sendTrigger<CLS extends IBusEmitterClass>(sourceClass: CLS, messageType: BusTriggers<CLS>, data?: any): void {
    for (const emitter of this.emitters) {
      if (emitter.emitterClass === sourceClass && emitter.emitter.onTrigger !== undefined) {
        emitter.emitter.onTrigger(messageType, data)
      }
    }
  }

  emitSync<CLS extends IBusEmitterClass>(
    sourceEmitter: IBusEmitter<CLS> | undefined,
    sourceClass: CLS,
    messageType: BusEvents<CLS>,
    data: any
  ): void {
    const msg = new BusMessage(sourceClass, messageType, data)

    let del = undefined

    for (const sb of this.subscribers) {
      let ok = sb.sourceClass === sourceClass
      ok = ok && (sb.events.includes('ALL') || sb.events.includes(messageType))

      if (!ok) {
        continue
      }

      let subscriber: any

      try {
        subscriber = sb.getter()
      } catch (error) {
        subscriber = undefined
        console.log((error as Error).stack)
        console.log((error as Error).message)
      }

      if (!subscriber) {
        //dead owner
        console.warn('Dead subscriber', sb)
        if (!del) {
          del = [sb]
        } else {
          del.push(sb)
        }

        continue
      }

      msg.target = subscriber
      msg.emitter = sourceEmitter
      msg.sourceClass = sourceClass

      try {
        sb.callback(msg)
      } catch (error) {
        console.log((error as Error).stack)
        console.log((error as Error).message)
      }
    }

    msg.target = undefined

    if (del) {
      for (const sb of del) {
        this.subscribers.remove(sb)
      }
    }
  }
}

export default new MessageBus()
