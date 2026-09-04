// migrate-route.js
// TEMPORARY migration endpoint — add this to your existing running Express app,
// hit it once from a browser or curl, then DELETE this file and the route.
//
// In your server.js, add near the top (after your `pool`/`client` setup):
//   const { registerMigrateRoute } = require('./migrate-route');
//   registerMigrateRoute(app, pool); // pool = your existing pg Pool/Client instance
//
// Then visit (replace with your real domain and secret):
//   https://panther-bingo.onrender.com/__migrate?secret=CHANGE_ME_LONG_RANDOM_STRING
//
// IMPORTANT: Remove this route and redeploy immediately after running it once.
// Do not leave a migration endpoint live in production.

const MIGRATE_SECRET = process.env.MIGRATE_SECRET || 'CHANGE_ME_LONG_RANDOM_STRING';

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

function registerMigrateRoute(app, pool) {
  app.get('/__migrate', async (req, res) => {
    if (req.query.secret !== MIGRATE_SECRET) {
      return res.status(403).send('Forbidden');
    }
    try {
      await pool.query(sql);
      const result = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name;
      `);
      res.send(
        'Migration complete. Tables: ' +
        result.rows.map(r => r.table_name).join(', ') +
        '\n\nREMOVE THIS ROUTE NOW.'
      );
    } catch (err) {
      res.status(500).send('Migration failed: ' + err.message);
    }
  });
}

module.exports = { registerMigrateRoute };
