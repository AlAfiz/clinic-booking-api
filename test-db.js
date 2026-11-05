require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const result = await client.query('SELECT NOW()');
  console.log('Connected! Database time is:', result.rows[0].now);
  await client.end();
}

main().catch((err) => {
  console.error('Connection failed:', err.message);
});
