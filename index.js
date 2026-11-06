require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use((req, res, next) => {
  // Open paths: the web page itself and the two routes it uses. Everything else needs the key.
  const open = ['/', '/health', '/ui/slots', '/ui/bookings'];
  if (open.includes(req.path)) return next();

  const key = req.get('X-API-Key');
  if (!process.env.API_KEY || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Level 5: rate limit, 5 attempts per email per minute ---
const attempts = new Map(); // email -> list of attempt times (ms)
const RATE_LIMIT = 5;
const WINDOW_MS = 60 * 1000;

function checkRateLimit(email) {
  const now = Date.now();
  const recent = (attempts.get(email) || []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= RATE_LIMIT) {
    attempts.set(email, recent);
    const retryAfter = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
    return { limited: true, retryAfter };
  }

  recent.push(now);
  attempts.set(email, recent);
  return { limited: false };
}

// Tidy up old entries once a minute so the Map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [email, times] of attempts) {
    if (times.every((t) => now - t >= WINDOW_MS)) attempts.delete(email);
  }
}, 60 * 1000).unref();

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// The patient-facing web page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/reset', async (req, res) => {
  const slots = req.body.slots;
  if (!Array.isArray(slots)) {
    return res.status(400).json({ error: 'slots must be an array' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM slots');
    for (const s of slots) {
      await client.query(
        'INSERT INTO slots (id, provider, start_time, end_time) VALUES ($1, $2, $3, $4)',
        [s.id, s.provider, s.start, s.end]
      );
    }
    await client.query('COMMIT');
    attempts.clear(); // a reset also starts the rate-limit counters from zero
    res.json({ ok: true, slots: slots.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'reset failed' });
  } finally {
    client.release();
  }
});

app.get(['/slots', '/ui/slots'], async (req, res) => {
  try {
    const provider = req.query.provider;
    const params = [];
    let where = '';
    if (provider) {
      params.push(provider);
      where = 'WHERE s.provider = $1';
    }

    const result = await pool.query(
      `SELECT s.id, s.provider, s.start_time, s.end_time,
              NOT EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
       FROM slots s
       ${where}
       ORDER BY s.start_time ASC`,
      params
    );

    const slots = result.rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_time,
      end: r.end_time,
      available: r.available,
    }));
    res.json({ slots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not list slots' });
  }
});

