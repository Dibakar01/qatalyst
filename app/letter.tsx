'use client'

import { useEffect, useRef } from 'react'
import { identity, multiply, perspective, rotationX, rotationY, translation } from '@/lib/mat4'

/**
 * The one object on the stage: a letter, in three dimensions, that you can pick
 * up and turn over.
 *
 * It is not decoration. How far the flap is open and how far the sheet has come
 * out of it is `progress` — the share of this campaign that has actually been
 * posted. A sealed envelope means nothing has gone; a letter half out means the
 * run is half done. You can read the state of the work from across the room.
 *
 * Raw WebGL2 on purpose. This is three meshes and one light. A scene-graph
 * library would be several hundred kilobytes to draw a box, a triangle and a
 * plane, and would still need the same forty lines of GLSL.
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
uniform float uAmbient;
uniform float uRim;

out vec4 outColour;

const vec3 CAMERA = vec3(0.0, 0.0, 3.6);

float rect(vec2 p, vec2 a, vec2 b) {
  vec2 s = step(a, p) * step(p, b);
  return s.x * s.y;
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
  vec3 base;

  if (vKind > 2.5) {
    // The underside of the flap: the same stock, in its own shadow.
    base = uPrimary * 0.72;
  } else if (vKind > 1.5) {
    // The face of the envelope — where the address and the stamp go. Both are
    // struck in the secondary, which is the only other colour in this app.
    base = uPrimary;
    float stamp = rect(vUv, vec2(0.805, 0.700), vec2(0.945, 0.925));
    float inner = rect(vUv, vec2(0.820, 0.717), vec2(0.930, 0.908));
    float address =
        rect(vUv, vec2(0.14, 0.425), vec2(0.62, 0.449))
      + rect(vUv, vec2(0.14, 0.345), vec2(0.52, 0.369))
      + rect(vUv, vec2(0.14, 0.265), vec2(0.40, 0.289));
    base = mix(base, uPaper, clamp(stamp - inner + address * 0.92, 0.0, 1.0));
  } else if (vKind > 0.5) {
    // The sheet itself.
    base = uPaper;
    float head = rect(vUv, vec2(0.10, 0.855), vec2(0.36, 0.925));
    base = mix(base, uPrimary, head);
    base = mix(base, uPaper * 0.55, writing(vUv, 0.80, 22.0) * 0.85);
  } else {
    base = uPrimary;
  }

  vec3 N = normalize(vNormal);
  vec3 V = normalize(CAMERA - vWorld);
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

  outColour = vec4(colour, 1.0);
}`

/* ── geometry ──────────────────────────────────────────────────────────────
   Nine floats a vertex: position, normal, uv, and which surface it is. Built
   once at module load — the letter is the same shape for everyone. */

type Vertex = number[]

function quad(
  out: Vertex,
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

function envelopeMesh() {
  const x = W / 2
  const y = H / 2
  const z = D / 2
  const out: Vertex = []
  // Front carries the address, so it is its own surface; everything else is
  // plain stock.
  quad(out, [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1], 2)
  quad(out, [x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1], 0)
  quad(out, [x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], [1, 0, 0], 0)
  quad(out, [-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], [-1, 0, 0], 0)
  quad(out, [-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], [0, 1, 0], 0)
  quad(out, [-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, -1, 0], 0)
  return new Float32Array(out)
}

/** Hinged at the origin so the model matrix can simply rotate it about x. */
function flapMesh() {
  const x = W / 2
  const out: Vertex = []
  const push = (p: number[], n: number[], uv: number[], kind: number) =>
    out.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], kind)

  push([-x, 0, 0], [0, 0, 1], [0, 1], 0)
  push([0, -FLAP, 0], [0, 0, 1], [0.5, 0], 0)
  push([x, 0, 0], [0, 0, 1], [1, 1], 0)

  push([-x, 0, 0], [0, 0, -1], [0, 1], 3)
  push([x, 0, 0], [0, 0, -1], [1, 1], 3)
  push([0, -FLAP, 0], [0, 0, -1], [0.5, 0], 3)
  return new Float32Array(out)
}

