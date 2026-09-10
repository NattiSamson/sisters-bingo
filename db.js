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

function normalizeEthiopianPhone(phone) {
  if (!phone) {
    return null;
  }

  // Remove spaces, +, -, (, ), etc.
  let digits = String(phone).replace(/\D/g, "");

  // 0912345678 → 251912345678
  if (digits.startsWith("0") && digits.length === 10) {
    digits = "251" + digits.substring(1);
  }

  // 912345678 → 251912345678
  else if (digits.length === 9 && digits.startsWith("9")) {
    digits = "251" + digits;
  }

  // 251912345678 → already correct
  else if (
    digits.startsWith("251") &&
    digits.length === 12
  ) {
    // nothing
  }

  else {
    return null;
  }

  return digits;
};

module.exports = {
  // ── User operations ──
// ============================================================
// GET PENDING WITHDRAWALS
// ============================================================

async getPendingWithdrawals(limit = 5) {

  const { rows } = await pool.query(
    `
    SELECT
      w.id,
      w.user_id,
      w.payment_method_id,
      w.payment_account_id,
      w.approved_by_id,
      w.account_number,
      w.amount,
      w.is_pending,
      w.is_approved,
      w.created_at,
      w.updated_at,

      u.telegram_id,
      u.name,
      u.phone,
      u.balance,

      pm.name AS payment_method,
      pm.amharic_name AS payment_method_amharic,
      pm.emoji AS payment_method_emoji

    FROM withdrawals w

    JOIN users u
      ON w.user_id = u.id

    LEFT JOIN payment_methods pm
      ON w.payment_method_id = pm.id

    WHERE w.is_pending = TRUE
      AND w.is_approved = FALSE

    ORDER BY w.created_at ASC

    LIMIT $1
    `,
    [limit]
  );

  return rows;
},
	// ============================================================
// GET PENDING WITHDRAWALS
// ============================================================

async getPendingWithdrawals(limit = 5) {

  const { rows } = await pool.query(
    `
    SELECT
      w.id,
      w.user_id,
      w.payment_method_id,
      w.payment_account_id,
      w.approved_by_id,
      w.account_number,
      w.amount,
      w.is_pending,
      w.is_approved,
      w.created_at,
      w.updated_at,

      u.telegram_id,
      u.name,
      u.phone,
      u.balance,

      pm.name AS payment_method,
      pm.amharic_name AS payment_method_amharic,
      pm.emoji AS payment_method_emoji

    FROM withdrawals w

    JOIN users u
      ON w.user_id = u.id

    LEFT JOIN payment_methods pm
      ON w.payment_method_id = pm.id

    WHERE w.is_pending = TRUE
      AND w.is_approved = FALSE

    ORDER BY w.created_at ASC

    LIMIT $1
    `,
    [limit]
  );

  return rows;
},
	
async registerUser(telegramId, name, phone) {

  const normalizedPhone =
    normalizeEthiopianPhone(phone);

  if (!normalizedPhone) {
    throw new Error(
      "Invalid Ethiopian phone number"
    );
  }

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    // Check Telegram account
    const telegramResult = await client.query(
      `
      SELECT *
      FROM users
      WHERE telegram_id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [telegramId]
    );

    if (telegramResult.rows.length > 0) {

      await client.query("ROLLBACK");

      return {
        status: "existing_telegram",
        user: telegramResult.rows[0]
      };
    }


    // Check normalized phone
    const phoneResult = await client.query(
      `
      SELECT *
      FROM users
      WHERE phone = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedPhone]
    );


    // Existing Beteseb account
    if (phoneResult.rows.length > 0) {

      const existingUser =
        phoneResult.rows[0];

      const updated = await client.query(
        `
        UPDATE users
        SET telegram_id = $1
        WHERE id = $2
        RETURNING *
        `,
        [
          telegramId,
          existingUser.id
        ]
      );

      await client.query("COMMIT");

      return {
        status: "reconnected",
        user: updated.rows[0]
      };
    }


    // New account
    const newUser = await client.query(
      `
      INSERT INTO users (
        telegram_id,
        name,
        phone,
        balance,
        is_active,
        is_banned
      )
      VALUES (
        $1,
        $2,
        $3,
        0,
        TRUE,
        FALSE
      )
      RETURNING *
      `,
      [
        telegramId,
        name,
        normalizedPhone
      ]
    );


    await client.query("COMMIT");

    return {
      status: "new",
      user: newUser.rows[0]
    };

  } catch (err) {

    await client.query("ROLLBACK");
    throw err;

  } finally {

    client.release();
  }
},
// ============================================================
// APPROVE WITHDRAWAL
// ============================================================

