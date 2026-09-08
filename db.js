/**
 * db.js — PostgreSQL database layer for Beteseb Bingo
 * 
 * Install: npm install pg
 * Set env:  DATABASE_URL=postgresql://user:pass@host:5432/beteseb_bingo
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

module.exports = {
  // ── User operations ──
  async registerUser(telegramId, name, phone) {
    const { rows } = await pool.query(
      `INSERT INTO users(telegram_id, name, phone)
       VALUES($1, $2, $3)
       ON CONFLICT(telegram_id) DO UPDATE SET last_seen=NOW(), name=$2
       RETURNING *`,
      [telegramId, name, phone]
    );
    return rows[0];
  },
	
	async getPaymentMethodTypes() {
  const { rows } = await pool.query(`
SELECT
    pt.id,
    pt.name,
	pt.amharic_name,
	pt.emoji,
    pt.is_active
FROM payment_types pt
WHERE pt.is_active = TRUE
  AND EXISTS (
    SELECT 1
    FROM payment_methods pm
    WHERE pm.type_id = pt.id
      AND pm.is_active = TRUE
  )
ORDER BY pt.id;
  `);

  return rows;
},

	async getPaymentMethods() {
  const { rows } = await pool.query(`
    SELECT
      pa.id,
      pa.name,
      pa.amharic_name,
	  pa.emoji,
      pt.name AS type_name,
	  pt.amharic_name AS am_type_name,
	  pt.emoji AS type_emoji
    FROM payment_methods pa
    JOIN payment_types pt
      ON pa.type_id = pt.id
    WHERE pa.is_active = TRUE
      AND pt.is_active = TRUE
    ORDER BY pa.id
  `);

  return rows;
},

  async approveDepositttttttttttt(receipt,id) {
	  
const  u   = await pool.query('SELECT count(id) FROM deposits WHERE reference=$1', [receipt.receiptNo]);
		 
		if(Number(u.rows[0].count) > 0)
		{
  
		  return 1;
		}
const  {rows: u2}= await pool.query('SELECT id FROM payment_accounts WHERE is_active = TRUE AND RIGHT(account_number,4) = RIGHT($1,4)', [receipt.creditedPartyAccountNo]);
	  if (u2.length === 0) {
  return 2;
     }		
	const u3 = await pool.query('SELECT count(id) FROM payment_accounts WHERE is_active = TRUE AND account_name=$1', [receipt.creditedPartyName]);
		if(Number(u3.rows[0].count) <= 0)
		{
		 
   return 3;
		}
	  console.log('aaaaaa ' + id);
		const { rows } = await pool.query(
  'SELECT id, balance FROM users WHERE telegram_id = $1',
  [id]
);

if (rows.length === 0) {
  throw new Error("User not found");
}

const depositAmount = Number(
  receipt.settledAmount.replace(/[^0-9.]/g, "")
);

const currentBalance = Number(rows[0].balance);
const amountAfter = currentBalance + depositAmount;

console.log("Current balance:", currentBalance);
console.log("Deposit amount:", depositAmount);
console.log("Amount after:", amountAfter);

await pool.query(
  `INSERT INTO deposits
   (user_id, payment_account_id, deposit_method_id,
    depositor_name, depositor_account, amount,
    amount_after, reference, created_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
   RETURNING id`,
  [
    rows[0].id,
    1,
    1,
    receipt.payerName,
    receipt.payerTelebirrNo,
    depositAmount,
    amountAfter,
    receipt.receiptNo
  ]
);
	  await pool.query("UPDATE users SET balance=$1 WHERE telegram_id=$2", [amountAfter,id]);
     await pool.query("UPDATE payment_accounts SET balance=balance+$1 WHERE id=$2", [depositAmount,u2[0].id]);
	  
	  return 4;
      },

  async getUserByTelegramId(telegramId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE telegram_id=$1', [telegramId]
    );
    return rows[0] || null;
  },

  async updateBalance(userId, amount) {
    const { rows } = await pool.query(
      'UPDATE users SET balance=$1 WHERE id=$2 RETURNING balance',
      [amount, userId]
    );
    return rows[0]?.balance;
  },

  async deductStake(userId, amount, gameId) {
    const { rows } = await pool.query(
      'SELECT deduct_stake($1,$2,$3)', [userId, amount, gameId]
    );
    return rows[0].deduct_stake;
  },

  async awardWin(userId, amount, gameId) {
    const { rows } = await pool.query(
      'SELECT award_win($1,$2,$3)', [userId, amount, gameId]
    );
    return rows[0].award_win;
  },

  // ── Game operations ──
  async createGame(roomId, stakeId, stakeAmount) {
    const { rows } = await pool.query(
      `INSERT INTO games(room_id, stake_id, stake_amount, pot, started_at)
       VALUES($1,$2,$3,0,NOW()) RETURNING *`,
      [roomId, stakeId, stakeAmount]
    );
    return rows[0];
  },

  async addParticipant(gameId, userId, cardId) {
    await pool.query(
      `INSERT INTO game_participants(game_id, user_id, card_id)
       VALUES($1,$2,$3) ON CONFLICT(game_id,user_id) DO NOTHING`,
      [gameId, userId, cardId]
    );
  },

  async updateGamePot(gameId, pot) {
    await pool.query('UPDATE games SET pot=$1 WHERE id=$2', [pot, gameId]);
  },

  async updateCalledNumbers(gameId, calledNumbers) {
    await pool.query(
      'UPDATE games SET called_numbers=$1 WHERE id=$2',
      [calledNumbers, gameId]
    );
  },

  async endGame(gameId, winnerUserIds, winAmount, isSplit) {
    await pool.query(
      `UPDATE games SET status='finished', winner_ids=$1, win_amount=$2, is_split=$3, ended_at=NOW()
       WHERE id=$4`,
      [winnerUserIds, winAmount, isSplit, gameId]
    );
    if (winnerUserIds.length > 0) {
      await pool.query(
        `UPDATE game_participants SET is_winner=TRUE, amount_won=$1
         WHERE game_id=$2 AND user_id=ANY($3)`,
        [winAmount, gameId, winnerUserIds]
      );
    }
    // Increment total_games for all participants
    await pool.query(
      `UPDATE users SET total_games=total_games+1
       WHERE id IN (SELECT user_id FROM game_participants WHERE game_id=$1)`,
      [gameId]
    );
  },

  async disqualifyParticipant(gameId, userId) {
    await pool.query(
      'UPDATE game_participants SET is_disqualified=TRUE WHERE game_id=$1 AND user_id=$2',
      [gameId, userId]
    );
  },

  // ── Game state for reconnection ──
  async getActiveGame(roomId) {
    const { rows } = await pool.query(
      `SELECT g.*, 
        json_agg(json_build_object('user_id',gp.user_id,'card_id',gp.card_id)) as participants
       FROM games g
       JOIN game_participants gp ON gp.game_id=g.id
       WHERE g.room_id=$1 AND g.status='playing'
       GROUP BY g.id`,
      [roomId]
    );
    return rows[0] || null;
  },

  // ── Leaderboard ──
  async getLeaderboard(limit = 10) {
    const { rows } = await pool.query(
      'SELECT name, total_wins, total_games, total_winnings, win_rate FROM leaderboard LIMIT $1',
      [limit]
    );
    return rows;
  }
};
