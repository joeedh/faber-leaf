import {Vector2, PackNode, PackNodeVertex, graphPack} from '../path.ux/scripts/pathux.js'

export function calcGraphAABB(graph) {
  let found = 0
  let min = new Vector2([1e17, 1e17])
  let max = new Vector2([-1e17, -1e17])

  let p = new Vector2()

  for (let node of graph.nodes) {
    min.min(node.graph_ui_pos)
    max.max(node.graph_ui_pos)

    p.load(node.graph_ui_pos).add(node.graph_ui_size)

    min.min(p)
    min.max(p)

    found++
  }

  if (!found) {
    min.zero()
    max.zero()
  }

  return [min, max]
}

export function layoutNode(node, args = {}) {
  let ret = {
    pos    : new Vector2(node.graph_ui_pos),
    size   : new Vector2(node.graph_ui_size),
    inputs : {},
    outputs: {},
  }

  if (args.extraWidth) {
    ret.size[0] += args.extraWidth
  }

  let socksize = args.socksize || 35

  ret.socksize = socksize

  let maxsocks = 0

  for (let i = 0; i < 2; i++) {
    let socks = !i ? node.inputs : node.outputs
    maxsocks = Math.max(maxsocks, Object.keys(socks).length)
  }

  let minsize = maxsocks * socksize + 15
  ret.size[1] = Math.max(ret.size[1], minsize)

  for (let i = 0; i < 2; i++) {
    let socks = !i ? node.inputs : node.outputs
    let def = !i ? ret.inputs : ret.outputs

    let x = i ? ret.size[0] : 0
    let y = 35

    for (let k in socks) {
      let p = new Vector2()

      p[0] = x
      p[1] = y

      y += socksize

      def[k] = p
    }
  }

  return ret
}

export function sortGraphSpatially(graph, args = {}) {
  let nodes = []
  let sock_idmap = {}

  args.steps = args.steps || 35

  args.headerHeight = args.headerHeight || 5
  args.extraWidth = args.extraWidth || 0

  for (let node of graph.nodes) {
    let n = new PackNode()
    let layout = layoutNode(node, args)

    n.pos.load(layout.pos)
    n.size.load(layout.size)

    n.node = node

    n.size[0] += args.extraWidth
    n.size[1] += args.headerHeight

    for (let i = 0; i < 2; i++) {
      let socks = i ? node.outputs : node.inputs
      let lsocks = i ? layout.outputs : layout.inputs

      for (let k in socks) {
        let sock = socks[k]
        let p = lsocks[k]

        let v = new PackNodeVertex(n, p)
        sock_idmap[sock.graph_id] = v
      }
    }

    nodes.push(n)
  }

  for (let node of graph.nodes) {
    for (let i = 0; i < 2; i++) {
      let socks = i ? node.outputs : node.inputs

      for (let k in socks) {
        let sock = socks[k]
        let v1 = sock_idmap[sock.graph_id]

        for (let sock2 of sock.edges) {
          let v2 = sock_idmap[sock2.graph_id]

          v1.edges.push(v2)
          v2.edges.push(v1)
        }
      }
    }
  }

  graphPack(nodes, undefined, args.steps)

  for (let n of nodes) {
    n.node.graph_ui_pos.load(n.pos)
  }
}
