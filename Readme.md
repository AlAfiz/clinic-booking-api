# Clinic Booking API

A booking API for a clinic, plus a small web page that uses it. Patients can see available appointment slots, book one, and see a confirmation. Built for Task 1 of the Koya Cohort 4 assessment.

- **Live URL:** https://clinic-booking-api-sxhp.onrender.com
- **Web page:** the same URL, opened in a browser
- **API key:** sent to the assessors separately (it is never committed to this repo)

> The service runs on a free Render plan, so after a period of inactivity the first request can take 30 to 60 seconds while it wakes up.

## Status

All five levels are implemented and deployed, along with the web page.

| Level | What it covers | Status |
|---|---|---|
| 1 | List slots, book one, look up a booking | Done |
| 2 | API key required; invalid bookings rejected | Done |
| 3 | No double booking, even at the same instant; cancel a booking | Done |
| 4 | Retried requests never duplicate; paging through a person's bookings | Done |
| 5 | Spam protection on bookings | Done |

## Tech stack

| Part | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ | Familiar, and fast to build with |
| Framework | Express | Minimal, and easy to read |
| Database | Supabase (hosted Postgres) | Real transactions, row-level uniqueness rules and advisory locks |
| DB driver | `pg` with a connection pool | Plain SQL, with full control over transactions |
| Host | Render (free web service) | Deploys from GitHub and provides HTTPS automatically |
| Frontend | One static HTML file (`public/index.html`) | No build step, and served by the API itself, so there are no CORS problems |

## Architecture

```
Browser (public/index.html)
        |  HTTPS
        v
Render: Express app (index.js)
   1. API key check (middleware)
   2. Rate limit (POST /bookings only)
   3. Validation and business logic, inside a DB transaction
        |  SQL over TLS (Supabase session pooler)
        v
Supabase Postgres: slots, bookings, idempotency_keys
```

## API reference

Every request needs the header `X-API-Key: <your key>`. A missing or wrong key returns `401`. All bodies are JSON, and errors look like `{"error": "<message>"}`.

| Method and path | Level | Purpose |
|---|---|---|
| `POST /reset` | 1 | Delete all bookings and replace all slots |
| `GET /slots` | 1 | List slots, earliest first. Optional `?provider=` (exact match) |
| `POST /bookings` | 1 to 5 | Book a slot |
| `GET /bookings/{id}` | 1 | Get one booking |
| `GET /bookings?email=` | 4 | List one person's bookings, oldest first, with cursor paging |
| `DELETE /bookings/{id}` | 3 | Cancel a booking |

### `POST /reset`

```json
{ "slots": [
  { "id": "s1", "provider": "Dr Ade",
    "start": "2026-12-10T09:00:00Z", "end": "2026-12-10T09:30:00Z" }
] }
```

Returns `200` with `{"ok": true, "slots": 1}`.

### `GET /slots`

```json
{ "slots": [
  { "id": "s1", "provider": "Dr Ade",
    "start": "2026-12-10T09:00:00.000Z", "end": "2026-12-10T09:30:00.000Z",
    "available": true }
] }
```

`available` is `false` while the slot has a confirmed booking.

### `POST /bookings`

Request:

```json
{ "slot_id": "s1", "name": "Ada Obi", "email": "ada@example.com" }
```

Optional header: `Idempotency-Key: <any unique string>`.

| Status | When |
|---|---|
| `201` | Booked. Returns the booking with status `confirmed` |
| `400` | `slot_id`, `name` or `email` missing or empty; email not valid; slot has already started |
| `404` | Slot does not exist |
| `409` | Slot already has a confirmed booking |
| `422` | `Idempotency-Key` reused with a different body |
| `429` | More than 5 attempts for this email within a minute. Includes a `Retry-After` header (whole seconds) |

`name` and `email` are trimmed, and `email` is stored in lower case.

### `GET /bookings?email=&limit=&cursor=`

- `email` is required, and matching ignores case.
- `limit` is 1 to 50 (default 10). Anything else returns `400`.
- Response: `{ "bookings": [...], "next_cursor": "<string or null>" }`. Pass `next_cursor` back as `cursor` to get the next page. The last page has `next_cursor: null`.
- Cancelled bookings still appear in a person's list.

### `DELETE /bookings/{id}`

Returns `200` with the booking (now `cancelled`), `404` if there is no such booking, or `409` if it was already cancelled. Cancelling frees the slot so it can be booked again.

## How each level is solved

### Level 2: API key and validation
A middleware checks `X-API-Key` against the `API_KEY` environment variable before any route runs. If the variable is not set, every request is refused, so a missing setting locks the API instead of opening it. Validation runs in a fixed order: required fields, then email format, then slot exists (404), then slot not started (400).

### Level 3: no double booking
The rule is enforced by the database, not by application code. A **partial unique index** allows only one `confirmed` booking per slot:

```sql
CREATE UNIQUE INDEX one_confirmed_per_slot
ON bookings (slot_id) WHERE status = 'confirmed';
```

The insert uses `ON CONFLICT ... DO NOTHING`. If it inserts nothing, the slot was taken and the API returns `409`. A "read, check, then write" approach would let two simultaneous requests both pass the check. Here the database lets exactly one in. Because the index only covers confirmed bookings, cancelling (which sets `status = 'cancelled'`) frees the slot automatically. Cancel itself is a single `UPDATE ... WHERE status = 'confirmed'`, so two simultaneous cancels also cannot both succeed.

### Level 4: idempotency
When a request carries an `Idempotency-Key`, the booking and the saved response are written in **one transaction**:

