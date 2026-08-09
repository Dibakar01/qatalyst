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
    <main className="grid min-h-screen place-items-center p-6">
      <form
        action={login}
        className="w-full max-w-[19rem] rounded-2xl border border-line bg-surface p-6"
      >
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-ink text-[11px] font-semibold text-white">
            Q
          </span>
          <span className="text-[13px] font-semibold tracking-[0.14em]">QATALYST</span>
        </div>

        <label htmlFor="password" className="mt-6 block text-muted">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          className="mt-1 w-full rounded-lg border border-line bg-faint px-2.5 py-2 focus:bg-surface"
        />
        {e ? <p className="mt-2 text-rose-700">That password is not right.</p> : null}

        <button className="mt-4 w-full rounded-lg bg-ink py-2 font-medium text-white transition-opacity hover:opacity-85">
          Sign in
        </button>
      </form>
    </main>
  )
}
