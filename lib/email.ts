// Pure string helpers only — this module is imported by client components,
// so nothing node-only (crypto lives in lib/suppression.ts).

export const normalise = (email: string) => email.trim().toLowerCase()

export const isValidEmail = (email: string) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(email)

export const domainOf = (email: string) => normalise(email).split('@')[1] ?? ''
