'use client'

import { useRouter } from 'next/navigation'
import { Fragment, useEffect } from 'react'

/**
 * The keyboard, everywhere.
 *
 * Escape always goes back one layer — a drawer, then a panel, then the stack —
 * so there is never a surface you have to find the close button for. The number
 * keys reach the places you actually go, and `?` says all of this out loud,
 * because a shortcut nobody can discover is a shortcut nobody uses.
 *
 * Arrow keys are deliberately absent here: the letter stack owns those, and it
 * only gets them while it has focus, so they never fight a text field.
 */

/**
 * The number keys, in the strip's own left-to-right order.
 *
 * They used to cover five of seven destinations in a different order from the
 * screen — `5` reached Reports, which sits sixth. A shortcut that contradicts
 * what you can see is worse than no shortcut, so this list and the strip are
 * the same list, and each pill now shows its number.
 */
const GOES = {
  // The three you do daily, in the strip.
  '1': '/?as=list',
  '2': '/?view=replies',
  '3': '/?view=reports',
  // Then everything else, in the order the menu lists it.
  '4': '/?view=book',
  '5': '/?view=sent',
  '6': '/?view=sources',
  '7': '/?view=returned',
  '0': '/',
  n: '/?new=1',
  s: '/?view=settings',
} as const

/** True when the keystroke belongs to whatever the person is typing into. */
function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export default function Keys({ back }: { back: string }) {
  const router = useRouter()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape works even from a field — it is how you get out of one.
      if (event.key === 'Escape') {
        const el = document.activeElement as HTMLElement | null
        if (typing(el)) {
          el?.blur()
          return
        }
        event.preventDefault()
        router.push(back)
        return
      }

      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === '?') {
        event.preventDefault()
        document.getElementById('shortcuts')?.toggleAttribute('open')
        return
      }

      const to = GOES[event.key as keyof typeof GOES]
      if (to) {
        event.preventDefault()
        router.push(to)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router, back])

  return null
}

/** What the keys do, one press away. */
export function Shortcuts() {
  return (
    <details
      id="shortcuts"
      className="panel fixed bottom-16 right-4 z-40 max-w-xs rounded-[10px] open:p-6"
    >
      <summary className="cursor-pointer list-none px-3 py-2 text-dim transition-colors hover:text-ink">
        <kbd className="rounded border border-line px-1.5 py-0.5 text-micro">?</kbd>
        <span className="ml-2">keys</span>
      </summary>
      <dl className="mt-3 grid grid-cols-[3.5rem_1fr] gap-y-2">
        {(
          [
            ['esc', 'back one layer'],
            ['↑ ↓', 'through the letters'],
            ['↵', 'open the letter'],
            ['0', 'the desk'],
            ['1–7', 'along the strip'],
            ['n', 'new letter'],
            ['s', 'settings'],
            ['⌘K', 'the command bar'],
          ] as const
        ).map(([key, does]) => (
          <Fragment key={key}>
            <dt>
              <kbd className="rounded border border-line px-1.5 py-0.5 text-micro">{key}</kbd>
            </dt>
            <dd className="text-dim">{does}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  )
}
