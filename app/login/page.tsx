import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { COOKIE, cookieValue, passwordMatches } from '@/lib/auth'

/**
 * The same room, before you have been let into it: frame, stage, and one card
 * floating on the light. Nothing is on the desk yet, so the stage is empty —
 * which is the honest picture of where you are.
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
      <header className="flex shrink-0 items-center justify-center px-5 py-3">
        <span className="font-serif text-[19px] tracking-[-0.02em]">qatalyst</span>
      </header>

      <div className="min-h-0 flex-1 px-3 pb-3">
        <div className="stage grain relative h-full overflow-hidden rounded-[22px]">
          <form
            action={login}
            className="card absolute left-1/2 top-1/2 w-[min(21rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[12px] p-7 md:left-[9%] md:translate-x-0"
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-card-dim">
              Internal
            </p>
            <h1 className="mt-2 font-serif text-[27px] leading-tight text-card-ink">
              Who&rsquo;s writing?
            </h1>

            <label htmlFor="password" className="mt-7 block text-card-dim">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              className="mt-1.5 w-full rounded-[4px] border border-card-line bg-white/[0.04] px-3 py-2 text-card-ink transition-colors focus:border-go"
            />
            {e ? <p className="mt-2 text-[#E8837B]">That password is not right.</p> : null}

            <button className="mt-5 w-full rounded-[4px] bg-go py-2.5 font-medium text-white transition-[filter] hover:brightness-115">
              Sit down
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
