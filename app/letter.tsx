'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  identity,
  multiply,
  perspective,
  rotationX,
  rotationY,
  transformPoint,
  translation,
} from '@/lib/mat4'

/**
 * The letters, and there is nothing else on the stage.
 *
 * They stand in a row, the front one live and the rest falling back behind it.
 * How far the flap is open and how far the sheet has come out is how far that
 * run has actually got, so a glance across the stack tells you which letter is
 * stuck without reading a number.
 *
 * Three things are written on the object, each shaped like what it is:
 *
 *   the name       on the address line, because that is what an envelope carries
 *   the status     on the stamp, because a postmark records where post has got to
 *   the action     a button under the letter, because a button is what acts
 *
 * The first two are HTML pinned to their projected positions on the face every
 * frame — text stays crisp and reachable, and none of it has to be redone in a
 * shader. The stamp used to hold the action instead, which made the only
 * control on the object look like stationery and left the status printed twice.
 *
 * Raw WebGL2 on purpose. This is three meshes and one light.
 */

const VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUv;
in float aKind;

uniform mat4 uMVP;
uniform mat4 uModel;

out vec3 vNormal;
out vec3 vWorld;
out vec2 vUv;
out float vKind;

void main() {
  // uModel carries rotation and translation only, never scale, so the normal
  // matrix is just its upper 3×3 — no inverse-transpose needed.
  vNormal = mat3(uModel) * aNormal;
  vWorld = (uModel * vec4(aPos, 1.0)).xyz;
  vUv = aUv;
  vKind = aKind;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorld;
in vec2 vUv;
in float vKind;

uniform vec3 uPrimary;
uniform vec3 uPaper;
uniform vec3 uCamera;
uniform float uAmbient;
uniform float uRim;
uniform float uFade;
uniform float uCode;

out vec4 outColour;

float rect(vec2 p, vec2 a, vec2 b) {
  vec2 s = step(a, p) * step(p, b);
  return s.x * s.y;
}

/* The franking: twelve bars, tall or short by one bit of the letter's code
   each, struck under the address. It is how you tell one letter from another
   across the stack without reading anything, and it is what a real envelope
   would carry — machines have always sorted post by printed bars. */
float franking(vec2 uv, float code) {
  const float BARS = 12.0;
  float t = (uv.x - 0.14) / 0.46;
  if (t < 0.0 || t > 1.0) return 0.0;
  if (fract(t * BARS) > 0.45) return 0.0;
  float bit = mod(floor(code / pow(2.0, floor(t * BARS))), 2.0);
  return rect(uv, vec2(0.0, 0.150), vec2(1.0, 0.150 + (bit > 0.5 ? 0.058 : 0.031)));
}

float hash(float n) {
  return fract(sin(n * 78.233) * 43758.5453);
}

/* Ruled writing: rows of varying length, which is what text looks like from
   far enough away that you cannot read it. Cheaper and calmer than a texture. */
float writing(vec2 uv, float top, float rows) {
  float f = (top - uv.y) * rows;
  float row = floor(f);
  float thick = step(fract(f), 0.34);
  float len = 0.40 + 0.44 * hash(row);
  float inX = step(0.10, uv.x) * step(uv.x, 0.10 + len);
  return thick * inX * step(0.0, row) * step(row, rows * 0.72);
}

void main() {
  // Single-sided geometry lit from both sides. Two coplanar faces with opposite
  // normals would sit at identical depth, and the second would lose the depth
  // test — the back of the sheet went flat and shimmered at glancing angles.
  vec3 N = normalize(vNormal);
  bool front = gl_FrontFacing;
  if (!front) N = -N;

  vec3 base;

  if (vKind > 1.5) {
    // The face of the envelope — where the address and the stamp go. Both are
    // struck in the secondary, which is the only other colour in this app.
    base = uPrimary;
    // Nothing is drawn on the face but the franking.
    //
    // The address was three abstract bars and the stamp was an outlined box,
    // and both were replaced by real HTML text pinned to the same spots. Each
    // time one was left behind it put a white shape straight through the white
    // words that had replaced it — the address bars struck through the name,
    // and the stamp box swallowed the status. The franking stays because it is
    // a barcode rather than writing, and nothing is written over it.
    float mark = clamp(franking(vUv, uCode) * 0.95, 0.0, 1.0);
    base = mix(base, uPaper, mark);
  } else if (vKind > 0.5) {
    // The sheet itself. Written on one side, blank on the other.
    base = uPaper;
    if (front) {
      float head = rect(vUv, vec2(0.10, 0.855), vec2(0.36, 0.925));
      base = mix(base, uPrimary, head);
      base = mix(base, uPaper * 0.55, writing(vUv, 0.80, 22.0) * 0.85);
    }
  } else {
    // Plain stock. The underside of the flap is the same paper in its own shade.
    base = front ? uPrimary : uPrimary * 0.72;
  }

  // Lit in sRGB rather than linear. Working linear without an sRGB framebuffer
  // to convert back through renders the brand red several shades too dark, and
  // this object is the brand before it is a physical simulation.
  vec3 V = normalize(uCamera - vWorld);
  vec3 L = normalize(vec3(-0.30, 0.65, 0.75));

  float diffuse = max(dot(N, L), 0.0);
  float specular = pow(max(dot(N, normalize(L + V)), 0.0), 48.0) * 0.16;
  // A light edge is what separates a dark object from a dark ground, and a
  // dark edge is what separates a pale object from a pale one. Same term.
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * uRim;

  vec3 colour = base * (uAmbient + diffuse * 0.85) + specular + rim * base;

  // Near-flat gradients band on 8-bit displays; a sub-LSB of noise costs
  // nothing and is the difference between a surface and a set of stripes.
  colour += (hash(gl_FragCoord.x + gl_FragCoord.y * 1731.0) - 0.5) / 255.0;

  outColour = vec4(colour, uFade);
}`

/* ── geometry ──────────────────────────────────────────────────────────────
   Nine floats a vertex: position, normal, uv, and which surface it is. Built
   once at module load — every letter is the same shape. */

function quad(
  out: number[],
  a: number[],
  b: number[],
  c: number[],
  d: number[],
  n: number[],
  kind: number,
) {
  const corners = [
    [a, [0, 0]],
    [b, [1, 0]],
    [c, [1, 1]],
    [a, [0, 0]],
    [c, [1, 1]],
    [d, [0, 1]],
  ] as const
  for (const [p, uv] of corners) out.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], kind)
}

const W = 1.9
const H = 1.0
const D = 0.05
const FLAP = 0.46
/**
 * Where the addressee is written, in uv — the left end of the name line, and
 * the right end of it. Two points rather than one, because the distance
 * between them on screen is what tells the label how big to be: text held at
 * 15px while the object it names grows is the thing that reads as broken.
 */
const ADDRESS = [0.14, 0.437]
const ADDRESS_END = [0.62, 0.437]

/** Where the stamp sits on the face, in uv. The postmark is pinned here. */
const STAMP = [0.875, 0.812]

/** The bottom edge, centre. The action button hangs just below this. */
const FOOT = [0.5, 0.0]

function envelopeMesh() {
  const x = W / 2
  const y = H / 2
  const z = D / 2
  const out: number[] = []
  // The front carries the address, so it is its own surface; the rest is plain
  // stock. Winding is counter-clockwise seen from outside, so back faces cull.
  quad(out, [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1], 2)
  quad(out, [x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1], 0)
  quad(out, [x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], [1, 0, 0], 0)
  quad(out, [-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], [-1, 0, 0], 0)
  quad(out, [-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], [0, 1, 0], 0)
  quad(out, [-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, -1, 0], 0)
  return new Float32Array(out)
}

/** One triangle, hinged at the origin. The shader lights whichever side shows. */
function flapMesh() {
  const x = W / 2
  const out: number[] = []
  const push = (p: number[], uv: number[]) =>
    out.push(p[0], p[1], p[2], 0, 0, 1, uv[0], uv[1], 0)
  push([-x, 0, 0], [0, 1])
  push([0, -FLAP, 0], [0.5, 0])
  push([x, 0, 0], [1, 1])
  return new Float32Array(out)
}

/** One quad, likewise. */
function paperMesh() {
  const x = (W - 0.16) / 2
  const y = (H - 0.08) / 2
  const out: number[] = []
  quad(out, [-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0], [0, 0, 1], 1)
  return new Float32Array(out)
}

const MESHES = [envelopeMesh(), flapMesh(), paperMesh()]

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader))
    return null
  }
  return shader
}

const rgb = (value: string): [number, number, number] => {
  const n = parseInt(value.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** A three-quarter view: the face readable, the thickness visible. */
const REST_YAW = -0.34
const REST_PITCH = 0.16
/** Vertical gap between letters. Roughly a letter and a half, so the one
 *  behind is legible without crowding the one in front. */
const SPACING = 1.45

/** The camera's vertical field of view. Named because the framing maths needs it. */
const FOV = Math.PI / 5.2
/** More than this either side of the front is behind the ones you can see. */
const NEIGHBOURS = 3
/** A press that moves less than this many pixels was a click, not a drag. */
const SLOP = 6

/**
 * Where a flick is going, not where it was released.
 *
 * Apple's projection from Designing Fluid Interfaces: exponential decay, not
 * the textbook v²/2a. Snapping from the release point makes a hard flick feel
 * identical to a slow drag; projecting means a throw actually throws.
 */
const project = (velocity: number, deceleration = 0.998) =>
  (velocity / 1000) * (deceleration / (1 - deceleration))

/**
 * Resistance past the ends, rather than a wall.
 *
 * A hard stop reads as frozen — as if the app stopped listening. Continuous
 * resistance reads as "still responding, but there is nothing more here".
 */
const rubberband = (overshoot: number, dimension = 1, constant = 0.55) =>
  (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))

const clamp = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high)

/** How many dots the scrubber shows before it starts windowing. */
const DOTS = 21

/**
 * The slice of the stack the scrubber draws.
 *
 * Everything up to `DOTS`; past that, a window centred on where you are and
 * held inside the ends, so the dots stay a fixed height instead of growing
 * with the stack and running off the stage.
 */
function window_<T>(all: T[], active: number) {
  const start =
    all.length <= DOTS ? 0 : clamp(active - (DOTS >> 1), 0, all.length - DOTS)
  return all
    .slice(start, start + Math.min(DOTS, all.length))
    .map((card, i) => ({ card, index: start + i }))
}

export type Card = {
  id: string
  name: string
  /** 0 sealed, 1 fully drawn out. The share of this run that has been posted. */
  progress: number
  /** Where this letter is in its life: draft, sending, paused, done. */
  status: string
  /** What this letter needs next. */
  mark: string
  /** The number struck on the mark. Zero shows no number. */
  count: number
  /** Where the mark goes — the step that does the thing. */
  markHref: string
  /** Where the letter itself goes when you open it. */
  href: string
  /** Its franking, from lib/rules.ts. Two letters never look the same. */
  code: number
}

export default function Letter({
  cards,
  openId,
  listed = false,
  shift = 0,
}: {
  cards: Card[]
  /** The letter the URL says is unfolded, if any. */
  openId?: string
  /** The stack has been turned into a list, so it stands back out of the way. */
  listed?: boolean
  /** Where the stack stands, in world units, so a panel can sit beside it
   *  rather than on top of it. Eased, so the letters walk across. */
  shift?: number
}) {
  const router = useRouter()
  const canvas = useRef<HTMLCanvasElement>(null)
  const markEl = useRef<HTMLDivElement>(null)
  const nameEl = useRef<HTMLDivElement>(null)
  const actionEl = useRef<HTMLDivElement>(null)

  const at = Math.max(
    cards.findIndex((card) => card.id === openId),
    0,
  )
  const [active, setActive] = useState(at)
  const here = cards[Math.min(active, cards.length - 1)]

  // The URL is still the authority on which letter is open; the stack only
  // decides which one you are looking at when none is.
  useEffect(() => {
    if (openId) setActive(at)
  }, [openId, at])

  // Everything the frame loop reads. Kept in a ref so new server data eases the
  // letters to their new state instead of tearing down the GL context.
  const live = useRef({ cards, active, unfolded: Boolean(openId) || listed, shift })
  useEffect(() => {
    live.current = { cards, active, unfolded: Boolean(openId) || listed, shift }
  }, [cards, active, openId, listed, shift])

  const go = useRef<(to: 'open' | 'mark') => void>(() => {})
  useEffect(() => {
    go.current = (to) => {
      const card = live.current.cards[live.current.active]
      if (!card) return
      // An empty target means this letter is not a way in — the sealed one on
      // the sign-in screen, which is there to be turned over and nothing else.
      // Unfolded, the letter itself is the way back out to the stack.
      const target = to === 'mark' ? card.markHref : live.current.unfolded ? '/' : card.href
      if (target) router.push(target)
    }
  }, [router])

  const step = useRef<(by: number) => void>(() => {})
  useEffect(() => {
    step.current = (by) =>
      setActive((n) => Math.min(Math.max(n + by, 0), Math.max(cards.length - 1, 0)))
  }, [cards.length])

  useEffect(() => {
    const surface = canvas.current
    if (!surface) return

    // No WebGL2 — the stage is already the right colour, so the app simply has
    // an empty stage instead of a lit one. Nothing else changes.
    const gl = surface.getContext('webgl2', { antialias: true, alpha: true })
    if (!gl) return

    const vert = compile(gl, gl.VERTEX_SHADER, VERT)
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vert || !frag) return

    const program = gl.createProgram()!
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program))
      return
    }
    gl.useProgram(program)

    const parts = MESHES.map((data) => {
      const vao = gl.createVertexArray()!
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
      for (const [name, size, offset] of [
        ['aPos', 3, 0],
        ['aNormal', 3, 12],
        ['aUv', 2, 24],
        ['aKind', 1, 32],
      ] as const) {
        // -1 means the compiler dropped it. Enabling that throws, which would
        // take the whole letter out over an attribute nothing reads.
        const loc = gl.getAttribLocation(program, name)
        if (loc < 0) continue
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 9 * 4, offset)
      }
      gl.bindVertexArray(null)
      return { vao, count: data.length / 9 }
    })

    const u = (name: string) => gl.getUniformLocation(program, name)
    const uMVP = u('uMVP')
    const uModel = u('uModel')
    const uCamera = u('uCamera')
    const uFade = u('uFade')
    const uCode = u('uCode')

    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
    gl.uniform3fv(u('uPrimary'), rgb('#d92819'))
    gl.uniform3fv(u('uPaper'), rgb('#ffffff'))

    // The letters are the same red in both rooms — that is the brand, not a
    // surface. Only the light around them changes.
    const readTheme = () => {
      const set = document.documentElement.dataset.theme
      const light = set ? set === 'light' : !window.matchMedia('(prefers-color-scheme: dark)').matches
      gl.uniform1f(u('uAmbient'), light ? 0.6 : 0.3)
      gl.uniform1f(u('uRim'), light ? 0.1 : 0.5)
    }
    readTheme()
    const themeWatch = new MutationObserver(readTheme)
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', readTheme)

    let projection = identity()
    let width = 1
    let height = 1
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, 2)
      width = Math.max(surface.clientWidth, 1)
      height = Math.max(surface.clientHeight, 1)
      const w = Math.floor(width * dpr)
      const h = Math.floor(height * dpr)
      // Assigning width or height reallocates the drawing buffer even when the
      // value is unchanged, and the observer fires far more often than the size
      // really moves.
      if (w !== surface.width || h !== surface.height) {
        surface.width = w
        surface.height = h
        gl.viewport(0, 0, w, h)
      }
      projection = perspective(FOV, width / height, 0.1, 60)
    }
    const box = new ResizeObserver(resize)
    box.observe(surface)
    resize()

    /* ── holding them ────────────────────────────────────────────────────── */

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let yaw = REST_YAW
    let pitch = REST_PITCH
    let spin = 0
    let tilt = 0
    let opened = 0
    let shown = live.current.active
    let unfold = live.current.unfolded ? 1 : 0
    let placed = live.current.shift

    let dragging = false
    let hovering = false
    // Deltas are banked here and spent once a frame. Reading them straight out
    // of the pointer handler means a held-still finger keeps applying whatever
    // the last move was, and the letter turns on its own under your thumb.
    let bankedYaw = 0
    let bankedPitch = 0
    let travelled = 0
    let last = { x: 0, y: 0 }
    let wheelLock = 0
    // Dragging vertically walks the stack 1:1 rather than turning the letter:
    // the content follows the finger, which is the whole of direct manipulation.
    let scrub = 0
    // Cards per second, measured off the pointer's own timestamps — the frame
    // delta is not available in a pointer handler, and using it would measure
    // the wrong interval anyway.
    let scrubVelocity = 0
    let lastMoveAt = 0

    const onDown = (event: PointerEvent) => {
      dragging = true
      travelled = 0
      spin = 0
      tilt = 0
      // Grabbing a moving stack stops it dead, then follows the finger. Any
      // animation must be interruptible at the instant it is touched.
      scrub = live.current.active
      scrubVelocity = 0
      lastMoveAt = event.timeStamp
      last = { x: event.clientX, y: event.clientY }
      surface.setPointerCapture(event.pointerId)
      surface.style.cursor = 'grabbing'
    }

    const onMove = (event: PointerEvent) => {
      if (!dragging) return
      const dx = event.clientX - last.x
      const dy = event.clientY - last.y
      travelled += Math.abs(dx) + Math.abs(dy)

      // Sideways turns the object; vertical moves through the stack. Deciding
      // per-frame on the dominant axis keeps both available without a mode.
      if (Math.abs(dx) > Math.abs(dy)) {
        bankedYaw += dx * 0.006
      } else {
        const step = -dy / 260
        scrub += step
        const elapsed = event.timeStamp - lastMoveAt
        if (elapsed > 0 && elapsed < 120) scrubVelocity = (step / elapsed) * 1000
      }
      bankedPitch += dy * 0.001
      lastMoveAt = event.timeStamp
      last = { x: event.clientX, y: event.clientY }
    }

    const onUp = (event: PointerEvent) => {
      if (!dragging) return
      dragging = false
      // Losing the capture already released it; asking again throws.
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
      surface.style.cursor = 'grab'
      if (travelled < SLOP && event.type === 'pointerup') return go.current('open')

      // Land where the flick was going, not where the finger left. Projection
      // is what makes a throw travel further than a nudge, and it is why the
      // stack can be flicked through rather than stepped one at a time.
      const last = Math.max(live.current.cards.length - 1, 0)
      const landed = Math.round(Math.min(Math.max(scrub + project(scrubVelocity), 0), last))
      step.current(landed - live.current.active)
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        return step.current(-1)
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        return step.current(1)
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        go.current('open')
      }
    }

    // Up and down, never sideways.
    //
    // A two-finger horizontal swipe on macOS *is* the browser's back gesture,
    // and preventDefault does not reliably win it — flicking through letters
    // would navigate the history instead. Going vertical sidesteps that rather
    // than fighting it, and a vertical stack is already a list, which is what
    // the list view then shows you head-on.
    //
    // Locked briefly after each step so one flick does not skip four letters.
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || Math.abs(event.deltaY) < 8) return
      event.preventDefault()
      const now = performance.now()
      if (now < wheelLock) return
      wheelLock = now + 240
      step.current(event.deltaY > 0 ? 1 : -1)
    }

    const onEnter = () => (hovering = true)
    const onLeave = () => (hovering = false)

    surface.addEventListener('pointerdown', onDown)
    surface.addEventListener('pointermove', onMove)
    surface.addEventListener('pointerup', onUp)
    surface.addEventListener('pointercancel', onUp)
    surface.addEventListener('keydown', onKey)
    surface.addEventListener('wheel', onWheel, { passive: false })
    surface.addEventListener('pointerenter', onEnter)
    surface.addEventListener('pointerleave', onLeave)

    /* ── drawing them ────────────────────────────────────────────────────── */

    // Every easing below is in units of one 60Hz frame, then corrected by how
    // long the frame actually took. Without that they settle twice as fast on a
    // 120Hz display as on a 60Hz one.
    const ease = (from: number, to: number, rate: number, dt: number) =>
      from + (to - from) * (1 - Math.pow(1 - rate, dt))

    let previous = performance.now()

    function draw(now: number) {
      const dt = Math.min((now - previous) / 16.667, 4)
      previous = now
      const { cards: deck, active: want, unfolded, shift: wantShift } = live.current

      unfold = still ? (unfolded ? 1 : 0) : ease(unfold, unfolded ? 1 : 0, 0.09, dt)

      if (dragging) {
        // 1:1 with the finger, with progressive resistance past either end so
        // the boundary feels like resistance rather than a frozen app.
        const last = deck.length - 1
        shown =
          scrub < 0
            ? rubberband(scrub)
            : scrub > last
              ? last + rubberband(scrub - last)
              : scrub
      } else {
        shown = still ? want : ease(shown, want, 0.12, dt)
      }
      placed = still ? wantShift : ease(placed, wantShift, 0.08, dt)

      if (dragging) {
        yaw += bankedYaw
        pitch = Math.min(Math.max(pitch + bankedPitch, -0.7), 0.7)
        if (dt > 0) {
          // Carry the last frame's speed into the throw.
          spin = bankedYaw / dt
          tilt = bankedPitch / dt
        }
        bankedYaw = 0
        bankedPitch = 0
      } else {
        yaw += spin * dt
        pitch = Math.min(Math.max(pitch + tilt * dt, -0.7), 0.7)
        spin *= Math.pow(0.93, dt)
        tilt *= Math.pow(0.88, dt)
        // Settles back to a readable three-quarter view rather than turning for
        // ever. The mark is a click target now; a target that drifts is a
        // target you have to chase.
        const restYaw = REST_YAW * (1 - unfold)
        const restPitch = REST_PITCH * (1 - unfold)
        yaw = ease(yaw, restYaw, unfold > 0.01 ? 0.08 : 0.012, dt)
        pitch = ease(pitch, restPitch, unfold > 0.01 ? 0.08 : 0.02, dt)
      }

      const front = deck[Math.round(shown)]
      const target = front ? front.progress : 0
      const wanted = Math.min(target + (hovering && !dragging && !unfolded ? 0.12 : 0), 1)
      opened = still ? wanted : ease(opened, wanted, 0.06, dt)

      // Unfolding pushes the neighbours out of frame and brings the front one
      // square to the camera, so the panel arrives over an object already in
      // the right place.
      const spacing = SPACING + unfold * 4

      // Stand back far enough to actually hold what is on screen.
      //
      // The sheet climbs out of the envelope as the run progresses — up to
      // 0.92 of a letter's height — and the camera only ever pulled back for
      // *unfolding*, which is a different thing entirely. So a letter near the
      // end of its run pushed its own contents off the top of the stage, and
      // no amount of resizing the window helped, because the framing never
      // knew the sheet had moved.
      //
      // Distance is derived from what is actually there rather than tuned by
      // hand: half-height over tan(fov/2) is the distance that just fits it,
      // and FIT is the air around it.
      const FIT = 1.14
      const reach = Math.max(H / 2, (H - 0.08) / 2 + opened * H * 0.92)
      const span = Math.max(W / 2, (W - 0.16) / 2) / Math.max(width / height, 0.1)
      const back =
        Math.max(3.5, (Math.max(reach, span) / Math.tan(FOV / 2)) * FIT) + unfold * 0.35

      // And look at the middle of it, not at the envelope.
      // The content runs from the envelope's bottom edge to the top of the
      // risen sheet, so its centre climbs as the sheet does. Framing on the
      // envelope alone leaves the whole thing riding high with dead space
      // under it — correct, but it reads as badly placed.
      const middle = (reach - H / 2) / 2
      const view = translation(0, -middle, -back)

      gl!.uniform3f(uCamera, 0, 0, back)
      gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT)

      let markScreen: { x: number; y: number; on: boolean } = { x: 0, y: 0, on: false }
      let nameScreen: { x: number; y: number; w: number; on: boolean } = {
        x: 0,
        y: 0,
        w: 0,
        on: false,
      }
      let footScreen: { x: number; y: number; on: boolean } = { x: 0, y: 0, on: false }
      const first = Math.max(Math.round(shown) - NEIGHBOURS, 0)
      const lastCard = Math.min(Math.round(shown) + NEIGHBOURS, deck.length - 1)

      for (let i = first; i <= lastCard; i++) {
        const rel = i - shown
        const away = Math.min(Math.abs(rel), 1)
        // Behind the front one, and turned back to a common pose, so the stack
        // reads as a stack rather than a row of identical objects.
        const model = multiply(
          translation(placed, -rel * spacing, -Math.abs(rel) * 0.85),
          multiply(rotationY(yaw * (1 - away) + REST_YAW * away), rotationX(pitch * (1 - away))),
        )
        const lid = opened * (1 - away)
        const models = [
          model,
          // A hair proud of the face it closes onto, or the two co-planar
          // surfaces fight for the same depth and the flap tears as it turns.
          multiply(model, multiply(translation(0, H / 2, D / 2 + 0.002), rotationX(lid * 2.25))),
          multiply(model, translation(0, lid * H * 0.92, -0.004)),
        ]

        gl!.uniform1f(uFade, 1 - Math.min(Math.abs(rel) / (NEIGHBOURS + 0.6), 1))
        gl!.uniform1f(uCode, deck[i].code)

        parts.forEach((part, p) => {
          if (p === 2 && lid < 0.02) return // the sheet is still inside
          gl!.uniformMatrix4fv(uModel, false, models[p])
          gl!.uniformMatrix4fv(uMVP, false, multiply(projection, multiply(view, models[p])))
          gl!.bindVertexArray(part.vao)
          // The flap and the sheet are single surfaces, seen from both sides.
          if (p === 0) gl!.enable(gl!.CULL_FACE)
          else gl!.disable(gl!.CULL_FACE)
          gl!.drawArrays(gl!.TRIANGLES, 0, part.count)
        })

        // Where the stamp landed on screen, for the button that sits on it.
        if (Math.abs(rel) < 0.5) {
          const sx = (STAMP[0] - 0.5) * W
          const sy = (STAMP[1] - 0.5) * H
          const clip = transformPoint(
            multiply(projection, multiply(view, model)),
            sx,
            sy,
            D / 2,
          )
          const world = transformPoint(model, sx, sy, D / 2)
          const normal = transformPoint(model, 0, 0, 1)
          // The face has to be pointing at you, or the mark would show through
          // the back of the envelope.
          const facing =
            (normal[0] - model[12]) * (0 - world[0]) +
            (normal[1] - model[13]) * (0 - world[1]) +
            (normal[2] - model[14]) * (back - world[2])
          // Nudged up and right of the stamp's centre, or the button covers
          // the very mark it is pinned to. Then held inside the stage: the
          // projection happily puts it past the edge when the letter sits near
          // one, and a control you cannot reach is worse than one out of place.
          const pad = 56
          markScreen = {
            x: clamp((clip[0] / clip[3] / 2 + 0.5) * width + 18, pad, width - pad),
            y: clamp((0.5 - clip[1] / clip[3] / 2) * height - 16, pad, height - pad),
            on: clip[3] > 0 && facing > 0 && unfold < 0.06,
          }

          // The name, struck on the address line. Both ends are projected so
          // the label can be sized from the face rather than the viewport.
          const at = (uv: number[]) =>
            transformPoint(
              multiply(projection, multiply(view, model)),
              (uv[0] - 0.5) * W,
              (uv[1] - 0.5) * H,
              D / 2,
            )
          // Where the envelope's bottom edge lands, so the button can hang
          // under the letter rather than under the stage. Pinned to the object
          // it belongs to, the same as everything else written on it.
          const foot = at(FOOT)
          if (foot[3] > 0) {
            footScreen = {
              x: clamp((foot[0] / foot[3] / 2 + 0.5) * width, 90, width - 90),
              // Below the edge, and never so low it reaches the command bar.
              y: clamp((0.5 - foot[1] / foot[3] / 2) * height + 34, 40, height - 34),
              on: unfold < 0.06,
            }
          }

          const a = at(ADDRESS)
          const b = at(ADDRESS_END)
          if (a[3] > 0 && b[3] > 0) {
            const ax = (a[0] / a[3] / 2 + 0.5) * width
            const bx = (b[0] / b[3] / 2 + 0.5) * width
            nameScreen = {
              x: ax,
              y: (0.5 - a[1] / a[3] / 2) * height,
              // The width of the address block on screen, which is the whole
              // point of projecting two points instead of one.
              w: Math.abs(bx - ax),
              on: facing > 0 && unfold < 0.06,
            }
          }
        }
      }

      // Written straight to the node. Putting this through React would be a
      // re-render every frame to move one button four pixels.
      const node = markEl.current
      if (node) {
        node.style.transform = `translate3d(${markScreen.x}px, ${markScreen.y}px, 0) translate(-50%, -50%)`
        node.style.opacity = markScreen.on ? '1' : '0'
        node.style.pointerEvents = markScreen.on ? 'auto' : 'none'
      }

      // The name rides the address line: positioned, sized and faded from the
      // face itself, so it turns away with the envelope instead of hanging in
      // front of it.
      const action = actionEl.current
      if (action) {
        action.style.transform = `translate3d(${footScreen.x}px, ${footScreen.y}px, 0) translate(-50%, -50%)`
        action.style.opacity = footScreen.on ? '1' : '0'
        action.style.pointerEvents = footScreen.on ? 'auto' : 'none'
      }

      const label = nameEl.current
      if (label) {
        label.style.transform = `translate3d(${nameScreen.x}px, ${nameScreen.y}px, 0)`
        label.style.width = `${nameScreen.w}px`
        // Tied to the block's own width, so the name grows with the letter.
        // The floor keeps it legible when the stack stands back; the ceiling
        // stops it shouting when the letter fills the stage.
        label.style.fontSize = `${clamp(nameScreen.w * 0.088, 11, 30)}px`
        label.style.opacity = nameScreen.on ? '1' : '0'
      }

      const stamp = markEl.current
      if (stamp) stamp.style.fontSize = `${clamp(nameScreen.w * 0.032, 8, 12)}px`
    }

    let frame = requestAnimationFrame(function loop(now) {
      // A background tab burning GPU on an envelope nobody is looking at.
      if (!document.hidden) draw(now)
      else previous = now
      frame = requestAnimationFrame(loop)
    })

    // Deliberately not calling WEBGL_lose_context here. StrictMode runs this
    // effect twice in development, and a canvas whose context has been lost
    // hands back that same dead context on the second mount — the shaders then
    // fail to compile and nothing ever draws. Dropping the rAF is enough; the
    // context goes with the canvas.
    return () => {
      cancelAnimationFrame(frame)
      box.disconnect()
      themeWatch.disconnect()
      scheme.removeEventListener('change', readTheme)
      surface.removeEventListener('pointerdown', onDown)
      surface.removeEventListener('pointermove', onMove)
      surface.removeEventListener('pointerup', onUp)
      surface.removeEventListener('pointercancel', onUp)
      surface.removeEventListener('keydown', onKey)
      surface.removeEventListener('wheel', onWheel)
      surface.removeEventListener('pointerenter', onEnter)
      surface.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return (
    <div className="relative size-full">
      <canvas
        ref={canvas}
        tabIndex={0}
        role="button"
        aria-label={
          here
            ? `${here.name}${here.status ? `, ${here.status.replace(/_/g, ' ')}` : ''}${
                cards.length > 1 ? `. Letter ${active + 1} of ${cards.length}` : ''
              }. Drag to turn it over, arrow keys to move through the stack, enter to open it.`
            : 'No letters yet'
        }
        style={{ cursor: 'grab' }}
        className="size-full touch-none select-none"
      />

      {/* The postmark. Pinned to the stamp every frame, and it says where this
          letter has got to — which is what a stamp on a real envelope does.
          It used to carry the next action instead, so the object had a label
          that was secretly its only button, and the status was repeated under
          the name. One fact, in one place, shaped like what it is. */}
      <div
        ref={markEl}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 opacity-0 transition-opacity duration-200"
      >
        {here?.status && (
          <span className="whitespace-nowrap rounded-[3px] bg-secondary px-2.5 py-1.5 font-medium uppercase leading-none tracking-[0.14em] text-primary shadow-[0_2px_10px_-2px_rgba(0,0,0,0.35)]">
            {here.status.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      {/* Which letter this is, written where an envelope carries its
          addressee. The name alone now — the status moved to the postmark. */}
      <div
        ref={nameEl}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 origin-top-left opacity-0 transition-opacity duration-200"
      >
        <p className="truncate font-medium leading-[1.15] tracking-[-0.02em] text-secondary">
          {here?.name}
        </p>
      </div>

      {/* What this letter needs next. A button, looking like a button, sitting
          under the object rather than stuck to its face. It fades with the
          letter, so it is never left behind over an open panel. */}
      <div
        ref={actionEl}
        className="pointer-events-none absolute left-0 top-0 whitespace-nowrap opacity-0 transition-opacity duration-200"
      >
        {here?.mark && (
          <button
            onClick={() => go.current('mark')}
            className="pointer-events-auto rounded-full bg-primary px-5 py-2.5 font-medium text-secondary shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            {here.mark.charAt(0).toUpperCase() + here.mark.slice(1)}
            {here.count > 0 && <span className="pl-2 tabular-nums opacity-70">{here.count}</span>}
          </button>
        )}
      </div>

      {/* The scrubber runs down the right, because that is the axis the
          letters move on. */}
      {cards.length > 1 && (
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col items-center">
          {/* Past what fits, a window around where you are rather than every
              letter — one 16px dot each ran off both ends of the stage at
              around forty-five. The count says what the window is hiding. */}
          {cards.length > DOTS && (
            <span className="pb-1 text-micro tabular-nums text-dim">
              {active + 1}/{cards.length}
            </span>
          )}
          {window_(cards, active).map(({ card, index }) => (
            <button
              key={card.id}
              onClick={() => setActive(index)}
              aria-label={card.name}
              aria-current={index === active ? 'true' : undefined}
              // A 6px dot is not a target. The button is 24px wide and 16px
              // tall with the dot painted inside it, so the thing you aim at is
              // the thing that responds.
              className="group grid h-4 w-6 shrink-0 place-items-center"
            >
              <span
                className={`w-1.5 rounded-full transition-all ${
                  index === active
                    ? 'h-5 bg-primary'
                    : 'h-1.5 bg-ink/25 group-hover:h-3 group-hover:bg-ink/60'
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
