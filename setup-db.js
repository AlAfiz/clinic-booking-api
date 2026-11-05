require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id          TEXT PRIMARY KEY,
      provider    TEXT NOT NULL,
      start_time  TIMESTAMPTZ NOT NULL,
      end_time    TIMESTAMPTZ NOT NULL
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id          TEXT PRIMARY KEY,
      slot_id     TEXT NOT NULL REFERENCES slots(id),
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'confirmed',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key           TEXT PRIMARY KEY,
      request_hash  TEXT NOT NULL,
      status_code   INTEGER NOT NULL,
      response_body JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
    ON bookings (slot_id)
    WHERE status = 'confirmed'
  `);
  const result = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('slots', 'bookings')
    ORDER BY table_name
  `);
  console.log('Tables found:', result.rows.map((r) => r.table_name));

  await client.end();
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
});
