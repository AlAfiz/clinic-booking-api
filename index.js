require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
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
    res.json({ ok: true, slots: slots.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'reset failed' });
  } finally {
    client.release();
  }
});
app.get('/slots', async (req, res) => {
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
app.post('/bookings', async (req, res) => {
  try {
    const { slot_id, name, email } = req.body;

    const slot = await pool.query('SELECT id FROM slots WHERE id = $1', [slot_id]);
    if (slot.rows.length === 0) {
      return res.status(404).json({ error: 'slot not found' });
    }

    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING id, slot_id, name, email, status, created_at`,
      [id, slot_id, name, email]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not create booking' });
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
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on port ' + port);
});
