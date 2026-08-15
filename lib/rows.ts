/**
 * How many rows fit the space there actually is.
 *
 * The desk's rule is that nothing scrolls: a list longer than the surface is
 * paged, not scrolled. That only holds if the page size is the number of rows
 * that fit — and the old one was a hard-coded 12, decided without knowing how
 * tall anyone's window was. Twelve rows need about 771px of viewport once the
 * strip, the sheet header, the pager and the command bar have taken theirs, and
 * a 13" laptop offers about 760. So the last row was being clipped by a
 * `overflow-hidden` that had no scrollbar to give it away, while the pager
 * cheerfully went on reporting a total that included it.
 *
 * The number is measured rather than assumed: the client reads the real height
 * of the list box and the real height of one row and hands the answer back in a
 * cookie. Nothing here needs updating when a row's padding changes.
 */

/** Never fewer than this, however short the window — below it the list stops being one. */
export const FLOOR = 6

/** Never more, however tall — past this the pager is doing nothing for anyone. */
export const CEILING = 24

/**
 * Before the first measurement lands. Chosen to fit the smallest supported
 * window (a 13" laptop, full screen) so the very first paint cannot clip.
 */
export const ROWS = 8

/**
 * Rows that fit `boxHeight`, given a measured `rowHeight`.
 *
 * Both arguments come from the DOM, so both can arrive as 0 — an empty list has
 * no first child to measure, and a box that has not been laid out yet has no
 * height. `> 0` rather than a falsy check because `Number(null)` is 0 and would
 * otherwise sail through as a real measurement.
 */
export function rowsFor(boxHeight: number, rowHeight: number) {
  if (!(boxHeight > 0) || !(rowHeight > 0)) return ROWS
  return Math.min(Math.max(Math.floor(boxHeight / rowHeight), FLOOR), CEILING)
}

/** The cookie the client writes and the server reads. */
export const ROWS_COOKIE = 'qt.rows'

/** A page size off the wire is a number a stranger could have typed. */
export function readRows(raw: string | undefined | null) {
  const n = Number(raw)
  return Number.isInteger(n) && n >= FLOOR && n <= CEILING ? n : ROWS
}
