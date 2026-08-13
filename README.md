# Qatalyst

Internal outbound tool. Holds a bounded contact list, writes a personalised line
per contact, enforces suppression before anything sends, and sends from our own
Google Workspace mailboxes at a safe rate.

Not a CRM. No stages, no pipeline, no forecasting.

**Phases 1–3 are built.** Phase 4 — reply and bounce ingestion, plus the
Mailchimp handoff for opted-in contacts — is not; it needs real mail flowing
first.

## The shape of the thing

A **campaign** is the unit of work, and the app is organised around it:

```
Contacts ──▶ Campaign ──▶ Review ──▶ Send
  import      write one     approve    from our
  + verify    message       each one   own mailboxes
```

It is one screen, and it is a desk rather than a set of pages. A near-white
frame, a lit black stage inside it, and on that stage exactly two objects: the
instrument card on the left, and one sheet of paper in front of you.

The paper is the point. This app writes letters, so a letter is drawn as a
letter — real stock, a real serif, a page width you can read — and everything
else is machinery that stays out of its way. Campaigns are **letters** on the
desk, contacts are the **address book**, mailboxes are **post boxes**, and the
suppression list is what came back **returned**.

The card never moves and answers the four questions you have every morning:
what needs me, what is written, how much postage is released right now, and
where is everything else. A letter itself is four numbered clauses — the
message, the round, the reading, the post.

Along the bottom is a command line. `⌘K` focuses it; anything it does not
recognise is treated as a search of the address book.

```
new <name>   write [n]   sign   post   hold   collect
find <text>  book        import suppress <email>   block <domain>
boxes        returned    desk
```

`write`, `sign`, `post` and `hold` act on the open letter and refuse to run
without one. Everything a command does is also a button on the paper, and both
post to the same server action.

Colour only ever says something: blue is the one forward action, oxblood is
stop, mustard is a mark in the margin meaning a person must look. A sheet with
no colour on it is a sheet with nothing wrong.

## Setup

Any Postgres works — local, Railway, Neon. The driver is `postgres.js` over the
standard wire protocol, not a vendor-specific one.

```sh
brew install postgresql@17 && brew services start postgresql@17 && createdb qatalyst
cp .env.example .env      # DATABASE_URL, APP_PASSWORD, UNSUBSCRIBE_SECRET
npm install
npm run db:migrate
npm run db:seed
npm run db:demo           # optional: sample contacts so the UI has something in it
npm run dev               # http://localhost:3000
```

Two more credentials unlock the later phases. Without either, the app still runs
and tells you what it would have done:

| | Needed for | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY`, or one `ant auth login` | Writing drafts (phase 2) | Generation fails per contact and says so |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Sending (phase 3) | Sends run as a dry run: everything happens except the Gmail call |

## How a campaign works

**1 · Message.** A subject template and a body template. The body must contain
`{{personalised}}` — that one line is all the model writes; everything around it
is fixed text you wrote. Other variables: `{{first_name}}`, `{{last_name}}`,
`{{company}}`, `{{title}}`, and `{{context.Any CSV Column}}`.

Defining exactly one slot is what makes rule 5 enforceable: the validators know
precisely which text to check.

**2 · Audience.** Contacts whose `email_status` is `verified` or `catch_all`,
not erased, not suppressed, not already written to in this campaign. One click
writes the next 25.

**3 · Review.** Every message runs both validators before it is shown:

- **Grounding** — pulls the numbers and mid-sentence proper nouns out of the
  generated line and requires each to appear in that contact's own fields or
  `context`. An invented funding round or conference is flagged.
- **Substance** — strips the contact's name, title and company plus ordinary
  filler. If nothing meaningful is left, it is mail-merge in costume, and it is
  flagged.

Flagged messages are not blocked — they need a human. The bulk approve button
only ever touches messages that passed both validators, so nothing can be waved
through in a batch.

**4 · Send.** `npm run send` runs the sender: one tick a minute, at most one
send per mailbox per tick, with the daily cap released evenly across 09:00–17:00
so a backlog can never go out as a burst.

## Checks

| | |
|---|---|
| `npm test` | 19 pure-function checks — tokens, CSV mapping, templates, both validators, the sending rules. No database. |
| `npm run test:acceptance` | Phases 1–3 end to end. **Truncates tables**; refuses to run against anything but localhost. |
| `npm run lint` / `npm run build` | |

CI runs all four against a Postgres 17 service container on every push and PR.

Handy while testing: `npm run db:reset` clears everything, `npm run db:demo`
refills it, and `npm run token -- someone@example.com` prints a working
unsubscribe URL.

## Hosting split

The app runs locally. The unsubscribe endpoint cannot — a link pointing at
localhost is a dead link in every email we send.

Same codebase, deployed twice against the same database:

| | env | serves |
|---|---|---|
| local | `npm run dev` | everything, behind `APP_PASSWORD` |
| public | `PUBLIC_ONLY=1` | `/u/:token` only, everything else 404s |

`PUBLIC_ONLY=1` is what keeps the contact list off the internet.
`UNSUBSCRIBE_SECRET` must be identical in both or links stop verifying.

Unsubscribe tokens are `base64url(email).hmac` — self-contained, so the public
deployment needs no token table and no session.

## Where the rules live

| Rule | Code |
|---|---|
| 1 · One suppression check, every send path | `lib/suppression.ts` — the only module that queries `suppressions`, and `lib/gmail.ts` calls it again at the wire so no future caller can route around it |
| 2 · Send eligibility by status | `lib/rules.ts` `maySend()` and `shouldHalt()` |
| 3 · Per-mailbox daily cap, spread across the day | `lib/rules.ts` `allowanceNow()` plus one send per mailbox per tick |
| 4 · Opt-out sentence and working link on every email | `lib/template.ts` `assembleBody()` — the only function that produces a sendable body. No `List-Unsubscribe` header, deliberately |
| 5 · Two validators before `approved` | `lib/validators.ts`; bulk approval in `lib/campaigns.ts` only touches unflagged messages |
| 6 · Capture `message_id_header` on every send | `lib/gmail.ts` reads it back from Gmail after sending rather than guessing |
| Idempotent import | unique indexes on `lower(email)` and `linkedin_url` + `ON CONFLICT DO NOTHING` |
| Erasure keeps the hash | `lib/contacts.ts` `eraseContact()` — suppresses before nulling |
| Unknown verification results never become sendable | `lib/csv.ts` — any unrecognised status falls back to `unverified` |

Deliberately absent: tracking pixels, link shorteners, open tracking, HTML
email, `List-Unsubscribe` headers, lead scoring, scraping.

## Before this sends for real

SPF, DKIM and DMARC on the sending domain, then a two to three week mailbox
warm-up from about five a day up to the cap. Both have lead times measured in
weeks and neither is code.

## Migrations

Every schema change gets a migration. Never edit an applied one.

```sh
npm run db:generate   # after editing db/schema.ts
npm run db:migrate
```
