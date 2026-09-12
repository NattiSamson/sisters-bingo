/**
 * db.js — PostgreSQL database layer for Beteseb Bingo
 *
 * Admin identification:
 *   Uses users.is_admin = TRUE
 *
 * No hard-coded ADMIN_ID is used.
 *
 * Install:
 *   npm install pgf
 *
 * Environment:
 *   DATABASE_URL=postgresql://user:pass@host:5432/beteseb_bingo
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

function normalizeEthiopianPhone(phone) {
  if (!phone) {
    return null;
  }

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
    // already normalized
  }

  else {
    return null;
  }

  return digits;
}

module.exports = {
  // ============================================================
// ADMIN ROLE MANAGEMENT
// ============================================================

async setUserAdminRole(userId, role) {
  const validRoles = [
    "main",
    "statistics",
    "withdrawal",
    "broadcast"
  ];

  if (!validRoles.includes(role)) {
    throw new Error("Invalid admin role");
  }

  const { rows } = await pool.query(
    `
    UPDATE users
    SET
      is_admin = TRUE,
      admin_role = $1
    WHERE id = $2
    RETURNING
      id,
      telegram_id,
      name,
      phone,
      is_admin,
      admin_role,
      is_active,
      is_banned,
      is_blocked
    `,
    [role, userId]
  );

  return rows[0] || null;
},

async removeUserAdminRole(userId) {
  const { rows } = await pool.query(
    `
    UPDATE users
    SET
      is_admin = FALSE,
      admin_role = NULL
    WHERE id = $1
    RETURNING
      id,
      telegram_id,
      name,
      phone,
      is_admin,
      admin_role,
      is_active,
      is_banned,
      is_blocked
    `,
    [userId]
  );

  return rows[0] || null;
},

  // =========================
// ADMIN USER MANAGEMENT
// =========================

async getUserByPhoneForAdmin(phone) {

  const normalizedPhone =
    normalizeEthiopianPhone(phone);

  const result =
    await pool.query(
      `
      SELECT
        id,
        telegram_id,
        name,
        phone,
        balance,
        is_active,
        is_blocked,
        is_admin
      FROM users
      WHERE phone = $1
      AND is_active = TRUE
      AND is_blocked = FALSE
      LIMIT 1
      `,
      [
        normalizedPhone
      ]
    );

  return result.rows[0] || null;
},

async setUserBlocked(userId, isBlocked) {

  const result = await pool.query(
    `
    UPDATE users
    SET is_blocked = $1
    WHERE id = $2
      AND is_admin = FALSE
    RETURNING
      id,
      telegram_id,
      name,
      phone,
      balance,
      is_blocked,
      is_active,
      is_admin
    `,
    [
      isBlocked,
      userId
    ]
  );

  return result.rows[0] || null;
},
  async reactivateUserByTelegramId(telegramId) {

  const result = await pool.query(
    `
    UPDATE users
    SET is_active = TRUE
    WHERE telegram_id = $1
    RETURNING *
    `,
    [telegramId]
  );

  return result.rows[0] || null;
},
  async getUserByTelegramIdIncludingInactive(telegramId) {

  const result = await pool.query(
    `
    SELECT
      id,
      telegram_id,
      name,
      phone,
      balance,
      is_admin,
      is_active,
      is_banned,
      is_blocked
    FROM users
    WHERE telegram_id = $1
    LIMIT 1
    `,
    [telegramId]
  );

  return result.rows[0] || null;
},
  async deactivateUser(telegramId) {

  const result = await pool.query(
    `
    UPDATE users
    SET is_active = FALSE
    WHERE telegram_id = $1
    RETURNING *
    `,
    [telegramId]
  );

  return result.rows[0] || null;
},
  // ============================================================
// USER STATISTICS
// ============================================================

async getUserStatistics(telegramId) {
  const result = await pool.query(
    `
    SELECT
      (
        SELECT COUNT(*)
        FROM deposits d
        WHERE d.user_id = u.id
      ) AS total_deposits,

      (
        SELECT COUNT(*)
        FROM withdrawals w
        WHERE w.user_id = u.id
          AND w.is_pending = TRUE
          AND w.is_approved = FALSE
      ) AS pending_withdrawals,

      (
        SELECT COUNT(*)
        FROM withdrawals w
        WHERE w.user_id = u.id
          AND w.is_pending = FALSE
          AND w.is_approved = TRUE
      ) AS approved_withdrawals,

      (
        SELECT COUNT(*)
        FROM withdrawals w
        WHERE w.user_id = u.id
          AND w.is_pending = FALSE
          AND w.is_approved = FALSE
      ) AS rejected_withdrawals,

      (
        SELECT COUNT(*)
        FROM transfers t
        WHERE t.sender_telegram_id = u.telegram_id
           OR t.recipient_telegram_id = u.telegram_id
      ) AS total_transfers

    FROM users u
    WHERE u.telegram_id = $1
    LIMIT 1
    `,
    [telegramId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    totalDeposits: Number(row.total_deposits || 0),
    pendingWithdrawals: Number(row.pending_withdrawals || 0),
    approvedWithdrawals: Number(row.approved_withdrawals || 0),
    rejectedWithdrawals: Number(row.rejected_withdrawals || 0),
    totalTransfers: Number(row.total_transfers || 0)
  };
},

  // ============================================================
  // USER OPERATIONS
  // ============================================================

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

     // Existing account
if (phoneResult.rows.length > 0) {

  const existingUser =
    phoneResult.rows[0];

  const updated =
    await client.query(
      `
      UPDATE users
      SET
        telegram_id = $1,
        name = $2,
        is_active = TRUE
      WHERE id = $3
      RETURNING *
      `,
      [
        telegramId,
        name,
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
          is_banned,
          is_admin
        )
        VALUES (
          $1,
          $2,
          $3,
          0,
          TRUE,
          FALSE,
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

  async reconnectUserByPhone(
    telegramId,
    name,
    phone
  ) {

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      const { rows } = await client.query(
        `
        SELECT *
        FROM users
        WHERE RIGHT(
          REGEXP_REPLACE(phone, '[^0-9]', '', 'g'),
          9
        ) =
        RIGHT(
          REGEXP_REPLACE($1, '[^0-9]', '', 'g'),
          9
        )
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

      // Make sure new Telegram ID isn't
      // connected to another user
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

// ============================================================
// ADMIN STATISTICS
// ============================================================

async getAdminStatistics() {

  const result = await pool.query(`
    SELECT

      -- WITHDRAWALS
      (
        SELECT COUNT(*)
        FROM withdrawals
        WHERE is_pending = TRUE
          AND is_approved = FALSE
      ) AS pending_withdrawals,

      (
        SELECT COUNT(*)
        FROM withdrawals
        WHERE is_pending = FALSE
          AND is_approved = TRUE
      ) AS approved_withdrawals,

      (
        SELECT COUNT(*)
        FROM withdrawals
        WHERE is_pending = FALSE
          AND is_approved = FALSE
          AND reject_reason IS NOT NULL
      ) AS rejected_withdrawals,


      -- TRANSFERS
      (
        SELECT COUNT(*)
        FROM transfers
      ) AS total_transfers,


      -- USERS
      (
        SELECT COUNT(*)
        FROM users
        WHERE is_active = TRUE
          AND is_blocked = FALSE
      ) AS active_users,

      (
        SELECT COUNT(*)
        FROM users
        WHERE is_active = FALSE
      ) AS inactive_users,

      (
        SELECT COUNT(*)
        FROM users
        WHERE is_blocked = TRUE
      ) AS blocked_users,


      -- ADMINISTRATORS
      (
        SELECT COUNT(*)
        FROM users
        WHERE is_admin = TRUE
          AND is_active = TRUE
          AND is_banned = FALSE
      ) AS administrators
  `);

  const row = result.rows[0];

  return {
    pendingWithdrawals:
      Number(row.pending_withdrawals || 0),

    approvedWithdrawals:
      Number(row.approved_withdrawals || 0),

    rejectedWithdrawals:
      Number(row.rejected_withdrawals || 0),

    totalTransfers:
      Number(row.total_transfers || 0),

    activeUsers:
      Number(row.active_users || 0),

    inactiveUsers:
      Number(row.inactive_users || 0),

    blockedUsers:
      Number(row.blocked_users || 0),

    administrators:
      Number(row.administrators || 0)
  };
},

 async getUserByTelegramId(telegramId) {
    const result = await pool.query(
        `
        SELECT
            id,
            telegram_id,
            name,
            phone,
            balance,
            is_admin,
            admin_role,
            is_active,
            is_banned,
            is_blocked
        FROM users
        WHERE telegram_id = $1
        LIMIT 1
        `,
        [telegramId]
    );

    return result.rows[0] || null;
},
  
  async getUserByPhone(phone) {

    const digits =
      String(phone).replace(/\D/g, "");

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
        is_active,
        is_admin
      FROM users
      WHERE RIGHT(
        REGEXP_REPLACE(
          phone,
          '[^0-9]',
          '',
          'g'
        ),
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
  async isAdmin(telegramId) {
  const result = await pool.query(
    `
    SELECT id
    FROM users
    WHERE telegram_id = $1
      AND is_admin = TRUE
    LIMIT 1
    `,
    [telegramId]
  );

  return result.rows.length > 0;
},

  // ============================================================
  // ADMIN OPERATIONS
  // ============================================================

  /**
   * Find an admin using the users.is_admin column.
   *
   * No ADMIN_ID is required.
   */