async approveWithdrawal(
  withdrawalId,
  adminTelegramId
) {

  const client =
    await pool.connect();

  try {

    await client.query("BEGIN");

    // --------------------------------------------------------
    // Lock withdrawal + user
    // --------------------------------------------------------

    const { rows } =
      await client.query(
        `
        SELECT
          w.*,

          u.telegram_id,
          u.name,
          u.balance

        FROM withdrawals w

        JOIN users u
          ON w.user_id = u.id

        WHERE w.id = $1
          AND w.is_pending = TRUE
          AND w.is_approved = FALSE

        LIMIT 1

        FOR UPDATE
        `,
        [withdrawalId]
      );

    if (rows.length === 0) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "This withdrawal is no longer pending."
      };
    }

    const withdrawal =
      rows[0];

    const amount =
      Number(withdrawal.amount);

    const balance =
      Number(withdrawal.balance);

    // --------------------------------------------------------
    // Check balance again
    // --------------------------------------------------------

    if (amount > balance) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          `User has insufficient balance. Current balance: ${balance} ETB`
      };
    }

    // --------------------------------------------------------
    // Deduct balance
    // --------------------------------------------------------

    await client.query(
      `
      UPDATE users
      SET balance = balance - $1
      WHERE id = $2
      `,
      [
        amount,
        withdrawal.user_id
      ]
    );

    // --------------------------------------------------------
    // Approve withdrawal
    // --------------------------------------------------------

    const {
      rows: updatedRows
    } = await client.query(
      `
      UPDATE withdrawals

      SET
        is_pending = FALSE,
        is_approved = TRUE,
        approved_by_id = $1,
        updated_at = NOW()

      WHERE id = $2
	  AND is_pending = TRUE
      AND is_approved = FALSE

      RETURNING *
      `,
      [
        adminTelegramId,
        withdrawalId
      ]
    );

    await client.query("COMMIT");

    return {
      success: true,

      withdrawal:
        updatedRows[0],

      telegram_id:
        withdrawal.telegram_id,

      user_name:
        withdrawal.name,

      amount,

      balance_after:
        balance - amount
    };

  } catch (err) {

    await client.query("ROLLBACK");

    console.error(
      "approveWithdrawal error:",
      err
    );

    throw err;

  } finally {

    client.release();
  }
},
	// ============================================================
// REJECT WITHDRAWAL
// ============================================================

async rejectWithdrawal(
  withdrawalId,
  adminTelegramId,
	reason
) {

  const client =
    await pool.connect();

  try {

    await client.query("BEGIN");

    // --------------------------------------------------------
    // Lock withdrawal
    // --------------------------------------------------------

    const { rows } =
      await client.query(
        `
        SELECT
          w.*,

          u.telegram_id,
          u.name

        FROM withdrawals w

        JOIN users u
          ON w.user_id = u.id

        WHERE w.id = $1
          AND w.is_pending = TRUE
          AND w.is_approved = FALSE

        LIMIT 1

        FOR UPDATE
        `,
        [withdrawalId]
      );

    if (rows.length === 0) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "This withdrawal is no longer pending."
      };
    }

    const withdrawal =
      rows[0];

    // --------------------------------------------------------
    // Reject
    // --------------------------------------------------------

    const {
      rows: updatedRows
    } = await client.query(
      `
      UPDATE withdrawals

      SET
        is_pending = FALSE,
        is_approved = FALSE,
        approved_by_id = $1,
		rejection_reason = $3
        updated_at = NOW()

      WHERE id = $2

      RETURNING *
      `,
      [
        adminTelegramId,
        withdrawalId,
		reason  
      ]
    );

    await client.query("COMMIT");

    return {
      success: true,

      withdrawal:
        updatedRows[0],

      telegram_id:
        withdrawal.telegram_id,

      user_name:
        withdrawal.name,

      amount:
        Number(withdrawal.amount)
    };

  } catch (err) {

    await client.query("ROLLBACK");

    console.error(
      "rejectWithdrawal error:",
      err
    );

    throw err;

  } finally {

    client.release();
  }
},
	async getPendingWithdrawals(limit = 5) {

  const { rows } = await pool.query(
    `
    SELECT
      w.id,
      w.user_id,
      w.payment_method_id,
      w.payment_account_id,
      w.approved_by_id,
      w.account_number,
      w.amount,
      w.is_pending,
      w.is_approved,
      w.created_at,
      w.updated_at,

      u.telegram_id,
      u.name,
      u.phone,
      u.balance,

      pm.name AS payment_method,
      pm.amharic_name AS payment_method_amharic,
      pm.emoji AS payment_method_emoji

    FROM withdrawals w

    JOIN users u
      ON w.user_id = u.id

    LEFT JOIN payment_methods pm
      ON w.payment_account_id = pm.id

    WHERE w.is_pending = TRUE
      AND w.is_approved = FALSE

    ORDER BY w.created_at ASC

    LIMIT $1
    `,
    [limit]
  );

  return rows;
},
	
	async reconnectUserByPhone(
  telegramId,
  name,
  phone
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Find existing account by last 9 digits
    const { rows } = await client.query(
      `
      SELECT *
      FROM users
      WHERE RIGHT(phone, 9) = RIGHT($1, 9)
      LIMIT 1
      FOR UPDATE
      `,
      [phone]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        status: "not_found"
      };
    }

    const user = rows[0];

    // Same Telegram account
    if (
      String(user.telegram_id) ===
      String(telegramId)
    ) {
      await client.query("ROLLBACK");

      return {
        status: "same_account",
        user
      };
    }

    // Make sure the new Telegram ID isn't already
    // connected to another user.
    const existingTelegram =
      await client.query(
        `
        SELECT *
        FROM users
        WHERE telegram_id = $1
        LIMIT 1
        `,
        [telegramId]
      );

    if (existingTelegram.rows.length > 0) {
      await client.query("ROLLBACK");

      return {
        status: "telegram_already_used"
      };
    }

    // Reconnect the existing account
    const result = await client.query(
      `
      UPDATE users
      SET
        telegram_id = $1,
        name = $2
      WHERE id = $3
      RETURNING *
      `,
      [
        telegramId,
        name,
        user.id
      ]
    );

    await client.query("COMMIT");

    return {
      status: "reconnected",
      user: result.rows[0]
    };

  } catch (err) {

    await client.query("ROLLBACK");

    console.error(
      "reconnectUserByPhone error:",
      err
    );

    throw err;

  } finally {

    client.release();
  }
},

	async createBroadcastDraft(adminId) {
  await pool.query(`
    INSERT INTO broadcast_drafts (admin_id, status)
    VALUES ($1, 'waiting_image')
    ON CONFLICT (admin_id)
    DO UPDATE SET
      image_url = NULL,
      message = NULL,
      status = 'waiting_image',
      created_at = NOW()
  `, [adminId]);
},

