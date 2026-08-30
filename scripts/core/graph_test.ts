import {INodeDef, Node} from './graph.js'
import {FloatSocket, IntSocket} from './graphsockets.js'

export class TestContext {
  prop1 = 0
}

export class TestNode<InputSet = {}, OutputSet = {}> extends Node<
  InputSet & {
    depend: IntSocket
    f: FloatSocket
  },
  OutputSet & {
    depend: IntSocket
    f: FloatSocket
  },
  TestContext
> {
  exec(ctx: TestContext) {
    this.inputs.f.getValue()
  }

  static nodedef(): INodeDef {
    return {
      name   : 'test',
      uiname : 'test',
      inputs: {
        depend: new IntSocket(),
        f     : new IntSocket(),
      },
      outputs: {
        depend: new IntSocket(),
        f     : new IntSocket(),
      },
    }
  }
}

export class DerivedNode extends TestNode<
  {
    i: IntSocket
  },
  {
    b: IntSocket
  }
> {
  exec(ctx: TestContext) {
    this.inputs.f.setValue(this.inputs.i.getValue())
  }

  static nodedef(): INodeDef {
    return {
      name   : 'derived',
      uiname : 'derived',
      inputs: {
        i: new IntSocket(),
      },
      outputs: {
        b: new IntSocket(),
      },
    }
  }
}
