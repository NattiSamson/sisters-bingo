// migrate.js
// One-off DB migration script for beteseb_bingo (panther-bingo project)
//
// USAGE:
//   1. Local:  DATABASE_URL="postgresql://beteseb_bingo_user:PASSWORD@dpg-d9o77ttaeets73d8-a.frankfurt-postgres.render.com/beteseb_bingo?sslmode=require" node migrate.js
//   2. Render: Add as a "Job" or run once via Render Shell with DATABASE_URL env var already set (Render injects it automatically if you link the DB to a service).
//
// Requires: npm install pg

const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL ||
  'postgresql://beteseb_bingo_user:vZeOBbOvggcxtRkWOcKxXywzUaVDE1Qy@dpg-d9o77ttaeets73d8-a.frankfurt-postgres.render.com/beteseb_bingo?sslmode=require';

const sql = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  name VARCHAR(50) NOT NULL,
  phone VARCHAR(30),
  balance NUMERIC(12,2) DEFAULT 0,
  total_games INT DEFAULT 0,
  total_wins INT DEFAULT 0,
  total_winnings NUMERIC(12,2) DEFAULT 0,
  is_admin BOOLEAN DEFAULT FALSE,
  is_banned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  stake_id VARCHAR(10) NOT NULL,
  stake_amount NUMERIC(12,2) NOT NULL,
  pot NUMERIC(12,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'playing',
  called_numbers INT[] DEFAULT '{}',
  winner_ids TEXT[] DEFAULT '{}',
  win_amount NUMERIC(12,2) DEFAULT 0,
  is_split BOOLEAN DEFAULT FALSE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS game_participants (
  id SERIAL PRIMARY KEY,
  game_id INT REFERENCES games(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  card_id INT NOT NULL,
  is_winner BOOLEAN DEFAULT FALSE,
  is_disqualified BOOLEAN DEFAULT FALSE,
  amount_won NUMERIC(12,2) DEFAULT 0,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(game_id, user_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  type VARCHAR(30) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  balance_after NUMERIC(12,2) NOT NULL,
  reference VARCHAR(200) DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposit_requests (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  tx_ref VARCHAR(200) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT INTO settings(key,value) VALUES ('telebirr_number','0967423275') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key,value) VALUES ('telebirr_name','Lidetua') ON CONFLICT(key) DO NOTHING;
`;

async function migrate() {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Render's cert chain sometimes needs this relaxed
  });

  console.log('Connecting to database...');
  try {
    await client.connect();
    console.log('Connected. Running migration...');

    await client.query(sql);

    console.log('✅ Migration complete. Tables created (or already existed):');
    const res = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    res.rows.forEach(r => console.log('  -', r.table_name));

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

migrate();