1. Take a transaction-level advisory lock on the key, so two simultaneous requests with the same key run one after the other.
2. Look the key up in `idempotency_keys`. If it exists and the SHA-256 hash of `slot_id`, `name` and `email` matches, replay the saved status code and body. If the hash differs, return `422`.
3. Otherwise create the booking, save the response under the key, and commit.

Error responses are saved and replayed too, so a retry always gets the same answer as the original request.

### Level 4: pagination
Cursor pagination, ordered by `(created_at, id)`. The cursor is a base64url-encoded note of the last row seen, with the timestamp at full microsecond precision (JavaScript dates only keep milliseconds, which could skip or repeat rows). The query fetches `limit + 1` rows, and the extra row only tells us whether another page exists.

### Level 5: rate limiting
A sliding window of 5 attempts per email per 60 seconds, kept in memory. The check runs before validation, so failed attempts count, as the spec requires. Emails are trimmed and lower-cased first, so different capitalisation shares one counter. The 6th attempt returns `429` with `Retry-After` set to the seconds until the oldest attempt leaves the window. Rejected attempts are not recorded, so a spammer cannot extend their own lockout.

### The web page
`public/index.html` is plain HTML and JavaScript. It lists slots (disabling booked ones and ones that have started), shows a form, and displays a confirmation. It sends a fresh `Idempotency-Key` with each submission and keeps the same key only after a network failure, so a retry can never double-book. It handles `409` (slot just taken), `429` (shows the wait time) and validation errors.

The page uses two extra routes, `GET /ui/slots` and `POST /ui/bookings`. These run the same handlers as the main API, including validation, double-booking protection, idempotency and rate limiting, but do not need the API key. This keeps the real key out of the browser, where anyone could read it and use it to call `/reset`. The page can only list slots and book; reset, cancel and booking lookups still need the key.

## Database schema

```sql
CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES slots(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX one_confirmed_per_slot
ON bookings (slot_id) WHERE status = 'confirmed';
```

`setup-db.js` creates all of this and is safe to run more than once.

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase **Session pooler** connection string (the direct connection is IPv6-only on the free plan and can fail from some hosts) |
| `API_KEY` | The key callers must send in `X-API-Key` |
| `PORT` | Set by Render. Defaults to 3000 locally |

Secrets live in a local `.env` file (git-ignored) and in Render's Environment settings. They are never committed.

## Run it locally

```bash
git clone <this repo>
cd clinic-booking-api
npm install

# create .env with your own values
cat > .env << 'EOF'
DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-region.pooler.supabase.com:5432/postgres
API_KEY=choose-a-long-random-string
EOF

node setup-db.js   # creates the tables and the unique index
node index.js      # starts the server on http://localhost:3000
```

Generate a random key with `openssl rand -hex 16`.

## Deploy

1. Push the repo to GitHub.
2. On Render, create a **Web Service** from the repo (runtime Node, build command `npm install`, start command `node index.js`, free instance).
3. Add `DATABASE_URL` and `API_KEY` under **Environment**.
4. Run `node setup-db.js` once against the Supabase database (from your machine is fine).
5. Every push to the main branch redeploys automatically.

## Testing

There is no automated test suite. I tested each level by hand with `curl` against both the local server and the live URL. `demo.sh` runs the key checks in one go. Set `KEY` and `URL` first (the script reads them from `test.sh`).

| Level | Check | Expected |
|---|---|---|
| 1 | Reset, list slots, book, fetch by id | Booked slot shows `available: false` |
| 2 | No key; wrong key; empty name; bad email; unknown slot; past slot | `401`, `401`, `400`, `400`, `404`, `400` |
| 3 | 10 simultaneous bookings for one slot | Exactly one `201`, nine `409` |
| 3 | Cancel, cancel again, cancel an unknown id | `200`, `409`, `404`; slot becomes bookable again |
| 4 | Same `Idempotency-Key` and body, twice | Same status and same booking `id` |
| 4 | Same key, different body | `422` |
| 4 | 5 simultaneous requests with the same key | All return the same `id`; one row in the database |
| 4 | 25 bookings for one email, paged with `limit=10` | 10 + 10 + 5 rows, no repeats or gaps, last `next_cursor` is `null` |
| 5 | 6 attempts for one email in a minute (even failed ones) | Five normal responses, then `429` with `Retry-After` |
| 5 | Same email with different capitalisation; a different email | Shares the counter; other emails unaffected |

## Known limitations

These are trade-offs I chose to accept, or things I would improve next.

- **Rate limit counters are in memory.** A server restart clears them, and if the service ran on more than one instance each would count separately. The fix is to store the counters in Postgres (or Redis).
- **Idempotency keys never expire**, and `/reset` does not clear them, so reusing an old key after a reset replays the old response. A cleanup job or a `created_at` cutoff would fix this.
- **Some framework-level errors are not JSON.** A malformed JSON body or an unknown route returns Express's default HTML error instead of `{"error": ...}`.
- **`ssl: { rejectUnauthorized: false }`** accepts any TLS certificate from the database. It works with the Supabase pooler, but pinning the Supabase CA certificate would be safer.
- **The `/ui/*` routes are open to anyone.** This is intentional (see "The web page"), but a production system would use sessions or a signed token instead.
- **Free-tier behaviour:** Render sleeps when idle, and Supabase pauses free projects after about a week of inactivity.

## Repository layout

```
.
├── index.js          # the API (all routes, middleware, business logic)
├── setup-db.js       # creates tables and the unique index
├── test-db.js        # tiny script to check the database connection
├── demo.sh           # runs the main checks against the live URL
├── public/
│   └── index.html    # the patient-facing web page
├── package.json
└── README.md
```