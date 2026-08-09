# Qatalyst

Internal outbound tool. Holds a bounded contact list, personalises one message per
contact, enforces suppression before anything sends, and sends from our own Google
Workspace mailboxes at a safe rate.

Not a CRM. No stages, no pipeline, no forecasting.

**Phase 1 is built** — schema, CSV import, contacts view, unsubscribe handler.
Phases 2 (personalisation + review), 3 (sending), 4 (replies/bounces) are not.

## Setup

Any Postgres works — local, Railway, Neon. The driver is `postgres.js` over the
standard wire protocol, not a vendor-specific one.

```sh
brew install postgresql@17 && brew services start postgresql@17 && createdb qatalyst
cp .env.example .env      # fill in DATABASE_URL, APP_PASSWORD, UNSUBSCRIBE_SECRET
npm install
npm run db:migrate
npm run db:seed
npm run db:demo           # optional: loads sample.csv so the UI has something in it
npm run dev               # http://localhost:3000, log in with APP_PASSWORD
```

## The workspace

One screen does the work. The sidebar holds Contacts, Suppressions and Mailboxes;
everything else opens over the list rather than navigating away from it.

- **Filters, search, sort and paging live in the URL.** Nothing is hidden in
  component state, so any view can be linked, reloaded or shared.
- **Import is a panel, not a page** — the list stays behind it and updates in place.
- **Clicking a contact opens a panel** with every field, the raw `context`, its
  sending eligibility, and the suppress and erase actions.
- **Bulk suppression appears only when rows are ticked**, using a CSS `:has()`
  rule rather than client state.
- **Export CSV exports exactly what the filters are showing.**

## Checks

| | |
|---|---|
| `npm test` | pure functions — token signing, CSV row mapping. No database. |
| `npm run test:acceptance` | the phase 1 criteria end to end. **Truncates tables**; refuses to run against anything but localhost. |
| `npm run lint` / `npm run build` | |

CI runs all four against a Postgres 17 service container on every push and PR.

Handy while testing: `npm run db:reset` clears contacts and suppressions,
`npm run db:demo` refills them, and `npm run token -- someone@example.com`
prints a working unsubscribe URL.

## Hosting split

The app runs locally. The unsubscribe endpoint cannot — a link pointing at
localhost is a dead link in every email we send.

Same codebase, deployed twice against the same Neon database:

| | env | serves |
|---|---|---|
| local | `npm run dev` | everything, behind `APP_PASSWORD` |
| public | `PUBLIC_ONLY=1` | `/u/:token` only, everything else 404s |

`PUBLIC_ONLY=1` is what keeps the contact list off the internet. Deploy with
`npx vercel --prod`, set `DATABASE_URL`, `UNSUBSCRIBE_SECRET` and `PUBLIC_ONLY=1`
in the project, then point `UNSUBSCRIBE_BASE_URL` in the local `.env` at the
resulting origin.

`UNSUBSCRIBE_SECRET` must be identical in both, or links stop verifying.

Unsubscribe tokens are `base64url(email).hmac` — self-contained, so the public
deployment needs no token table and no session.

## Acceptance check for phase 1

`npm run test:acceptance` asserts all of this. By hand, in the UI:

1. Import `sample.csv` at `/import`, mapping `First → first_name`,
   `Last → last_name`, `Work Email → email`, `Org → company`, `Role → title`,
   `Profile → linkedin_url`. Expect 3 new, 1 duplicate, 1 suppressed (seeded),
   1 malformed. `Funding round` and `Notes` land in `context`.
2. Import the same file again. Expect 0 new, 4 duplicates.
3. Erase a contact at `/contacts` — fields null, `erased_at` set, suppression survives.
4. Re-import: the erased contact is now counted as suppressed, not resurrected.
5. `curl $(npm run token --silent -- grace@compiler.example)` returns the
   confirmation page and writes a hashed suppression.

The four counts always sum to the number of rows in the file — they describe
rows processed, not distinct people.

## Where the rules live

| Rule | Code |
|---|---|
| One suppression check, every send path | `lib/suppression.ts` — the only module that queries `suppressions` |
| Erasure keeps the hash | `lib/contacts.ts` `eraseContact()` — suppresses before nulling |
| Idempotent import | unique indexes on `lower(email)` and `linkedin_url` + `ON CONFLICT DO NOTHING` |
| Unknown verification results never become sendable | `lib/csv.ts` — any unrecognised status falls back to `unverified` |
| Message-ID capture | `messages.message_id_header`, indexed, for phase 4 |
| Catch-all sending restrictions | `mailboxes.sends_catch_all` — enforced in phase 3 |

Deliberately absent: tracking pixels, link shorteners, open tracking, HTML email,
`List-Unsubscribe` headers, lead scoring, scraping.

## Migrations

Every schema change gets a migration. Never edit an applied one.

```sh
npm run db:generate   # after editing db/schema.ts
npm run db:migrate
```
