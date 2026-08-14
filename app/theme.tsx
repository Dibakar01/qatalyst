'use client'

import { useSyncExternalStore } from 'react'

type Theme = 'light' | 'dark'

const query = '(prefers-color-scheme: dark)'

const read = (): Theme =>
  (document.documentElement.dataset.theme as Theme | undefined) ??
  (window.matchMedia(query).matches ? 'dark' : 'light')

/**
 * The element is the store.
 *
 * The theme has to live on `<html>` anyway — the blocking script in the root
 * layout puts it there before the first paint, and the CSS and the letter's
 * shader both read it from there. Subscribing to that rather than keeping a
 * second copy in React state means there is only one answer to what the theme
 * is, and no way for the switch to disagree with the page.
 */
function subscribe(changed: () => void) {
  const watch = new MutationObserver(changed)
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const scheme = window.matchMedia(query)
  scheme.addEventListener('change', changed)
  return () => {
    watch.disconnect()
    scheme.removeEventListener('change', changed)
  }
}

export default function ThemeSwitch() {
  // The server cannot know which room you are in, so it renders neither icon
  // and the first client paint fills it in.
  const theme = useSyncExternalStore(subscribe, read, () => null)

  function flip() {
    const next: Theme = read() === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('qat-theme', next)
    } catch {
      // Private mode. The choice still holds for this session.
    }
  }

  return (
    <button
      onClick={flip}
      aria-label={theme ? `Switch to the ${theme === 'dark' ? 'light' : 'dark'} room` : 'Switch theme'}
      className="grid size-7 place-items-center rounded-full border border-line text-dim transition-colors hover:border-primary hover:text-primary"
    >
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
        <circle cx="8" cy="8" r="3.4" fill="currentColor" />
        {/* A moon and a sun drawn from the same circle, so the button never
            changes size when it flips. */}
        {theme === 'dark' ? (
          <path d="M8 4.6a3.4 3.4 0 0 0 0 6.8z" fill="var(--color-panel)" />
        ) : theme === 'light' ? (
          <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M13 3l-1.1 1.1M4.1 11.9 3 13" />
          </g>
        ) : null}
      </svg>
    </button>
  )
}
