import { ImageResponse } from 'next/og'

/**
 * The same mark, as a PNG, because iOS will not take an SVG.
 *
 * `apple-icon` accepts only .jpg/.jpeg/.png — so rather than keep a
 * hand-exported second file that drifts from the real one, this renders the
 * same shape with `ImageResponse`. Built into Next; no dependency, no export
 * step, and one place to change if the mark ever does.
 *
 * No rounded corner: iOS masks the icon itself, and a radius of our own would
 * show as a dark ring inside theirs.
 */
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#d92819',
        }}
      >
        <svg width="112" height="112" viewBox="0 0 32 32">
          <g fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round">
            <rect x="7" y="10" width="18" height="12.5" rx="1.6" />
            <path d="M7.6 10.7 16 17.2 24.4 10.7" strokeLinecap="round" />
          </g>
        </svg>
      </div>
    ),
    size,
  )
}