async getAdminByTelegramId(telegramId) {
    const { rows } = await pool.query(
        `
        SELECT
            id,
            telegram_id,
            name,
            phone,
            is_admin,
            admin_role,
            is_active,
            is_banned,
            is_blocked
        FROM users
        WHERE telegram_id = $1
          AND is_admin = TRUE
          AND is_active = TRUE
          AND is_banned = FALSE
          AND is_blocked = FALSE
        LIMIT 1
        `,
        [telegramId]
    );

    return rows[0] || null;
},

  async isAdmin(telegramId) {

    const { rows } = await pool.query(
      `
      SELECT id
      FROM users
      WHERE telegram_id = $1
        AND is_admin = TRUE
        AND is_active = TRUE
        AND is_banned = FALSE
      LIMIT 1
      `,
      [telegramId]
    );

    return rows.length > 0;
  },

  async getAllAdmins() {

    const { rows } = await pool.query(
      `
      SELECT
        id,
        telegram_id,
        name,
        phone,
        is_admin,
        is_active
      FROM users
      WHERE is_admin = TRUE
        AND is_active = TRUE
        AND is_banned = FALSE
      ORDER BY id
      `
    );

    return rows;
  },

  // ============================================================
  // BALANCE
  // ============================================================

  async updateBalance(userId, amount) {

    const { rows } = await pool.query(
      `
      UPDATE users
      SET balance = $1
      WHERE id = $2
      RETURNING balance
      `,
      [
        amount,
        userId
      ]
    );

    return rows[0]?.balance;
  },

  async deductStake(userId, amount, gameId) {

    const { rows } = await pool.query(
      `
      SELECT deduct_stake($1,$2,$3)
      `,
      [
        userId,
        amount,
        gameId
      ]
    );

    return rows[0].deduct_stake;
  },

  async awardWin(userId, amount, gameId) {

    const { rows } = await pool.query(
      `
      SELECT award_win($1,$2,$3)
      `,
      [
        userId,
        amount,
        gameId
      ]
    );

    return rows[0].award_win;
  },

  // ============================================================
  // WITHDRAWALS
  // ============================================================

  async createWithdrawal(
    telegramId,
    paymentMethodId,
    accountNumber,
    amount
  ) {

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      // Find and lock user
      const userResult = await client.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          balance
        FROM users
        WHERE telegram_id = $1
          AND is_active = TRUE
          AND is_banned = FALSE
        FOR UPDATE
        `,
        [telegramId]
      );

      if (userResult.rows.length === 0) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message: "አካውንትዎ አልተገኘም።"
        };
      }

      const user =
        userResult.rows[0];

      const currentBalance =
        Number(user.balance);

      const withdrawalAmount =
        Number(amount);

      // Validate amount
      if (
        !Number.isFinite(withdrawalAmount) ||
        withdrawalAmount <= 0
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message: "የተሳሳተ የመውጫ መጠን ነው።"
        };
      }

      if (!Number.isInteger(withdrawalAmount)) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "የመውጫ መጠኑ ሙሉ ቁጥር መሆን አለበት።"
        };
      }

      if (withdrawalAmount < 10) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "ቢያንስ 10 ETB ማውጣት ይችላሉ።"
        };
      }

      // Check balance
      if (withdrawalAmount > currentBalance) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            `በቂ ሂሳብ የሎትም። ` +
            `ያለዎት ሂሳብ፦ ${currentBalance} ETB`
        };
      }

      // Check payment method
      const methodResult =
        await client.query(
          `
          SELECT
            id,
            name,
            amharic_name,
            emoji
          FROM payment_methods
          WHERE id = $1
            AND is_active = TRUE
          `,
          [paymentMethodId]
        );

      if (methodResult.rows.length === 0) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "የክፍያ መንገዱ አልተገኘም።"
        };
      }

      // Validate account
      const cleanAccount =
        String(accountNumber)
          .trim()
          .replace(/[\s\-()]/g, "");

      if (
        !cleanAccount ||
        cleanAccount.length > 20
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "የአካውንት ቁጥሩ ትክክል አይደለም።"
        };
      }

      if (!/^\d+$/.test(cleanAccount)) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "የአካውንት ቁጥሩ ትክክል አይደለም።"
        };
      }

      // Deduct immediately
      const newBalance =
        currentBalance - withdrawalAmount;

      const balanceResult =
        await client.query(
          `
          UPDATE users
          SET balance = $1
          WHERE id = $2
          RETURNING balance
          `,
          [
            newBalance,
            user.id
          ]
        );

      // Create withdrawal
      const withdrawalResult =
        await client.query(
          `
          INSERT INTO withdrawals (
            user_id,
            payment_method_id,
            payment_account_id,
            approved_by_id,
            account_number,
            amount,
            is_pending,
            is_approved,
            reject_reason,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            NULL,
            NULL,
            $3,
            $4,
            TRUE,
            FALSE,
            NULL,
            NOW(),
            NOW()
          )
          RETURNING *
          `,
          [
            user.id,
            paymentMethodId,
            cleanAccount,
            withdrawalAmount
          ]
        );

      await client.query("COMMIT");

      return {
        success: true,

        withdrawal:
          withdrawalResult.rows[0],

        user_id:
          user.id,

        telegram_id:
          user.telegram_id,

        user_name:
          user.name,

        amount:
          withdrawalAmount,

        balance_before:
          currentBalance,

        balance_after:
          Number(
            balanceResult.rows[0].balance
          )
      };

    } catch (err) {

      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Rollback error:",
          rollbackError
        );
      }

      console.error(
        "createWithdrawal error:",
        err
      );

      return {
        success: false,
        message:
          "የመውጫ ጥያቄውን ማስኬድ አልተቻለም።"
      };

    } finally {

      client.release();

    }
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

  // ============================================================
  // APPROVE WITHDRAWAL
  // Admin is identified through is_admin
  // ============================================================

  async approveWithdrawal(
  withdrawalId,
  adminTelegramId,
  paymentAccountId
) {

  const client = await pool.connect();

  try {

    await client.query("BEGIN");


    // ========================================================
    // 1. GET WITHDRAWAL + USER
    // ========================================================

    const withdrawalResult = await client.query(
      `
      SELECT
        w.id,
        w.user_id,
        w.payment_method_id,
        w.payment_account_id,
        w.account_number,
        w.amount,
        w.is_pending,
        w.is_approved,
        w.reject_reason,
        w.created_at,
        w.updated_at,

        u.telegram_id,
        u.name,
        u.balance

      FROM withdrawals w

      INNER JOIN users u
        ON u.id = w.user_id

      WHERE w.id = $1

      FOR UPDATE
      `,
      [
        withdrawalId
      ]
    );


    if (withdrawalResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Withdrawal request not found."
      };

    }


    const withdrawal =
      withdrawalResult.rows[0];


    // ========================================================
    // 2. CHECK PENDING STATUS
    // ========================================================

    if (withdrawal.is_pending !== true) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "This withdrawal has already been processed."
      };

    }


    if (withdrawal.is_approved === true) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "This withdrawal has already been approved."
      };

    }


    // ========================================================
    // 3. GET ADMIN
    // ========================================================

    const adminResult = await client.query(
      `
      SELECT
        id
      FROM users
      WHERE telegram_id = $1
        AND is_admin = TRUE
        AND is_active = TRUE
        AND is_banned = FALSE
      LIMIT 1
      `,
      [
        adminTelegramId
      ]
    );


    if (adminResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Admin account not found."
      };

    }


    const adminId =
      adminResult.rows[0].id;


    // ========================================================
    // 4. VALIDATE PAYMENT ACCOUNT ID
    // ========================================================

    if (
      !paymentAccountId ||
      !Number.isInteger(
        Number(paymentAccountId)
      )
    ) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "A valid payment account must be selected."
      };

    }


    // ========================================================
    // 5. GET + LOCK PAYMENT ACCOUNT
    // ========================================================

    const paymentAccountResult =
      await client.query(
        `
        SELECT
          pa.id,
          pa.payment_method_id,
          pa.account_number,
          pa.account_name,
          pa.balance,
          pa.is_active

        FROM payment_accounts pa

        WHERE pa.id = $1

        FOR UPDATE
        `,
        [
          Number(paymentAccountId)
        ]
      );


    if (
      paymentAccountResult.rows.length === 0
    ) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "Payment account not found."
      };

    }


    const paymentAccount =
      paymentAccountResult.rows[0];


    // ========================================================
    // 6. CHECK PAYMENT ACCOUNT ACTIVE
    // ========================================================

    if (
      paymentAccount.is_active !== true
    ) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "The selected payment account is inactive."
      };

    }


    // ========================================================
    // 7. CHECK PAYMENT METHOD MATCH
    // ========================================================

    if (
      Number(
        paymentAccount.payment_method_id
      ) !==
      Number(
        withdrawal.payment_method_id
      )
    ) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "The selected payment account does not belong to this payment method."
      };

    }


    // ========================================================
    // 8. CHECK PAYMENT ACCOUNT BALANCE
    // ========================================================

    const paymentAccountBalance =
      Number(
        paymentAccount.balance
      );

    const withdrawalAmount =
      Number(
        withdrawal.amount
      );


    if (
      !Number.isFinite(
        withdrawalAmount
      ) ||
      withdrawalAmount <= 0
    ) {

      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "Invalid withdrawal amount."
      };

    }


    if (
      paymentAccountBalance <
      withdrawalAmount
    ) {

      await client.query("ROLLBACK");

      return {
        success: false,

        message:
          `Insufficient balance in payment account ` +
          `${paymentAccount.account_number}. ` +
          `Available: ${paymentAccountBalance} ETB, ` +
          `Required: ${withdrawalAmount} ETB.`
      };

    }


    // ========================================================
    // 9. DEDUCT FROM PAYMENT ACCOUNT
    //
    // IMPORTANT:
    // DO NOT TOUCH users.balance.
    //
    // The user's balance was already deducted
    // when createWithdrawal() was called.
    // ========================================================

    const paymentAccountBalanceAfter =
      paymentAccountBalance -
      withdrawalAmount;


    const paymentAccountUpdate =
      await client.query(
        `
        UPDATE payment_accounts

        SET
          balance = $1

        WHERE id = $2

        RETURNING balance
        `,
        [
          paymentAccountBalanceAfter,
          paymentAccount.id
        ]
      );


    if (
      paymentAccountUpdate.rows.length === 0
    ) {

      throw new Error(
        "Could not update payment account balance."
      );

    }


    // ========================================================
    // 10. APPROVE WITHDRAWAL
    // ========================================================

    const updateResult =
      await client.query(
        `
        UPDATE withdrawals

        SET
          payment_account_id = $1,
          approved_by_id = $2,
          is_pending = FALSE,
          is_approved = TRUE,
          reject_reason = NULL,
          updated_at = NOW()

        WHERE id = $3

          AND is_pending = TRUE

          AND is_approved = FALSE

        RETURNING *
        `,
        [
          paymentAccount.id,
          adminId,
          withdrawalId
        ]
      );


    if (
      updateResult.rows.length === 0
    ) {

      throw new Error(
        "This withdrawal has already been processed."
      );

    }


    // ========================================================
    // 11. COMMIT
    // ========================================================

    await client.query("COMMIT");


    // ========================================================
    // 12. RETURN RESULT
    // ========================================================

    return {

      success: true,

      withdrawal_id:
        withdrawal.id,

      telegram_id:
        withdrawal.telegram_id,

      user_id:
        withdrawal.user_id,

      user_name:
        withdrawal.name,

      amount:
        withdrawalAmount,

      account_number:
        withdrawal.account_number,

      payment_method_id:
        withdrawal.payment_method_id,

      payment_account_id:
        paymentAccount.id,

      payment_account_number:
        paymentAccount.account_number,

      payment_account_balance_before:
        paymentAccountBalance,

      payment_account_balance_after:
        paymentAccountBalanceAfter,

      // User balance was NOT changed during approval
      balance_after:
        Number(withdrawal.balance),

      withdrawal:
        updateResult.rows[0]
    };


  } catch (err) {

    try {

      await client.query(
        "ROLLBACK"
      );

    } catch (rollbackError) {

      console.error(
        "Rollback error:",
        rollbackError
      );

    }


    console.error(
      "approveWithdrawal error:",
      err
    );


    return {

      success: false,

      message:
        err.message ||
        "Withdrawal approval failed."

    };


  } finally {

    client.release();

  }

},
  // ============================================================
  // REJECT WITHDRAWAL
  // Admin is identified through is_admin
  // ============================================================

  async rejectWithdrawal(
    withdrawalId,
    adminTelegramId,
    reason
  ) {

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      const withdrawalResult =
        await client.query(
          `
          SELECT
            w.id,
            w.user_id,
            w.payment_method_id,
            w.payment_account_id,
            w.approved_by_id,
            w.amount,
            w.account_number,
            w.is_pending,
            w.is_approved,
            w.reject_reason,
            u.telegram_id,
            u.name,
            u.balance

          FROM withdrawals w

          INNER JOIN users u
            ON u.id = w.user_id

          WHERE w.id = $1

          FOR UPDATE
          `,
          [withdrawalId]
        );

      if (
        withdrawalResult.rows.length === 0
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "Withdrawal request not found."
        };
      }

      const withdrawal =
        withdrawalResult.rows[0];

      if (
        withdrawal.is_approved === true
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "This withdrawal has already been approved."
        };
      }

      if (withdrawal.is_approved === true) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "This withdrawal has already been processed."
        };
      }

      if (
        withdrawal.is_pending === false
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "This withdrawal has already been processed."
        };
      }

      // Find admin through is_admin
      const adminResult =
        await client.query(
          `
          SELECT id
          FROM users
          WHERE telegram_id = $1
            AND is_admin = TRUE
            AND is_active = TRUE
            AND is_banned = FALSE
          LIMIT 1
          `,
          [adminTelegramId]
        );

      if (
        adminResult.rows.length === 0
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "Admin account not found."
        };
      }

      const adminId =
        adminResult.rows[0].id;

      // Refund amount
      const balanceResult =
        await client.query(
          `
          UPDATE users
          SET balance = balance + $1
          WHERE id = $2
          RETURNING balance
          `,
          [
            withdrawal.amount,
            withdrawal.user_id
          ]
        );

      if (
        balanceResult.rows.length === 0
      ) {

        throw new Error(
          "Could not refund user balance."
        );
      }

      const balanceAfter =
        balanceResult.rows[0].balance;

      // Mark rejected
      const updateResult =
        await client.query(
          `
          UPDATE withdrawals
          SET
            approved_by_id = $1,
            is_pending = FALSE,
            is_approved = FALSE,
            reject_reason = $2,
            updated_at = NOW()

          WHERE id = $3

          RETURNING *
          `,
          [
            adminId,
            reason,
            withdrawalId
          ]
        );

      if (
        updateResult.rows.length === 0
      ) {

        throw new Error(
          "Could not update withdrawal."
        );
      }

      await client.query("COMMIT");

      return {
        success: true,

        withdrawal_id:
          withdrawal.id,

        telegram_id:
          withdrawal.telegram_id,

        user_name:
          withdrawal.name,

        amount:
          withdrawal.amount,

        balance_after:
          balanceAfter,

        rejection_reason:
          reason,

        withdrawal:
          updateResult.rows[0]
      };

    } catch (err) {

      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Rollback error:",
          rollbackError
        );
      }

      console.error(
        "rejectWithdrawal error:",
        err
      );

      return {
        success: false,
        message:
          err.message ||
          "Withdrawal rejection failed."
      };

    } finally {

      client.release();

    }
  },

  // ============================================================
  // BROADCAST
  // ============================================================

  async createBroadcastDraft(adminId) {

    await pool.query(
      `
      INSERT INTO broadcast_drafts (
        admin_id,
        status
      )
      VALUES (
        $1,
        'waiting_image'
      )

      ON CONFLICT (admin_id)
      DO UPDATE SET
        image_url = NULL,
        message = NULL,
        status = 'waiting_image',
        created_at = NOW()
      `,
      [adminId]
    );
  },

  async getBroadcastDraft(adminId) {

    const { rows } =
      await pool.query(
        `
        SELECT *
        FROM broadcast_drafts
        WHERE admin_id = $1
        `,
        [adminId]
      );

    return rows[0] || null;
  },

  async updateBroadcastImage(
    adminId,
    imageUrl
  ) {

    await pool.query(
      `
      UPDATE broadcast_drafts
      SET
        image_url = $2,
        status = 'waiting_message'
      WHERE admin_id = $1
      `,
      [
        adminId,
        imageUrl
      ]
    );
  },

  async updateBroadcastMessage(
    adminId,
    message
  ) {

    await pool.query(
      `
      UPDATE broadcast_drafts
      SET
        message = $2,
        status = 'preview'
      WHERE admin_id = $1
      `,
      [
        adminId,
        message
      ]
    );
  },

  async deleteBroadcastDraft(adminId) {

    await pool.query(
      `
      DELETE FROM broadcast_drafts
      WHERE admin_id = $1
      `,
      [adminId]
    );
  },

  // ============================================================
  // PAYMENT ACCOUNTS
  // ============================================================

  async getPaymentAccount(
    paymentMethodId
  ) {

    const { rows } =
      await pool.query(
        `
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

        ORDER BY
          pa.balance ASC,
          RANDOM()

        LIMIT 1
        `,
        [paymentMethodId]
      );

    return rows[0] || null;
  },

  // ============================================================
// GET ALL PAYMENT ACCOUNTS FOR ADMIN SELECTION
// ============================================================

async getPaymentAccountsByMethod(
  paymentMethodId
) {

  const { rows } =
    await pool.query(

      `
      SELECT

        pa.id,

        pa.payment_method_id,

        pa.account_number,

        pa.account_name,

        pa.balance,

        pa.is_active,
        
        pa.is_removed,

        pm.name AS pm_name,

        pm.amharic_name AS pm_amharic_name,

        pm.emoji AS pm_emoji,

        pt.name AS pt_name,

        pt.amharic_name AS pt_amharic_name,

        pt.emoji AS pt_emoji

      FROM payment_accounts pa

      INNER JOIN payment_methods pm
        ON pa.payment_method_id = pm.id

      INNER JOIN payment_types pt
        ON pm.type_id = pt.id

      WHERE
        pa.payment_method_id = $1

        AND pa.is_active = TRUE

        AND pm.is_active = TRUE

        AND pt.is_active = TRUE

        AND pa.is_removed = FALSE

      ORDER BY
        pa.account_number ASC
      `,

      [paymentMethodId]

    );

  return rows;

},

  // ============================================================
// GET PAYMENT ACCOUNT BY ID
// ============================================================

async getPaymentAccountById(
  paymentAccountId
) {

  const { rows } =
    await pool.query(

      `
      SELECT

        pa.id,

        pa.payment_method_id,

        pa.account_number,

        pa.account_name,

        pa.balance,

        pa.is_active,

        pa.is_removed,

        pm.name AS pm_name,

        pm.amharic_name AS pm_amharic_name,

        pm.emoji AS pm_emoji,

        pt.name AS pt_name,

        pt.amharic_name AS pt_amharic_name,

        pt.emoji AS pt_emoji

      FROM payment_accounts pa

      INNER JOIN payment_methods pm
        ON pa.payment_method_id = pm.id

      INNER JOIN payment_types pt
        ON pm.type_id = pt.id

      WHERE
        pa.id = $1

        AND pa.is_active = TRUE

        AND pm.is_active = TRUE

        AND pt.is_active = TRUE

        AND pa.is_removed = FALSE

      LIMIT 1
      `,

      [paymentAccountId]

    );

  return rows[0] || null;

},

  async getPaymentMethodTypes() {

    const { rows } =
      await pool.query(
        `
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

        ORDER BY pt.order
        `
      );

    return rows;
  },

  async getPaymentMethodById(pm_id) {

    const { rows } =
      await pool.query(
        `
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
        `,
        [pm_id]
      );

    return rows[0] || null;
  },

  async getPaymentMethods() {

    const { rows } =
      await pool.query(
        `
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
        `
      );

    return rows;
  },

    // ============================================================
  // ADMIN — PAYMENT ACCOUNT MANAGEMENT
  // ============================================================

  /**
   * Get ALL payment accounts for admin management.
   *
   * IMPORTANT:
   * Unlike getPaymentAccountsByMethod(), this function
   * intentionally includes inactive accounts.
   */
  // ============================================================
// GET ACTIVE PAYMENT ACCOUNTS FOR ADMIN
// ============================================================
//
// Only display accounts when:
//
// 1. payment_accounts.is_active = TRUE
// 2. payment_methods.is_active = TRUE
// 3. payment_types.is_active = TRUE
// 4. payment_types.is_removed = FALSE
//
// ============================================================

async getAllPaymentAccountsForAdmin() {

  const { rows } =
    await pool.query(
      `
      SELECT

        pa.id,

        pa.payment_method_id,

        pa.account_number,

        pa.account_name,

        pa.balance,

        pa.is_active,

        pa.is_removed,

        pm.name AS pm_name,

        pm.amharic_name AS pm_amharic_name,

        pm.emoji AS pm_emoji,

        pt.name AS pt_name,

        pt.amharic_name AS pt_amharic_name,

        pt.emoji AS pt_emoji

      FROM payment_accounts pa

      INNER JOIN payment_methods pm
        ON pa.payment_method_id = pm.id

      INNER JOIN payment_types pt
        ON pm.type_id = pt.id

      WHERE
        pa.is_active = TRUE

        AND pm.is_active = TRUE

        AND pt.is_active = TRUE

        AND pa.is_removed = FALSE

      ORDER BY
        pm.order ASC,
        pa.id ASC
      `
    );

  return rows;

},


  /**
   * Activate or deactivate an existing payment account.
   *
   * This does NOT:
   * - delete the account
   * - change the balance
   * - change the account number
   * - change the account name
   */
  async setPaymentAccountActive(
    paymentAccountId,
    isActive
  ) {

    const accountId =
      Number(
        paymentAccountId
      );


    if (
      !Number.isInteger(accountId) ||
      accountId <= 0
    ) {

      return null;

    }


    const { rows } =
      await pool.query(
        `
        UPDATE payment_accounts

        SET
          is_active = $1

        WHERE id = $2

        RETURNING
          id,
          payment_method_id,
          account_number,
          account_name,
          balance,
          is_active
        `,
        [
          Boolean(isActive),
          accountId
        ]
      );


    return rows[0] || null;

  },

  // ============================================================
  // DEPOSIT
  // ============================================================

  async approveDepositttttttttttt(
    receipt,
    id
  ) {

    const u =
      await pool.query(
        `
        SELECT count(id)
        FROM deposits
        WHERE reference = $1
        `,
        [receipt.receiptNo]
      );

    if (
      Number(u.rows[0].count) > 0
    ) {
      return -1;
    }

    const { rows: u2 } =
      await pool.query(
        `
        SELECT id
        FROM payment_accounts
        WHERE is_active = TRUE
          AND RIGHT(
            account_number,
            4
          ) =
          RIGHT(
            $1,
            4
          )
        `,
        [receipt.creditedPartyAccountNo]
      );

    if (u2.length === 0) {
      return -2;
    }

    const u3 =
      await pool.query(
        `
        SELECT count(id)
        FROM payment_accounts
        WHERE is_active = TRUE
          AND account_name = $1
        `,
        [receipt.creditedPartyName]
      );

    if (
      Number(u3.rows[0].count) <= 0
    ) {
      return -3;
    }

    console.log(
      "aaaaaa " + id
    );

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          balance
        FROM users
        WHERE telegram_id = $1
        `,
        [id]
      );

    if (rows.length === 0) {
      throw new Error(
        "User not found"
      );
    }

    const depositAmount =
      Number(
        receipt.settledAmount
          .replace(/[^0-9.]/g, "")
      );

    const currentBalance =
      Number(rows[0].balance);

    const amountAfter =
      currentBalance +
      depositAmount;

    console.log(
      "Current balance:",
      currentBalance
    );

    console.log(
      "Deposit amount:",
      depositAmount
    );

    console.log(
      "Amount after:",
      amountAfter
    );

    await pool.query(
      `
      INSERT INTO deposits (
        user_id,
        payment_account_id,
        deposit_method_id,
        depositor_name,
        depositor_account,
        amount,
        amount_after,
        reference,
        created_at
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
        NOW()
      )
      RETURNING id
      `,
      [
        rows[0].id,
        u2[0].id,
        1,
        receipt.payerName,
        receipt.payerTelebirrNo,
        depositAmount,
        amountAfter,
        receipt.receiptNo
      ]
    );

    await pool.query(
      `
      UPDATE users
      SET balance = $1
      WHERE telegram_id = $2
      `,
      [
        amountAfter,
        id
      ]
    );

    await pool.query(
      `
      UPDATE payment_accounts
      SET balance = balance + $1
      WHERE id = $2
      `,
      [
        depositAmount,
        u2[0].id
      ]
    );

    return depositAmount;
  },

  // ============================================================
  // GET ACTIVE USERS
  // ============================================================

  async getAllActiveUsers() {

    const { rows } =
      await pool.query(
        `
        SELECT telegram_id
        FROM users
        WHERE is_active = TRUE
        `
      );

    return rows;
  },

  // ============================================================
  // TRANSFERS
  // ============================================================

  async transferBalance(
    senderTelegramId,
    recipientTelegramId,
    amount
  ) {

    const client =
      await pool.connect();

    try {

      await client.query("BEGIN");

      const { rows } =
        await client.query(
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

      const sender =
        rows.find(
          user =>
            String(user.telegram_id) ===
            String(senderTelegramId)
        );

      const recipient =
        rows.find(
          user =>
            String(user.telegram_id) ===
            String(recipientTelegramId)
        );

      if (!sender) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "Sender account not found."
        };
      }

      if (!recipient) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "Recipient account not found."
        };
      }

      if (
        !sender.is_active ||
        sender.is_banned
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "Your account is not active."
        };
      }

      if (
        !recipient.is_active ||
        recipient.is_banned
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "Recipient account is not active."
        };
      }

      if (
        String(sender.telegram_id) ===
        String(recipient.telegram_id)
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "You cannot transfer money to yourself."
        };
      }

      const transferAmount =
        Number(amount);

      if (
        !Number.isFinite(transferAmount) ||
        transferAmount <= 0
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "Invalid transfer amount."
        };
      }

      const senderBefore =
        Number(sender.balance);

      const recipientBefore =
        Number(recipient.balance);

      if (
        senderBefore <
        transferAmount
      ) {

        await client.query("ROLLBACK");

        return {
          success: false,
          message:
            "Insufficient balance."
        };
      }

      const senderAfter =
        senderBefore -
        transferAmount;

      const recipientAfter =
        recipientBefore +
        transferAmount;

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

      const transferResult =
        await client.query(
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

      await client.query("COMMIT");

      return {
        success: true,

        transfer:
          transferResult.rows[0],

        senderBefore,
        senderAfter,

        recipientBefore,
        recipientAfter
      };

    } catch (err) {

      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Rollback error:",
          rollbackError
        );
      }

      console.error(
        "transferBalance error:",
        err
      );

      throw err;

    } finally {

      client.release();

    }
  },

  // ============================================================
  // GAME OPERATIONS
  // ============================================================

  async createGame(
    roomId,
    stakeId,
    stakeAmount
  ) {

    const { rows } =
      await pool.query(
        `
        INSERT INTO games (
          room_id,
          stake_id,
          stake_amount,
          pot,
          started_at
        )
        VALUES (
          $1,
          $2,
          $3,
          0,
          NOW()
        )
        RETURNING *
        `,
        [
          roomId,
          stakeId,
          stakeAmount
        ]
      );

    return rows[0];
  },

  async addParticipant(
    gameId,
    userId,
    cardId
  ) {

    await pool.query(
      `
      INSERT INTO game_participants (
        game_id,
        user_id,
        card_id
      )
      VALUES (
        $1,
        $2,
        $3
      )

      ON CONFLICT (
        game_id,
        user_id
      )

      DO NOTHING
      `,
      [
        gameId,
        userId,
        cardId
      ]
    );
  },

  async updateGamePot(
    gameId,
    pot
  ) {

    await pool.query(
      `
      UPDATE games
      SET pot = $1
      WHERE id = $2
      `,
      [
        pot,
        gameId
      ]
    );
  },

  async updateCalledNumbers(
    gameId,
    calledNumbers
  ) {

    await pool.query(
      `
      UPDATE games
      SET called_numbers = $1
      WHERE id = $2
      `,
      [
        calledNumbers,
        gameId
      ]
    );
  },

  async endGame(
    gameId,
    winnerUserIds,
    winAmount,
    isSplit
  ) {

    await pool.query(
      `
      UPDATE games

      SET
        status = 'finished',
        winner_ids = $1,
        win_amount = $2,
        is_split = $3,
        ended_at = NOW()

      WHERE id = $4
      `,
      [
        winnerUserIds,
        winAmount,
        isSplit,
        gameId
      ]
    );

    if (
      winnerUserIds.length > 0
    ) {

      await pool.query(
        `
        UPDATE game_participants

        SET
          is_winner = TRUE,
          amount_won = $1

        WHERE game_id = $2
          AND user_id = ANY($3)
        `,
        [
          winAmount,
          gameId,
          winnerUserIds
        ]
      );
    }

    await pool.query(
      `
      UPDATE users
      SET total_games = total_games + 1

      WHERE id IN (
        SELECT user_id
        FROM game_participants
        WHERE game_id = $1
      )
      `,
      [gameId]
    );
  },

  async disqualifyParticipant(
    gameId,
    userId
  ) {

    await pool.query(
      `
      UPDATE game_participants
      SET is_disqualified = TRUE
      WHERE game_id = $1
        AND user_id = $2
      `,
      [
        gameId,
        userId
      ]
    );
  },

  // ============================================================
  // ACTIVE GAME / RECONNECTION
  // ============================================================

  async getActiveGame(roomId) {

    const { rows } =
      await pool.query(
        `
        SELECT
          g.*,

          json_agg(
            json_build_object(
              'user_id',
              gp.user_id,
              'card_id',
              gp.card_id
            )
          ) AS participants

        FROM games g

        JOIN game_participants gp
          ON gp.game_id = g.id

        WHERE g.room_id = $1
          AND g.status = 'playing'

        GROUP BY g.id
        `,
        [roomId]
      );

    return rows[0] || null;
  },

  // ============================================================
  // LEADERBOARD
  // ============================================================

  async getLeaderboard(
    limit = 10
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          name,
          total_wins,
          total_games,
          total_winnings,
          win_rate

        FROM leaderboard

        LIMIT $1
        `,
        [limit]
      );

    return rows;
  }

};
