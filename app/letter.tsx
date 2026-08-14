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
 * Each carries a mark — the small stamp on its face — which says the one thing
 * that letter needs next and takes you to where you do it. How far the flap is
 * open and how far the sheet has come out is how far that run has actually got,
 * so a glance across the stack tells you which letter is stuck without reading
 * a number.
 *
 * The mark is drawn in GL as part of the envelope, but its label and hit target
 * are a real HTML button pinned to the stamp's projected position every frame.
 * Text stays crisp, the control is reachable by keyboard, and nothing about it
 * has to be re-implemented in a shader.
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
    float stamp = rect(vUv, vec2(0.805, 0.700), vec2(0.945, 0.925));
    float inner = rect(vUv, vec2(0.820, 0.717), vec2(0.930, 0.908));
    float address =
        rect(vUv, vec2(0.14, 0.425), vec2(0.62, 0.449))
      + rect(vUv, vec2(0.14, 0.345), vec2(0.52, 0.369))
      + rect(vUv, vec2(0.14, 0.265), vec2(0.40, 0.289));
    float mark = clamp(stamp - inner + address * 0.92 + franking(vUv, uCode) * 0.95, 0.0, 1.0);
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
/** Where the stamp sits on the face, in uv. The mark is pinned here. */
const STAMP = [0.875, 0.812]

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
/** More than this either side of the front is behind the ones you can see. */
const NEIGHBOURS = 3
/** A press that moves less than this many pixels was a click, not a drag. */
const SLOP = 6

export type Card = {
  id: string
  name: string
  /** 0 sealed, 1 fully drawn out. The share of this run that has been posted. */
  progress: number
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
  closeHref = '/',
}: {
  cards: Card[]
  /** The letter the URL says is unfolded, if any. */
  openId?: string
  /** The stack has been turned into a list, so it stands back out of the way. */
  listed?: boolean
  /** Where the stack stands, in world units, so a panel can sit beside it
   *  rather than on top of it. Eased, so the letters walk across. */
  shift?: number
  closeHref?: string
}) {
  const router = useRouter()
  const canvas = useRef<HTMLCanvasElement>(null)
  const markEl = useRef<HTMLDivElement>(null)

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
      const target = to === 'mark' ? card.markHref : live.current.unfolded ? closeHref : card.href
      if (target) router.push(target)
    }
  }, [router, closeHref])

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
      projection = perspective(Math.PI / 5.2, width / height, 0.1, 60)
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

    const onDown = (event: PointerEvent) => {
      dragging = true
      travelled = 0
      spin = 0
      tilt = 0
      last = { x: event.clientX, y: event.clientY }
      surface.setPointerCapture(event.pointerId)
      surface.style.cursor = 'grabbing'
    }

    const onMove = (event: PointerEvent) => {
      if (!dragging) return
      const dx = event.clientX - last.x
      const dy = event.clientY - last.y
      travelled += Math.abs(dx) + Math.abs(dy)
      bankedYaw += dx * 0.006
      bankedPitch += dy * 0.004
      last = { x: event.clientX, y: event.clientY }
    }

    const onUp = (event: PointerEvent) => {
      if (!dragging) return
      dragging = false
      // Losing the capture already released it; asking again throws.
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
      surface.style.cursor = 'grab'
      if (travelled < SLOP && event.type === 'pointerup') go.current('open')
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
      shown = still ? want : ease(shown, want, 0.12, dt)
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
      const back = 3.5 + unfold * 0.35
      const view = translation(0, 0, -back)

      gl!.uniform3f(uCamera, 0, 0, back)
      gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT)

      let markScreen: { x: number; y: number; on: boolean } = { x: 0, y: 0, on: false }
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
          // the very mark it is pinned to.
          markScreen = {
            x: (clip[0] / clip[3] / 2 + 0.5) * width + 18,
            y: (0.5 - clip[1] / clip[3] / 2) * height - 16,
            on: clip[3] > 0 && facing > 0 && unfold < 0.06,
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
            ? `${here.name}. Drag to turn it over, arrow keys to move through the stack, enter to open it.`
            : 'No letters yet'
        }
        style={{ cursor: 'grab' }}
        className="size-full touch-none select-none"
      />

      {/* The mark. Pinned to the stamp every frame, and the only control on the
          object — it always says the one thing this letter needs next. */}
      <div ref={markEl} className="absolute left-0 top-0 opacity-0 transition-opacity duration-200">
        {here?.mark && (
          <button
            onClick={() => go.current('mark')}
            className="whitespace-nowrap rounded-[4px] border border-secondary/60 bg-primary px-3 py-2 text-micro font-medium uppercase tracking-[0.12em] text-secondary shadow-[0_6px_20px_-6px_rgba(0,0,0,0.8)] transition-transform hover:scale-105"
          >
            {here.count > 0 ? `${here.count} · ${here.mark}` : here.mark}
          </button>
        )}
      </div>

      {/* Which letter you are looking at. The bars on its face are what tells
          them apart at a glance; this is where you confirm which is which. */}
      {here?.name && (
        <p className="pointer-events-none absolute inset-x-0 bottom-0 truncate px-6 text-center font-medium">
          {here.name}
        </p>
      )}

      {/* The scrubber runs down the right, because that is the axis the
          letters move on. */}
      {cards.length > 1 && (
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col">
          {cards.map((card, index) => (
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
