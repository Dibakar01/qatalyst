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
    redirect('/contacts')
  }

  return (
    <form action={login} className="max-w-xs space-y-2">
      <h1 className="font-medium">Qatalyst</h1>
      <input
        name="password"
        type="password"
        autoFocus
        className="w-full border border-neutral-400 px-2 py-1"
        placeholder="Password"
      />
      {e ? <p className="text-red-700">Wrong password.</p> : null}
      <button className="border border-neutral-400 bg-neutral-100 px-3 py-1">Sign in</button>
    </form>
  )
}
