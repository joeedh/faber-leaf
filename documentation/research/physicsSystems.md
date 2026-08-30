# Physics, Solver Coupling, and Dependency-Graph Evaluation

*Technical survey — 2026-08-15*

*Provenance: this write-up is **domain knowledge**, not the output of a
verified deep-research pass. Unlike
[riggingSystemSurvey.md](riggingSystemSurvey.md) — which was footnoted against
fetched primary sources and adversarially vote-verified — the claims here are
not individually source-verified. Papers are cited by author/title/year, which
are reliable enough to look up, but no URL was fetched and no claim was
independently checked. Statements about **this repository** were verified by
reading the files cited; where a file was only grepped and not read, it is
marked as such. Treat architectural recommendations as considered opinion.*

*Companion document: `riggingSystemSurvey.md` covers the rigging/animation side
of dependency-graph evaluation (Presto, Premo/LibEE, Maya's Evaluation Manager,
the authoring-rig → evaluation-graph split). This document covers the
**physics/solver** side: how coupled solvers interact with a dependency graph,
whether cycles must be solved, and how a physics stack should be decomposed.
Section 1 overlaps that survey's §0 and is deliberately consistent with it.*

---

## Contents

- [0. Executive summary](#0-executive-summary)
- [1. Dependency-graph evaluation](#1-dependency-graph-evaluation)
- [2. Cycles: are they strictly necessary to solve?](#2-cycles-are-they-strictly-necessary-to-solve)
- [3. State of the art: fuse the solver](#3-state-of-the-art-fuse-the-solver)
- [4. Case study: previz IK + rigid-body dynamics](#4-case-study-previz-ik--rigid-body-dynamics)
- [5. Collision detection as a query layer](#5-collision-detection-as-a-query-layer)
- [6. Assessment of the current codebase](#6-assessment-of-the-current-codebase)
- [7. Recommendations](#7-recommendations)
- [8. References](#8-references)

---

## 0. Executive summary

**There is no industry standard for cyclic dependency evaluation, because the
industry largely refuses to solve the problem inside the graph.** What *has*
converged is the scheduling layer: granular operation-level nodes, strongly
connected component (SCC) detection, and topological evaluation of the
condensation DAG with SCCs scheduled as atomic units. Cycles are then handed to
one of three policies — break with a unit delay, fixed-point iterate, or fuse
into a monolithic solve — and shipping software overwhelmingly picks the first.

Four load-bearing conclusions:

1. **Scheduling and coupling are separate problems.** A dependency graph can
   never resolve a solver↔solver feedback loop; at best it can *identify* the
   coupled group and hand it to something that can. Every mature system makes
   this split explicit.

2. **A cyclic solver is not strictly necessary.** Any cycle can be cut with a
   unit delay (z⁻¹). You lose latency, stability under stiff coupling, and —
   most importantly for a modeling/previz app — *reproducibility under
   timeline scrubbing*.

3. **The real blocker to iterating is rollback, not numerics.** Fixed-point
   iteration requires every solver in the SCC to be re-runnable from a saved
   state. Solvers with warm-started caches, RNG streams, and sleeping-body
   lists cannot cheaply do this. That engineering cost — not the mathematics —
   is why Maya prints a warning instead of converging.

4. **The state of the art is a fused solver, not a smarter graph.** XPBD /
   Projective Dynamics / unified solvers dissolve the coupling problem by
   expressing every system as constraints in one global solve. For this
   codebase that implies: **own the constraint solver, and consume a physics
   engine only for collision detection.**

---

## 1. Dependency-graph evaluation

### 1.1 Two separable problems

These are routinely conflated, and the conflation is the source of most
confusion in this area:

| | Question | Solved by |
|---|---|---|
| **Scheduling** | In what order, on which threads, do N units of work run? | The dependency graph |
| **Coupling** | Two solvers each need the other's *converged* answer. | Numerics — **not** the graph |

### 1.2 What ships

**Maya (DG + Evaluation Manager).** The classic DG is pull-based: dirty bits
propagate forward eagerly (cheap), values are pulled backward lazily on
request. Since 2016 the Evaluation Manager builds a separate *scheduling graph*
from the DG for parallel evaluation. Cycles become "cycle clusters," scheduled
as one atomic serial unit. Maya's actual response to a cycle is the familiar
`Cycle on 'x' may not evaluate as expected` warning: it picks a
deterministic-but-arbitrary entry point, evaluates once, and reads last
evaluation's values across the back edge.

**Blender 2.8+ depsgraph.** The most instructive design, and the closest
lineage to this codebase. Its central idea is **granularity**: nodes are not
objects but `(ID, component, operation)` triples — `Object/TRANSFORM/local`,
`Object/GEOMETRY/eval`, `Pose/BONE/<name>/done`. A large fraction of apparent
cycles are artifacts of coarse nodes and simply *evaporate* at operation
granularity. Genuine remaining cycles are detected by DFS back-edge search; the
offending relation is flagged and skipped for sorting, with a console warning.
Blender additionally splits *original* and *evaluated* datablocks
(copy-on-write), so evaluation can run on a worker thread while the UI reads
the last good state.

**Houdini.** Strict DAG; cycles are never permitted. Feedback is instead a
first-class *time* construct — the Solver SOP and For-Each loop expose a
`Prev_Frame` input. The cycle is not broken, it is **unrolled in time**: the
edge points at a different time slice, so topologically it is not a cycle at
all. This is the cleanest formulation of the three.

**Unreal (AnimGraph / Control Rig).** DAG per frame. Physics↔animation coupling
(Rigid Body anim node, Physical Animation Component, PhysicsControl) is an
explicit one-frame delay in both directions. PhysX *articulations* solve the
articulated body monolithically via Featherstone, but the game↔physics
interface is still a delay.

**USD / Hydra.** Acyclic by construction (composition arcs); no simulation.
Included only to note that the "scene description" layer of the industry has
standardized on strict acyclicity and pushed all feedback out to runtime.

### 1.3 The convergent design

Across all four, the same architecture:

```
granular operation-level nodes
  → Tarjan SCC condensation
    → topological evaluation of the condensation DAG
      → each SCC is an atomic unit with its own evaluation policy
```

Single-node SCCs are ordinary topologically-sorted evaluation. Multi-node SCCs
are coupled groups requiring a policy (§2). The graph itself stays a DAG *at
the condensation level* — the cyclic-capable machinery lives inside one SCC's
policy, not in the graph.

### 1.4 Adjacent art worth borrowing: incremental computation

DCC dependency graphs are converging with build-system and incremental-compute
technology: Adapton, Rust's Salsa, Shake, Bazel, and Acar's self-adjusting
computation. The idea most under-exploited by rig/shader graphs is **early
cutoff** — if a recomputed value equals its previous value, stop propagating
downstream. It is a large win in ordinary evaluation and doubles as a free
convergence accelerator inside a cycle.

---

## 2. Cycles: are they strictly necessary to solve?

### 2.1 The three policies

Once an SCC is identified there are exactly three options:

1. **Break with a unit delay (z⁻¹).** Choose a back edge; feed it last frame's
   value. Never deadlocks, O(1), fully parallelizable. **~95% of shipping
   software does this.**
2. **Fixed-point iterate the SCC.** Gauss–Seidel over its members until a
   residual falls below tolerance. Converged, framerate-independent, correct —
   when it converges.
3. **Fuse into a monolithic solve.** Delete the nodes; replace with one solver
   handling all constraint sets simultaneously. See §3.

### 2.2 Direct answer: no, not strictly

Any cycle can be cut with a unit delay, yielding a DAG. Nothing deadlocks; a
frame is always produced. What you give up:

- **Latency.** N nodes around the loop → up to N frames of lag.
- **Stability under stiffness.** A delayed feedback loop is an *explicit*
  integrator on the coupling term. Above a stiffness threshold it oscillates,
  then diverges — the classic "IK target driven by cloth draped on the IK'd
  limb" jitter. Converged coupling is implicit in the coupling variable and
  therefore far better behaved.
- **Reproducibility.** Results become a function of framerate, substep count,
  and evaluation order. Scrub the timeline backwards and get a different
  answer. **For an interactive modeling/previz app this is usually the
  disqualifier, not the lag.**
- **Determinism under parallel evaluation.** *Which* stale value is read
  depends on thread interleaving unless double-buffering is rigorous.

**Iteration is genuinely required** for stiff bidirectional coupling,
constraints shared between two solvers, or any loop whose gain approaches 1.
Where coupling is weak (gain ≪ 1 — e.g. secondary jiggle reacting to a pose)
the delay is *indistinguishable* from converged and vastly cheaper. Choosing
per-SCC rather than globally is therefore the correct granularity.

### 2.3 The real blocker: rollback

Usually omitted from discussions of this topic, and the decisive practical
point:

> Fixed-point iteration requires every solver in the SCC to support
> **rollback** — evaluate from a saved state, discard the result, re-evaluate
> from that same state.

A physics solver with a broadphase cache, warm-started contact impulses, an RNG
stream, and a sleeping-body list *cannot cheaply do this*. Making a solver
re-entrant and state-checkpointable is far more invasive than making a graph
iterate. That cost is why the industry picks the delay.

Note that Blender's copy-on-write and Houdini's immutable per-cook geometry
provide this property as a side effect. That is not a coincidence — it is the
same architectural decision viewed from a different angle.

---

## 3. State of the art: fuse the solver

### 3.1 In graphics — unified constraint solvers

The real answer to "cyclical coupling between physics systems" is to stop
having multiple systems. **XPBD** (Macklin et al.), **Projective Dynamics**
(Bouaziz et al.), and NVIDIA **Flex** express everything — rigid bodies, cloth,
soft bodies, fluids, and IK — as constraints in a single global solve, then
Gauss–Seidel/Jacobi iterate the union. Coupling *emerges* from iterating the
whole constraint set; there is no interface to converge and no cycle to detect.
Houdini Vellum, Flex, Ziva, and Unity's unified solver all sit here.

For **IK ↔ dynamics on one skeleton** specifically, reduced-coordinate
articulated-body formulations (Featherstone; MuJoCo, DART, PhysX articulations,
Unreal PhysicsControl) express the IK goal as a constraint inside the same
solve. No cycle, one solve, no drift.

### 3.2 In engineering — converge the interface properly

Where fusion is impossible (separate codes, separate discretizations),
**partitioned co-simulation** is a mature field whose results transfer
directly. `preCICE` is the reference implementation; FMI/FMU is the interface
standard. The relevant techniques:

- **Gauss–Seidel** (serial, faster convergence) vs **Jacobi** (parallel, more
  iterations) coupling schemes.
- **Under-relaxation.** Naive fixed-point on stiff coupling oscillates; ω < 1
  fixes it.
- **Aitken's dynamic relaxation.** Recomputes ω per iteration from residual
  history. Cheap, requires no tuning, a large improvement over fixed ω.
- **IQN-ILS / Anderson acceleration.** Quasi-Newton on the interface residual
  using previous iterates. Current state of the art for strongly coupled
  partitioned solvers; typically 3–5× fewer iterations than relaxed
  fixed-point.
- **Warm-starting** from the previous frame's converged interface values. In
  practice this drops steady-state cost to 1–3 iterations, which is what makes
  converged coupling affordable interactively at all.

---

## 4. Case study: previz IK + rigid-body dynamics

Framing question: *rather than a dedicated IK solver plus a dedicated interface
to Bullet, should Bullet itself solve the IK trees?*

### 4.1 The interface moves down a level; it does not disappear

- **Coupled shape:** poses out → IK solver → poses in → physics step → poses
  out. The boundary carries *results*, bidirectionally, once per frame. That is
  the cycle.
- **Fused shape:** constraints and targets in → one solve → state out. The
  boundary carries *inputs* one way and *solved state* the other.

The win is not fewer components — it is that the boundary stops being
bidirectional.

### 4.2 Assessment of Bullet specifically

The right primitive is `btMultiBody` — Featherstone reduced coordinates, one
articulated body per skeleton, joint DOFs only, no joint separation or drift.
Conceptually well-matched to a rig. Three problems:

1. **`btMultiBody` is the less-maintained half of Bullet.** The
   maximal-coordinate `btRigidBody` path is what is battle-tested; multibody
   constraint coverage is narrower (`btMultiBodyPoint2Point`,
   `btMultiBodyJointMotor`, `btMultiBodyJointLimitConstraint`,
   `btMultiBodyFixedConstraint`, `btMultiBodySliderConstraint`) and less
   exercised. Bullet's development focus moved to PyBullet/robotics; Bullet 3's
   GPU pipeline never landed as a successor, and 2.8x remains what ships.
2. **Sequential-impulse PGS is soft.** Constraints are satisfied approximately,
   with error bled off via Baumgarte/ERP over iterations. An animator dragging
   an effector expects it to *be at* the target, not asymptotically near it.
   Mitigations are high iteration counts or
   `btMultiBodyMLCPConstraintSolver` (Dantzig), which is stiffer but scales
   worse.
3. **It is stateful and time-marched.** Warm-started caches, sleeping bodies,
   path dependence. Frame 200 cannot be evaluated without simulating 1–199 —
   acceptable for physics, hostile to the scrub-and-repose loop previz lives
   in. See also §2.3: this is precisely the rollback problem.

### 4.3 The semantic gap — kinematic vs dynamic IK

|  | Kinematic IK | Dynamic IK |
|---|---|---|
| Signature | `pose = f(targets)` | `pose_t = f(pose_{t-1}, targets, dt)` |
| Scrub to frame 200 | instant, exact | must simulate 1→200 |
| Character | crisp, idempotent, no history | momentum, overshoot, settling |

Previz needs **both**, at different moments. Blocking a pose wants kinematic:
drag a hand, it goes there, no jiggle, scrub anywhere and it is identical.
Secondary motion, impacts, and ragdoll want dynamic.

So the target is not "Bullet solves the IK." It is **one constraint solver that
runs in either mode**, where kinematic IK is the degenerate case: zero
compliance, no inertia, no `dt`, iterate to convergence. XPBD provides exactly
this knob — compliance α = 0 is a hard constraint, α > 0 a spring; dropping
velocity/inertia terms turns the same code into a pure positional solve. This
is why XPBD rather than Bullet is the formulation that recurs in this space.

### 4.4 Recommended decomposition

**Split the physics engine in half and take only the half that is hard to
write.** A physics engine is two libraries bolted together:

- **Collision detection** — broadphase, GJK/EPA/SAT, manifold generation, CCD.
  Tedious, subtle, years of edge cases. **Consume this.** `btCollisionWorld`
  runs standalone without `btDynamicsWorld`; Jolt and PhysX expose the same
  split.
- **Constraint solver** — a few hundred lines of Gauss–Seidel over a constraint
  list. **Own this.** Once owned, adding IK goals, pose targets, joint limits,
  pin constraints, stiffness ramps, and per-constraint compliance is trivial,
  and none of it requires the upstream engine to have anticipated the use case.

That split is the answer to the framing question: not "Bullet solves the IK
trees," but "our solver solves everything, and the engine only reports what is
touching."

### 4.5 If not owning a solver

- **Jolt Physics** — the better engine for this. Actively maintained,
  explicitly designed for cross-platform determinism, and its ragdoll API
  already exposes motor-driven and kinematic pose-following paths, which is
  close to the previz primitive described above.
- **MuJoCo** — the rigorous monolithic option (reduced coordinates, genuine
  inverse dynamics), but its authoring model targets robotics, not artists.
- **Prior art for the general approach** is solid: NaturalMotion's *Euphoria*
  was motor-driven articulated bodies with no separate animation IK at all;
  Blender's *iTaSC* solver is constraint-based IK from the robotics lineage;
  Cascadeur's entire premise is that the posing tools and the physics are the
  same solve.

### 4.6 Effect on the dependency graph

The fused world collapses to **one node**: `SimWorld/step`, with an explicit
`prev_state` input edge. That edge points at a *different time slice*, so it is
not a cycle — the SCC disappears and `Graph._cyclic_exec` never fires for this
case. Everything downstream (skinning → sculpt/multires stack → draw) is
strictly one-directional and remains a clean DAG. Fusion only has to cover the
systems that genuinely feed each other — IK, joints, collision, ragdoll — a
bounded and well-understood set.

### 4.7 The wrinkle that does not go away: scrubbing

Time-marched simulation fights timeline scrubbing regardless of architecture.
The standard answer is a per-frame cache: simulate forward, bake, scrub the
cache, invalidate from the earliest dirty frame. Blender's point cache,
Houdini's DOP cache, and Maya's Nucleus cache all do this. Consequently the
depsgraph edge is really to the **cache**, not the sim, and cache-invalidation
range becomes part of the dirty-propagation model.

---

## 5. Collision detection as a query layer

Requirement driving this section: *some use cases want full CCD with
near-surface repulsion; others want fixed-timestep overlap tests.* That
requirement alone makes consuming an engine's `stepSimulation()` untenable —
engines sell a **pipeline**, owning the loop, the broadphase schedule, the
bounds definition, and the narrowphase output type.

### 5.1 The two regimes differ structurally, not just in cost

| | Discrete overlap | CCD + repulsion |
|---|---|---|
| Broadphase bounds | `AABB(x₁)`, temporally coherent | `AABB(x₀) ∪ AABB(x₁)`, dilated by thickness `h` |
| Narrowphase | GJK/EPA, SAT, or SDF lookup | point–triangle and edge–edge over swept trajectories |
| Output | contact **manifold** (points, normal, depth) | **time-ordered impulses** / TOI values |
| Penetration | allowed, corrected after the fact | never allowed, prevented before the fact |
| Enters solver as | non-penetration constraint with compliance | hard constraint at TOI, or a step-size clamp |
| Fails by | tunneling, popping | numerical misses → explosion or lock-up |

Two different broadphase bound definitions and two different narrowphase return
types. No single engine pipeline serves both without one being second-class.

### 5.2 What "CCD + near-surface repulsion" is

The Bridson–Fedkiw–Anderson (2002) cloth pipeline. The ordering is
load-bearing:

1. **Repulsion pass** at thickness `h` — point–triangle and edge–edge
   *distance* queries within `h`, resolved with spring/inelastic impulses.
   Cheap; does 90–95% of the work. Its real job is keeping the CCD pass sparse.
2. **CCD pass** — for the survivors, find the earliest time of impact over
   linear vertex trajectories. For triangle meshes there are exactly two tests,
   point–triangle and edge–edge, both over four vertices, classically a cubic
   coplanarity root-find plus a barycentric containment check at the root.
3. **Rigid impact zones** — the failsafe. Any vertex cluster still unresolved
   is frozen into a single rigid body for the remainder of the step. Guarantees
   termination *and* intersection-freedom, which is the entire point of the
   pipeline. Not optional in this formulation; it is the stage people skip and
   then spend a year debugging.

### 5.3 The trap: do not hand-roll the cubic

Naive `float` cubic root-finding for CCD **misses collisions** — not rarely,
and not only in contrived cases. Wang & Ferguson et al.'s 2021 benchmark found
false negatives in most published and shipping CCD implementations. One missed
TOI in a cloth step produces an intersection, and intersections are
unrecoverable: the mesh stays tangled permanently.

The lineage, so the choice can be made deliberately:

| Method | Character |
|---|---|
| Brochu & Bridson (2012) | Exact geometric predicates (adaptive precision). Correct, slow. |
| TightCCD (Tang et al.) | Conservative via Bernstein sign classification. Fast, some false positives. |
| **Tight-Inclusion CCD** (Wang et al. 2021) | Current state of the art. Conservative *and* tight, with a provable floating-point error bound. Used by IPC and descendants. |
| **ACCD — Additive CCD** (Li et al., C-IPC 2021) | **Start here.** Conservative *advancement*: no root-finding at all. Iteratively advance by a step bounded by (current distance)/(max relative approach speed) until within tolerance. ~30 lines, conservative by construction, very hard to get catastrophically wrong. |

Write ACCD first. Reach for TICCD only if profiling shows the tightness
matters; marginally looser bounds cost a few extra solver iterations and
nothing else.

### 5.4 The reframe worth stealing: CCD as a step-size filter

Incremental Potential Contact (Li et al. 2020) inverted the usual formulation.
Instead of *detect collision → apply corrective impulse*, IPC treats contact as
a smooth barrier potential and uses CCD purely as a **line-search step-size
limiter**: propose a position update, ask CCD for the largest fraction of it
that remains intersection-free, take that. The configuration is never invalid,
so there is nothing to recover from — no impact zones, no tuned repulsion
stiffness.

Full IPC is too heavy for previz (Newton solve, barrier stiffness
continuation). But the idea drops straight into an XPBD loop: after computing
the positional update for a substep, clamp it by the earliest TOI across active
pairs. That buys intersection-freedom for roughly one extra CCD query per
substep and **deletes stage 3 of the Bridson pipeline entirely**. For a system
that already owns its solver, this is a very favourable trade and is the single
most valuable idea in this document for the collision layer.

### 5.5 API shape

Collision as a service with an explicit, caller-driven schedule and per-system
policy:

```
// structure — refit, not rebuild
world.refit(x0, x1, margin)          // margin = 0 discrete; = h for CCD

// queries — systems call what they need, when they need it
world.overlap(aabb)             -> pairs
world.distanceWithin(pair, h)   -> closest points, normal, distance   // repulsion
world.toi(pair, x0, x1)         -> t ∈ [0,1] | none                   // CCD
world.raycast(origin, dir)      -> hit
```

Each system declares a policy — `{ discrete }` or
`{ repulsion: h, ccd: accd }` — and the solver assembles constraints from
whichever queries that policy names. Contacts become entries in the *same*
constraint list as IK goals and joint limits, which is precisely why owning the
solver is what unlocks this.

### 5.6 Two implementation notes that cost weeks

- **Refit, do not rebuild.** BVH refit is O(n) and preserves the tree. Track
  SAH cost degradation and rebuild only when the ratio crosses a threshold;
  deforming cloth can go hundreds of frames between rebuilds.
- **Self-collision needs an adjacency filter.** Traversing the tree against
  itself reports every triangle against its own neighbours. Skip pairs sharing
  a vertex or edge. Getting this wrong makes cloth mysteriously sticky along
  seams, which presents as a solver bug and is not one.

---

## 6. Assessment of the current codebase

### 6.1 `Graph._cyclic_exec` — verified by reading `scripts/core/graph.ts`

The graph already implements policy #2 (fixed-point iteration), which is *ahead
of Maya and Blender in intent* — both merely warn. Current shape:

- `Graph.sort()` (`graph.ts:1520`) performs cycle detection, sets
  `GraphFlags.CYCLIC`, and warns; a second `cyclesearch` pass
  (`graph.ts:1571`) catches cases the first missed.
- `Graph.exec()` (`graph.ts:1678`) throws unless `CYCLIC_ALLOWED` is set,
  otherwise dispatches to `_cyclic_exec`.
- `_cyclic_exec` (`graph.ts:1650`) snapshots all sockets, then loops
  `max_cycle_steps` (64, `graph.ts:1372`) calling `_cyclic_step`, breaking when
  the residual falls under `cycle_stop_threshold` (0.0005, `graph.ts:1373`).

Four gaps if this is to carry real solver↔solver feedback:

1. **It is global, not per-SCC.** One cycle anywhere promotes the *entire*
   `sortlist` into a 64-iteration loop (`graph.ts:1665`). Tarjan-condense
   instead and iterate only the SCC, evaluating the rest of the condensation
   DAG exactly once. This is the highest-value change, and it is also what
   makes allowing cycles by default affordable.
2. **No relaxation.** `_cyclic_step` is bare Gauss–Seidel. Aitken relaxation on
   the SCC's interface sockets is ~20 lines and converts "oscillates for 64
   iterations then gives up" into "converges in 4." See §3.2.
3. **The residual is an unnormalized absolute sum.** `change += diff`
   (`graph.ts:1640`), with the `tot` normalization commented out, against a
   fixed 0.0005 threshold. Convergence criteria therefore scale silently with
   cycle size and with unit choice — a position socket in metres and one in
   radians are not comparable. Normalize per-socket; prefer a relative
   residual.
4. **No rollback contract.** Nodes are re-`exec`'d in place. Any node holding
   internal state — precisely the physics/IK solvers this document is about —
   accumulates across iterations rather than re-deriving. `Node.exec` needs a
   documented "may be called repeatedly from the same input state" guarantee,
   and stateful nodes need save/restore around the loop. This is §2.3 arriving
   concretely.

Before any of the above: determine whether existing cycles are **real value
cycles or false cycles from coarse nodes**. Splitting a solver node into
`inputs → solve → outputs` sub-operations, Blender-style (§1.2), tends to
eliminate a surprising number of them at zero numerical cost.

### 6.2 Existing collision-relevant primitives

Located by grep; **contents not read**, so capability is unverified:

| Path | Apparent role |
|---|---|
| `sculptcore/source/spatial/spatial.{h,cc}` | Spatial acceleration structure over the mesh; matched refit-related identifiers |
| `sculptcore/source/mesh/utils/closest_point.h` | Narrowphase distance primitives |
| `sculptcore/source/litestl/math/geom.h` | Geometry predicates |
| `addons/builtin/mesh/src/bvh.ts` | TS-side BVH |

**Open question to resolve first:** does `spatial`'s update path support
**refit against dilated swept bounds** as a mode distinct from its
sculpt-oriented rebuild? Sculpt BVHs are typically tuned for ray queries and
region selection over slowly-changing topology — a different access pattern
from per-frame full-mesh deformation. This is the piece most likely to need
real work; the rest is largely re-pointing existing code at a new caller.

---

## 7. Recommendations

Ordered by value-per-unit-effort, not by dependency.

1. **Split solver nodes to operation granularity** before doing anything
   numerical. Cheapest possible fix; deletes false cycles outright. (§1.2)
2. **Make `_cyclic_exec` per-SCC.** Tarjan condensation, iterate only within an
   SCC. Removes the global-promotion penalty that currently makes cycles
   expensive. (§6.1)
3. **Normalize the convergence residual** and add Aitken relaxation. Together
   ~40 lines for a large robustness gain. (§6.1, §3.2)
4. **Define a rollback contract on `Node.exec`** before introducing any
   stateful solver node. Retrofitting this later is the expensive path. (§2.3)
5. **Own the constraint solver; consume only collision detection.** XPBD-style,
   compliance-parameterized, so kinematic IK and dynamics are the same code
   at different settings. (§4.4, §4.3)
6. **Build the collision layer as queries, not a pipeline**, with per-system
   policy. Implement ACCD first. (§5.5, §5.3)
7. **Adopt CCD-as-step-limiter** inside the XPBD loop rather than the classical
   repulsion/CCD/impact-zone stack. (§5.4)
8. **Plan the simulation cache early** — the depsgraph edge is to the cache,
   not the sim. (§4.7)

---

## 8. References

Cited by author/title/year; none fetched or verified in this pass.

**Coupling and constraint solvers**
- Macklin, Müller, Chentanez — *XPBD: Position-Based Simulation of Compliant
  Constrained Dynamics* (2016)
- Bouaziz, Martin, Liu, Kavan, Pauly — *Projective Dynamics* (2014)
- Featherstone — *Rigid Body Dynamics Algorithms* (2008)
- preCICE — coupling library; FMI/FMU co-simulation standard
- Aitken dynamic relaxation; IQN-ILS / Anderson acceleration (FSI literature)

**Collision detection**
- Bridson, Fedkiw, Anderson — *Robust Treatment of Collisions, Contact and
  Friction for Cloth Animation* (SIGGRAPH 2002)
- Provot — *Collision and Self-Collision Handling in Cloth Model* (1997)
- Brochu, Edwards, Bridson — *Efficient Geometrically Exact Continuous
  Collision Detection* (2012)
- Tang et al. — *TightCCD* (2014)
- Wang, Ferguson et al. — *A Large-scale Benchmark and an Inclusion-based
  Algorithm for Continuous Collision Detection* (TOG 2021) — Tight-Inclusion CCD
- Li, Ferguson, Schneider, Langlois, Zorin, Panozzo, Jiang, Kaufman —
  *Incremental Potential Contact* (SIGGRAPH 2020)
- Li, Kaufman, Jiang — *Codimensional Incremental Potential Contact* (2021) —
  introduces ACCD

**Incremental computation**
- Acar — self-adjusting computation; Adapton; Salsa (Rust); Shake

**Engines and systems referenced**
- Bullet (`btMultiBody`, `btMultiBodyMLCPConstraintSolver`), Jolt Physics,
  PhysX articulations, MuJoCo, DART, NVIDIA Flex, Houdini Vellum
- Maya Evaluation Manager; Blender depsgraph (2.8+) and iTaSC; Houdini Solver
  SOP; Unreal AnimGraph / PhysicsControl; NaturalMotion Euphoria; Cascadeur
