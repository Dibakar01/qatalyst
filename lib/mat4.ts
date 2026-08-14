/**
 * The six matrix operations the letter needs, and not one more.
 *
 * Column-major Float32Array, which is the layout WebGL wants, so nothing has to
 * be transposed on the way to a uniform. A matrix library would be a dependency
 * with an inverse, a quaternion type and a slerp in it, none of which anything
 * here calls.
 */
export type Mat4 = Float32Array

export const identity = (): Mat4 =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/** a × b, applied right to left: multiply(view, model) transforms by model first. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4]
    const b1 = b[col * 4 + 1]
    const b2 = b[col * 4 + 2]
    const b3 = b[col * 4 + 3]
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        b0 * a[row] + b1 * a[4 + row] + b2 * a[8 + row] + b3 * a[12 + row]
    }
  }
  return out
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2)
  const range = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * range, -1,
    0, 0, 2 * far * near * range, 0,
  ])
}

export const translation = (x: number, y: number, z: number): Mat4 =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])

export function rotationX(radians: number): Mat4 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1])
}

/**
 * A point through a matrix, in clip coordinates — x, y, z and w, undivided.
 *
 * The mark on the letter is HTML pinned to a spot on a surface that is turning
 * in three dimensions, so something has to say where that spot landed on the
 * screen. `w` is handed back rather than divided out because `w <= 0` means the
 * point is behind the camera, and dividing by it would mirror the mark to the
 * wrong side of the screen instead of hiding it.
 */
export function transformPoint(
  m: Mat4,
  x: number,
  y: number,
  z: number,
): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ]
}

export function rotationY(radians: number): Mat4 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1])
}