// Does the booking work and returns { status, body }. It never sends the response itself.
async function createBooking(client, rawBody) {
  const body = rawBody || {};

  if (typeof body.slot_id !== 'string' || body.slot_id.trim() === '') {
    return { status: 400, body: { error: 'slot_id is required' } };
  }
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return { status: 400, body: { error: 'name is required' } };
  }
  if (typeof body.email !== 'string' || body.email.trim() === '') {
    return { status: 400, body: { error: 'email is required' } };
  }

  const slot_id = body.slot_id;
  const name = body.name.trim();
  const email = body.email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 400, body: { error: 'email is not valid' } };
  }

  const slot = await client.query(
    'SELECT id, start_time FROM slots WHERE id = $1',
    [slot_id]
  );
  if (slot.rows.length === 0) {
    return { status: 404, body: { error: 'slot not found' } };
  }
  if (new Date(slot.rows[0].start_time) <= new Date()) {
    return { status: 400, body: { error: 'slot has already started' } };
  }

  const id = crypto.randomUUID();
  const result = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING id, slot_id, name, email, status, created_at`,
    [id, slot_id, name, email]
  );
  if (result.rows.length === 0) {
    return { status: 409, body: { error: 'slot already booked' } };
  }
  return { status: 201, body: result.rows[0] };
}

app.post(['/bookings', '/ui/bookings'], async (req, res) => {
  // Level 5: count this attempt before anything else, so failed attempts count too
  const rawEmail = req.body && req.body.email;
  if (typeof rawEmail === 'string' && rawEmail.trim() !== '') {
    const rl = checkRateLimit(rawEmail.trim().toLowerCase());
    if (rl.limited) {
      res.set('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
  }

  const idemKey = req.get('Idempotency-Key');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let hash = null;
    if (idemKey) {
      // Wait here if another request is using the same key right now
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idemKey]);

      const b = req.body || {};
      hash = crypto
        .createHash('sha256')
        .update(JSON.stringify([b.slot_id, b.name, b.email]))
        .digest('hex');

      const saved = await client.query(
        'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1',
        [idemKey]
      );
      if (saved.rows.length > 0) {
        await client.query('COMMIT');
        if (saved.rows[0].request_hash !== hash) {
          return res
            .status(422)
            .json({ error: 'Idempotency-Key was already used with a different request' });
        }
        return res.status(saved.rows[0].status_code).json(saved.rows[0].response_body);
      }
    }

    const result = await createBooking(client, req.body);

    if (idemKey) {
      await client.query(
        `INSERT INTO idempotency_keys (key, request_hash, status_code, response_body)
         VALUES ($1, $2, $3, $4)`,
        [idemKey, hash, result.status, JSON.stringify(result.body)]
      );
    }

    await client.query('COMMIT');
    res.status(result.status).json(result.body);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { }
    console.error(err);
    res.status(500).json({ error: 'could not create booking' });
  } finally {
    client.release();
  }
});

app.get('/bookings', async (req, res) => {
  try {
    // email is required
    if (typeof req.query.email !== 'string' || req.query.email.trim() === '') {
      return res.status(400).json({ error: 'email is required' });
    }
    const email = req.query.email.trim().toLowerCase();

    // limit: whole number from 1 to 50, default 10
    let limit = 10;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) {
        return res.status(400).json({ error: 'limit must be a whole number from 1 to 50' });
      }
      limit = parseInt(req.query.limit, 10);
      if (limit < 1 || limit > 50) {
        return res.status(400).json({ error: 'limit must be a whole number from 1 to 50' });
      }
    }

    // cursor: decode the bookmark, if there is one
    let cursorTime = null;
    let cursorId = null;
    if (req.query.cursor !== undefined) {
      try {
        const decoded = JSON.parse(
          Buffer.from(String(req.query.cursor), 'base64url').toString('utf8')
        );
        if (
          typeof decoded.t !== 'string' ||
          typeof decoded.i !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.t)
        ) {
          throw new Error('bad cursor');
        }
        cursorTime = decoded.t;
        cursorId = decoded.i;
      } catch (e) {
        return res.status(400).json({ error: 'invalid cursor' });
      }
    }

    // Ask for one extra row, so we know whether another page exists
    const result = await pool.query(
      `SELECT id, slot_id, name, email, status, created_at,
              to_char(created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
       FROM bookings
       WHERE email = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::text))
       ORDER BY created_at ASC, id ASC
       LIMIT $4`,
      [email, cursorTime, cursorId, limit + 1]
    );

    const hasMore = result.rows.length > limit;
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;

    let next_cursor = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1];
      next_cursor = Buffer.from(
        JSON.stringify({ t: last.cursor_time, i: last.id })
      ).toString('base64url');
    }

    const bookings = pageRows.map((r) => ({
      id: r.id,
      slot_id: r.slot_id,
      name: r.name,
      email: r.email,
      status: r.status,
      created_at: r.created_at,
    }));

    res.json({ bookings, next_cursor });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not list bookings' });
  }
});

app.get('/bookings/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, slot_id, name, email, status, created_at
       FROM bookings WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'booking not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not get booking' });
  }
});

app.delete('/bookings/:id', async (req, res) => {
  try {
    // Try to cancel, but only if it is currently confirmed
    const updated = await pool.query(
      `UPDATE bookings SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed'
       RETURNING id, slot_id, name, email, status, created_at`,
      [req.params.id]
    );
    if (updated.rows.length === 1) {
      return res.json(updated.rows[0]);
    }

    // Nothing was updated: either it doesn't exist, or it was already cancelled
    const existing = await pool.query(
      'SELECT id FROM bookings WHERE id = $1',
      [req.params.id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'booking not found' });
    }
    res.status(409).json({ error: 'booking already cancelled' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not cancel booking' });
  }
});
app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: status === 400 ? 'invalid JSON body' : 'internal error' });
});
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on port ' + port);
});