'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { ROWS_COOKIE, readRows, rowsFor } from '@/lib/rows'

/**
 * The list box, and the one thing on this desk that measures itself.
 *
 * Everything else here is laid out by CSS, which is how it should be. But a
 * page size is decided on the server, before the browser exists, and the right
 * page size is "however many rows fit" — a fact only the browser has. So the
 * box reads its own height and the height of one real row, works out the
 * answer, and hands it back in a cookie for the next render.
 *
 * Measuring the first child rather than assuming a row height is the point: the
 * book, the sent log, the replies and the returned list all rule their rows
 * differently, and a constant here would be wrong for three of them and would
 * rot the first time anyone changed a padding.
 */
export function Fit({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const router = useRouter()
  /** The last size we asked for. Stops a loop if a refresh ever fails to take. */
  const asked = useRef(0)

  useEffect(() => {
    const el = box.current
    if (!el) return

    const current = () =>
      readRows(
        document.cookie
          .split('; ')
          .find((c) => c.startsWith(`${ROWS_COOKIE}=`))
          ?.slice(ROWS_COOKIE.length + 1),
      )

    const measure = () => {
      // Not while anything is ticked. Selecting a row opens the bulk strip,
      // which takes height off this box — so measuring here would re-page the
      // list and the refresh would throw away the selection that opened the
      // strip in the first place. The scroll underneath covers the rows that no
      // longer fit until the selection is cleared.
      if (el.querySelector('input:checked')) return

      // An empty list has no row to measure, and rowsFor() returns the default
      // rather than dividing by it.
      const row = (el.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0
      const next = rowsFor(el.clientHeight, row)
      if (next === current() || next === asked.current) return

      asked.current = next
      // A year: the window is usually the same window tomorrow. Lax because
      // this rides on ordinary navigation and has no business on a cross-site
      // request.
      document.cookie = `${ROWS_COOKIE}=${next};path=/;max-age=31536000;samesite=lax`
      router.refresh()
    }

    // The box is `flex-1`, so its height is the room left over rather than the
    // room its contents want — which is what makes this converge. Changing the
    // row count cannot change the height that decided it.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [router])

  // A visible scrollbar, unlike everywhere else on this desk — and only ever
  // when the fit is wrong. The whole point of the net is that a bad measurement
  // costs a scrollbar instead of a row nobody knows is missing, and the hidden
  // scrollbar the rest of the app uses would have left it missing and merely
  // reachable. In normal working it never appears.
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto">
      {children}
    </div>
  )
}