function paperMesh() {
  const x = (W - 0.16) / 2
  const y = (H - 0.08) / 2
  const out: Vertex = []
  quad(out, [-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0], [0, 0, 1], 1)
  quad(out, [x, -y, 0], [-x, -y, 0], [-x, y, 0], [x, y, 0], [0, 0, -1], 1)
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

const hex = (value: string): [number, number, number] => {
  const n = parseInt(value.replace('#', ''), 16)
  // sRGB to linear-ish. Without this the red renders orange once it is lit.
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((c) =>
    Math.pow(c, 2.2),
  ) as [number, number, number]
}

export default function Letter({ progress = 0 }: { progress?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  // Read by the frame loop rather than closed over, so a progress change eases
  // the flap open instead of tearing down the GL context and rebuilding it.
  const target = useRef(progress)
  useEffect(() => {
    target.current = Math.min(Math.max(progress, 0), 1)
  }, [progress])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    // No WebGL2 — the stage is already the right colour, so the app simply has
    // an empty stage instead of a lit one. Nothing else changes.
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true })
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
      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
      const stride = 9 * 4
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
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset)
      }
      gl.bindVertexArray(null)
      return { vao, count: data.length / 9 }
    })

    const u = (name: string) => gl.getUniformLocation(program, name)
    const uMVP = u('uMVP')
    const uModel = u('uModel')
    const uPrimary = u('uPrimary')
    const uPaper = u('uPaper')
    const uAmbient = u('uAmbient')
    const uRim = u('uRim')

    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)

    // The letter is the same red in both themes — it is the brand, not a
    // surface. Only the light around it changes.
    let light = false
    const readTheme = () => {
      const set = document.documentElement.dataset.theme
      light = set ? set === 'light' : !window.matchMedia('(prefers-color-scheme: dark)').matches
      gl.uniform3fv(uPrimary, hex('#d92819'))
      gl.uniform3fv(uPaper, hex('#ffffff'))
      gl.uniform1f(uAmbient, light ? 0.62 : 0.3)
      gl.uniform1f(uRim, light ? 0.1 : 0.5)
    }
    readTheme()
    const themeWatch = new MutationObserver(readTheme)
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', readTheme)

    let projection = identity()
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, 2)
      const width = Math.max(canvas.clientWidth, 1)
      const height = Math.max(canvas.clientHeight, 1)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      gl.viewport(0, 0, canvas.width, canvas.height)
      projection = perspective(Math.PI / 5.2, width / height, 0.1, 50)
    }
    const box = new ResizeObserver(resize)
    box.observe(canvas)
    resize()

    /* ── holding it ──────────────────────────────────────────────────────── */

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let yaw = -0.42
    let pitch = 0.2
    let spinVelocity = 0
    let tiltVelocity = 0
    let dragging = false
    let hovering = false
    let opened = 0
    let last = { x: 0, y: 0 }

    const onDown = (event: PointerEvent) => {
      dragging = true
      last = { x: event.clientX, y: event.clientY }
      canvas.setPointerCapture(event.pointerId)
      canvas.style.cursor = 'grabbing'
    }
    const onMove = (event: PointerEvent) => {
      if (!dragging) return
      spinVelocity = (event.clientX - last.x) * 0.006
      tiltVelocity = (event.clientY - last.y) * 0.004
      last = { x: event.clientX, y: event.clientY }
    }
    const onUp = (event: PointerEvent) => {
      dragging = false
      canvas.releasePointerCapture(event.pointerId)
      canvas.style.cursor = 'grab'
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerenter', () => (hovering = true))
    canvas.addEventListener('pointerleave', () => (hovering = false))
    canvas.style.cursor = 'grab'

    const view = translation(0, 0, -3.6)

    function draw() {
      // Picking it up beats the idle drift; letting go hands it back.
      if (!dragging) spinVelocity += (still ? 0 : 0.0016 - spinVelocity) * 0.03
      yaw += spinVelocity
      pitch = Math.min(Math.max(pitch + tiltVelocity, -0.7), 0.7)
      if (!dragging) {
        spinVelocity *= 0.94
        tiltVelocity *= 0.9
        pitch += (0.2 - pitch) * 0.02
      }

      // Hovering lifts the flap a little further, so the object answers before
      // you have clicked anything.
      const wanted = Math.min(target.current + (hovering ? 0.12 : 0), 1)
      opened += (wanted - opened) * (still ? 1 : 0.06)

      const scene = multiply(rotationY(yaw), rotationX(pitch))
      const models = [
        scene,
        // A hair proud of the face it closes onto, or the two co-planar
        // surfaces fight for the same depth and the flap tears as it turns.
        multiply(scene, multiply(translation(0, H / 2, D / 2 + 0.002), rotationX(opened * 2.25))),
        multiply(scene, translation(0, opened * H * 0.92, -0.004)),
      ]

      gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT)
      parts.forEach((part, index) => {
        const model = models[index]
        gl!.uniformMatrix4fv(uModel, false, model)
        gl!.uniformMatrix4fv(uMVP, false, multiply(projection, multiply(view, model)))
        gl!.bindVertexArray(part.vao)
        // The flap and the sheet are single surfaces, seen from both sides.
        if (index === 0) gl!.enable(gl!.CULL_FACE)
        else gl!.disable(gl!.CULL_FACE)
        gl!.drawArrays(gl!.TRIANGLES, 0, part.count)
      })
    }

    let frame = 0
    const loop = () => {
      // A background tab burning GPU on an envelope nobody is looking at.
      if (!document.hidden) draw()
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)

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
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [])

  return (
    <canvas
      ref={ref}
      className="size-full touch-none select-none"
      aria-label="The letter. Drag to turn it over."
      role="img"
    />
  )
}
