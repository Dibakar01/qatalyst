import { cookies } from 'next/headers'
import Image from 'next/image'
import { redirect } from 'next/navigation'
import { COOKIE, cookieValue, passwordMatches } from '@/lib/auth'
import Letter from '../letter'
import ThemeSwitch from '../theme'

/**
 * The same room, before you have been let into it. The letter is on the stage
 * and sealed — nothing has been written, which is the honest picture of where
 * you are — and you can still pick it up and turn it over while you type.
 */
export default async function Login({ searchParams }: PageProps<'/login'>) {
  const { e } = await searchParams

  async function login(formData: FormData) {
    'use server'
    if (!passwordMatches(String(formData.get('password') ?? ''))) redirect('/login?e=1')
    ;(await cookies()).set(COOKIE, cookieValue(), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })
    redirect('/')
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="relative flex shrink-0 items-center justify-center px-3 py-2">
        <span className="flex items-center gap-2">
          <Image src="/mark.png" alt="" width={18} height={18} priority className="rounded-[3px]" />
          <span className="font-semibold tracking-[-0.04em]">qatalyst</span>
        </span>
        <div className="absolute right-4">
          <ThemeSwitch />
        </div>
      </header>

      <div className="min-h-0 flex-1 px-3 pb-3">
        <div className="stage grain relative flex h-full items-center gap-4 overflow-hidden rounded-[18px] p-4">
          <form action={login} className="panel w-[min(21rem,100%)] shrink-0 rounded-[10px] p-7">
            <Image src="/mark.png" alt="" width={28} height={28} className="mb-5 rounded-[4px]" />
            <p className="text-micro font-medium uppercase tracking-[0.16em] text-dim">Internal</p>
            <h1 className="mt-2 text-title font-medium leading-tight tracking-[-0.03em]">
              Who&rsquo;s writing?
            </h1>

            <label htmlFor="password" className="mt-7 block text-dim">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              className="mt-1.5 w-full rounded-[5px] border border-line bg-raise px-3 py-2 transition-colors focus:border-primary"
            />
            {e ? <p className="mt-2 text-primary">That password is not right.</p> : null}

            <button className="mt-5 w-full rounded-[5px] bg-primary py-2.5 font-medium text-secondary transition-[filter] hover:brightness-110">
              Sit down
            </button>
          </form>

          {/* Sealed, and no way in until you are. It can still be turned over. */}
          <div className="relative hidden min-w-0 flex-1 md:block">
            <Letter
              cards={[
                {
                  id: 'sealed',
                  name: '',
                  progress: 0,
                  // Nothing written on it until you are in.
                  status: '',
                  mark: '',
                  count: 0,
                  markHref: '',
                  href: '',
                  code: 0b101101001011,
                },
              ]}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
