'use client'

import { useEffect, useRef } from 'react'

/**
 * The plane the whole app sits on: a dark surface with slow light moving across
 * it. It is the bottom of three planes and it is deliberately almost nothing —
 * no particles, no grid, no texture pretending to be a material it isn't. Its
 * only job is to give the shell above it something to float on.
 *
 * Raw WebGL2 on purpose. This is one fullscreen triangle and forty lines of
 * GLSL; a scene graph library would be several hundred kilobytes to draw a
 * quad. No geometry buffer either — the vertex shader derives its own corners
 * from gl_VertexID.
 */
const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
out vec4 outColour;
uniform vec2 uResolution;
uniform float uTime;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1, 0)), f.x),
    mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x),
    f.y
  );
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  // Two octaves is enough for light this soft; a third is invisible at 4%.
  float field = noise(uv * 1.2 + vec2(uTime * 0.020, uTime * 0.013)) * 0.65
              + noise(uv * 2.4 - vec2(uTime * 0.017, 0.0)) * 0.35;

  // Two pools of light, drifting out of phase so the surface never visibly loops.
  float warm = smoothstep(1.15, 0.0, length(uv - vec2(-0.55, 0.34 + 0.08 * sin(uTime * 0.11))));
  float cool = smoothstep(1.35, 0.0, length(uv - vec2(0.72, -0.44 + 0.10 * cos(uTime * 0.09))));

  float lit = field * warm;
  vec3 colour = vec3(0.012, 0.015, 0.023)
              + vec3(0.10, 0.20, 0.09) * pow(lit, 2.2)
              + vec3(0.05, 0.07, 0.16) * pow(field * cool, 2.6);

  // Near-black gradients band badly on 8-bit displays. A sub-LSB of noise costs
  // nothing and is the difference between a surface and a set of stripes.
  colour += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

  outColour = vec4(colour, 1.0);
}`

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

export default function Ground() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    // No WebGL2 — the body is already the right near-black, so the app simply
    // sits on a flat plane instead of a lit one. Nothing else changes.
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })
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

    const uResolution = gl.getUniformLocation(program, 'uResolution')
    const uTime = gl.getUniformLocation(program, 'uTime')

    // Light this diffuse carries no detail, so full retina resolution would be
    // four times the fragments for a difference nobody can see.
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, 1.5)
      canvas.width = Math.floor(canvas.clientWidth * dpr)
      canvas.height = Math.floor(canvas.clientHeight * dpr)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(uResolution, canvas.width, canvas.height)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = (seconds: number) => {
      gl.uniform1f(uTime, seconds)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    const start = performance.now()

    if (still) {
      // Motion is the accessibility problem, not the surface. Draw it once.
      draw(0)
    } else {
      const loop = (now: number) => {
        // A background tab burning GPU on a gradient nobody is looking at.
        if (!document.hidden) draw((now - start) / 1000)
        frame = requestAnimationFrame(loop)
      }
      frame = requestAnimationFrame(loop)
    }

    // Deliberately not calling WEBGL_lose_context here. StrictMode runs this
    // effect twice in development, and a canvas whose context has been lost
    // hands back that same dead context on the second mount — the shaders then
    // fail to compile and the ground never draws. Dropping the rAF is enough;
    // the context goes with the canvas.
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 size-full bg-canvas"
    />
  )
}
