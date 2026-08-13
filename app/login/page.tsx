import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { COOKIE, cookieValue, passwordMatches } from '@/lib/auth'

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
    <main className="grid min-h-dvh place-items-center p-6">
      <form action={login} className="shell w-full max-w-[20rem] rounded-[20px] p-7">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-accent text-[11px] font-bold text-canvas">
            Q
          </span>
          <span className="text-[12.5px] font-semibold tracking-[0.16em]">QATALYST</span>
        </div>

        <label htmlFor="password" className="mt-7 block text-muted">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          className="mt-1.5 w-full rounded-lg border border-line bg-raised px-2.5 py-2 transition-colors focus:border-accent/40"
        />
        {e ? <p className="mt-2 text-[#FF8F8F]">That password is not right.</p> : null}

        <button className="mt-4 w-full rounded-lg bg-accent py-2 font-medium text-canvas transition-[filter] hover:brightness-110">
          Sign in
        </button>
      </form>
    </main>
  )
}