async getBroadcastDraft(adminId) {
  const { rows } = await pool.query(`
    SELECT *
    FROM broadcast_drafts
    WHERE admin_id = $1
  `, [adminId]);

  return rows[0] || null;
},

async updateBroadcastImage(adminId, imageUrl) {
  await pool.query(`
    UPDATE broadcast_drafts
    SET image_url = $2,
        status = 'waiting_message'
    WHERE admin_id = $1
  `, [adminId, imageUrl]);
},

async updateBroadcastMessage(adminId, message) {
  await pool.query(`
    UPDATE broadcast_drafts
    SET message = $2,
        status = 'preview'
    WHERE admin_id = $1
  `, [adminId, message]);
},

async deleteBroadcastDraft(adminId) {
  await pool.query(`
    DELETE FROM broadcast_drafts
    WHERE admin_id = $1
  `, [adminId]);
},

	async getPaymentAccount(paymentMethodId) {
	  const { rows } = await pool.query(`
    SELECT
      pa.*,

      pm.name AS pm_name,
      pm.amharic_name AS pm_amharic_name,
      pm.emoji AS pm_emoji,

      pt.name AS pt_name,
      pt.amharic_name AS pt_amharic_name,
      pt.emoji AS pt_emoji

    FROM payment_accounts pa

    JOIN payment_methods pm
      ON pa.payment_method_id = pm.id

    JOIN payment_types pt
      ON pm.type_id = pt.id

    WHERE pa.is_active = TRUE
      AND pm.is_active = TRUE
      AND pt.is_active = TRUE
	  AND pa.payment_method_id = $1
	  AND pa.balance < pt.maximum_balance

    ORDER BY pa.balance ASC, RANDOM()
    LIMIT 1
    `, [paymentMethodId]);
		return rows[0] || null;
	},

