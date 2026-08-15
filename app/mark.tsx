/**
 * The mark: an envelope on a red square.
 *
 * Drawn rather than exported. It replaced a 31KB PNG that was being scaled down
 * to 18px in four places — heavier than this and softer at every size, with a
 * second copy in `app/icon.png` to keep in step. One definition now, and the
 * favicon is the same shape from `app/icon.svg`.
 *
 * Always white on the brand red, in both themes: a stamp is a printed thing and
 * does not change colour with the room.
 */
export default function Mark({ size = 18 }: { size?: number }) {
  // The stroke has to grow with the square or the envelope turns into a blob at
  // 18px and a wire outline at 64.
  const stroke = Math.max(size * 0.075, 1.1)

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Qatalyst"
      style={{ display: 'block' }}
    >
      <rect width="32" height="32" rx={size < 24 ? 6 : 7} fill="#d92819" />
      <g fill="none" stroke="#fff" strokeWidth={stroke} strokeLinejoin="round">
        <rect x="7" y="10" width="18" height="12.5" rx="1.6" />
        {/* The flap, meeting the corners the body already has. */}
        <path d="M7.6 10.7 16 17.2 24.4 10.7" strokeLinecap="round" />
      </g>
    </svg>
  )
}