async getAllActiveUsers() {
  const { rows } = await pool.query(`
    SELECT telegram_id
    FROM users
    WHERE is_active = TRUE;
  `);

  return rows;
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
ORDER BY pt.order;
  `);

  return rows;
},

async getPaymentMethodById(pm_id) {
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
    WHERE pa.id = $1
      AND pa.is_active = TRUE
      AND pt.is_active = TRUE
    LIMIT 1
  `, [pm_id]);

  return rows[0] || null;
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
    ORDER BY pa.order
  `);

  return rows;
},

  async approveDepositttttttttttt(receipt,id) {
	  
const  u   = await pool.query('SELECT count(id) FROM deposits WHERE reference=$1', [receipt.receiptNo]);
		 
		if(Number(u.rows[0].count) > 0)
		{
  
		  return -1;
		}
const  {rows: u2}= await pool.query('SELECT id FROM payment_accounts WHERE is_active = TRUE AND RIGHT(account_number,4) = RIGHT($1,4)', [receipt.creditedPartyAccountNo]);
	  if (u2.length === 0) {
  return -2;
     }		
	const u3 = await pool.query('SELECT count(id) FROM payment_accounts WHERE is_active = TRUE AND account_name=$1', [receipt.creditedPartyName]);
		if(Number(u3.rows[0].count) <= 0)
		{
		 
   return -3;
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
	  
	  return depositAmount;
      },

 async transferBalance(
  senderTelegramId,
  recipientTelegramId,
  amount
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock both users while the transfer is being processed
    const { rows } = await client.query(
      `
      SELECT
        telegram_id,
        phone,
        balance,
        is_active,
        is_banned
      FROM users
      WHERE telegram_id IN ($1, $2)
      ORDER BY telegram_id
      FOR UPDATE
      `,
      [
        senderTelegramId,
        recipientTelegramId
      ]
    );

    const sender = rows.find(
      user =>
        String(user.telegram_id) ===
        String(senderTelegramId)
    );

    const recipient = rows.find(
      user =>
        String(user.telegram_id) ===
        String(recipientTelegramId)
    );

    // Sender doesn't exist
    if (!sender) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Sender account not found."
      };
    }

    // Recipient doesn't exist
    if (!recipient) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Recipient account not found."
      };
    }

    // Sender account checks
    if (!sender.is_active || sender.is_banned) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Your account is not active."
      };
    }

    // Recipient account checks
    if (!recipient.is_active || recipient.is_banned) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Recipient account is not active."
      };
    }

    // Cannot transfer to yourself
    if (
      String(sender.telegram_id) ===
      String(recipient.telegram_id)
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "You cannot transfer money to yourself."
      };
    }

    // Convert amount to number
    const transferAmount = Number(amount);

    // Validate amount
    if (
      !Number.isFinite(transferAmount) ||
      transferAmount <= 0
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Invalid transfer amount."
      };
    }

    // Current balances
    const senderBefore = Number(sender.balance);
    const recipientBefore = Number(recipient.balance);

    // Check sender balance
    if (senderBefore < transferAmount) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Insufficient balance."
      };
    }

    // Calculate new balances
    const senderAfter =
      senderBefore - transferAmount;

    const recipientAfter =
      recipientBefore + transferAmount;

    // --------------------------------------------------------
    // UPDATE SENDER BALANCE
    // --------------------------------------------------------

    await client.query(
      `
      UPDATE users
      SET balance = $1
      WHERE telegram_id = $2
      `,
      [
        senderAfter,
        senderTelegramId
      ]
    );

    // --------------------------------------------------------
    // UPDATE RECIPIENT BALANCE
    // --------------------------------------------------------

    await client.query(
      `
      UPDATE users
      SET balance = $1
      WHERE telegram_id = $2
      `,
      [
        recipientAfter,
        recipientTelegramId
      ]
    );

    // --------------------------------------------------------
    // INSERT TRANSFER HISTORY
    // --------------------------------------------------------

    const transferResult = await client.query(
      `
      INSERT INTO transfers (
        sender_telegram_id,
        recipient_telegram_id,
        sender_phone_no,
        recipient_phone_no,
        amount,
        sender_before_amount,
        sender_after_amount,
        recipient_amount_before,
        recipient_amount_after,
        is_active
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        TRUE
      )
      RETURNING *
      `,
      [
        senderTelegramId,
        recipientTelegramId,

        sender.phone,
        recipient.phone,

        transferAmount,

        senderBefore,
        senderAfter,

        recipientBefore,
        recipientAfter
      ]
    );

    // --------------------------------------------------------
    // EVERYTHING SUCCESSFUL
    // --------------------------------------------------------

    await client.query("COMMIT");

    return {
      success: true,
      transfer: transferResult.rows[0],

      senderBefore,
      senderAfter,

      recipientBefore,
      recipientAfter
    };

  } catch (err) {

    // If ANYTHING fails:
    // balances + transfer history are rolled back.
    await client.query("ROLLBACK");

    console.error(
      "transferBalance error:",
      err
    );

    throw err;

  } finally {

    // Return connection to the pool
    client.release();
  }
},
  async getUserByTelegramId(telegramId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE telegram_id=$1 AND is_active=TRUE LIMIT 1', [telegramId]
    );
    return rows[0] || null;
  },

async getUserByPhone(phone) {
  const digits = String(phone).replace(/\D/g, "");

  if (digits.length < 9) {
    return null;
  }

  const last9 = digits.slice(-9);

  const { rows } = await pool.query(
    `
    SELECT
      id,
      telegram_id,
      name,
      phone,
      balance,
      is_banned,
      is_active
    FROM users
    WHERE RIGHT(
      REGEXP_REPLACE(phone, '[^0-9]', '', 'g'),
      9
    ) = $1
      AND is_active = TRUE
      AND is_banned = FALSE
    LIMIT 1
    `,
    [last9]
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
