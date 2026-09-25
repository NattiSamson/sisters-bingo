/**
 * db.js — PostgreSQL database layer for Sisters Bingo
 * Compatible with the current public schema in beteseb-bingo.sql.
 */

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is missing");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

function normalizeEthiopianPhone(phone) {
  if (phone == null) return null;

  let digits = String(phone).replace(/\D/g, "");

  if (!digits) return null;

  if (
    /^09\d{8}$/.test(digits) ||
    /^07\d{8}$/.test(digits)
  ) {
    digits = "251" + digits.slice(1);
  } else if (/^[97]\d{8}$/.test(digits)) {
    digits = "251" + digits;
  }

  return /^251[97]\d{8}$/.test(digits)
    ? digits
    : null;
}

function last9(phone) {
  if (phone == null) return null;

  const digits = String(phone).replace(/\D/g, "");

  return digits.length >= 9
    ? digits.slice(-9)
    : null;
}

function toPositiveInteger(value, field) {
  const n = Number(value);

  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${field}`);
  }

  return n;
}

function toPositiveAmount(value, field = "amount") {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${field}`);
  }

  return n;
}

function amountFromReceipt(receipt) {
  const raw = receipt?.settledAmount;

  if (raw === null || raw === undefined) {
    throw new Error("Deposit amount is missing");
  }

  const cleaned =
    String(raw).replace(/[^0-9.]/g, "");

  const amount = Number(cleaned);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error("Invalid deposit amount");
  }

  return amount;
}

async function safeRollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    console.error(
      "Rollback error:",
      err
    );
  }
}


module.exports = {

  // ============================================================
  // USER LOOKUPS / REGISTRATION
  // ============================================================

  async getUserByTelegramId(telegramId) {

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,
          balance,
          total_games,
          total_wins,
          total_winnings,
          is_admin,
          admin_role,
          is_active,
          is_banned,
          is_blocked,
          created_at,
          last_seen
        FROM users
        WHERE telegram_id = $1
          AND is_active = TRUE
        LIMIT 1
        `,
        [telegramId]
      );

    return rows[0] || null;
  },

  async setBotUserState(
  telegramId,
  stateType,
  stateData
) {
  await pool.query(
    `
    INSERT INTO bot_user_states (
      telegram_id,
      state_type,
      state_data,
      updated_at
    )
    VALUES ($1, $2, $3::jsonb, NOW())

    ON CONFLICT (telegram_id)
    DO UPDATE SET
      state_type = EXCLUDED.state_type,
      state_data = EXCLUDED.state_data,
      updated_at = NOW()
    `,
    [
      telegramId,
      stateType,
      JSON.stringify(stateData || {})
    ]
  );

  return true;
},

async getBotUserState(telegramId) {
  const { rows } = await pool.query(
    `
    SELECT
      telegram_id,
      state_type,
      state_data,
      updated_at
    FROM bot_user_states
    WHERE telegram_id = $1
    `,
    [telegramId]
  );

  if (!rows.length) {
    return null;
  }

  return {
    telegramId: Number(rows[0].telegram_id),
    stateType: rows[0].state_type,
    stateData: rows[0].state_data || {},
    updatedAt: rows[0].updated_at
  };
},

async clearBotUserState(telegramId) {
  await pool.query(
    `
    DELETE FROM bot_user_states
    WHERE telegram_id = $1
    `,
    [telegramId]
  );

  return true;
},

  async getAdminFinancialStatistics() {
  const { rows } = await pool.query(`
    WITH deposit_stats AS (
      SELECT
        d.payment_account_id,
        COUNT(*) AS deposit_count,
        COALESCE(SUM(d.amount), 0) AS deposit_amount
      FROM deposits d
      GROUP BY d.payment_account_id
    ),

    withdrawal_stats AS (
      SELECT
        w.payment_account_id,
        COUNT(*) AS withdrawal_count,
        COALESCE(SUM(w.amount), 0) AS withdrawal_amount
      FROM withdrawals w
      WHERE w.status = 'approved'
        AND w.payment_account_id IS NOT NULL
      GROUP BY w.payment_account_id
    ),

    account_stats AS (
      SELECT
        pa.id AS payment_account_id,
        pa.account_name,
        pa.account_number,
        pa.balance,

        pm.id AS payment_method_id,
        pm.name AS payment_method_name,
        pm.amharic_name AS payment_method_amharic,
        pm.emoji AS payment_method_emoji,

        COALESCE(ds.deposit_count, 0) AS deposit_count,
        COALESCE(ds.deposit_amount, 0) AS deposit_amount,

        COALESCE(ws.withdrawal_count, 0) AS withdrawal_count,
        COALESCE(ws.withdrawal_amount, 0) AS withdrawal_amount

      FROM payment_accounts pa

      JOIN payment_methods pm
        ON pm.id = pa.payment_method_id

      LEFT JOIN deposit_stats ds
        ON ds.payment_account_id = pa.id

      LEFT JOIN withdrawal_stats ws
        ON ws.payment_account_id = pa.id

      WHERE pa.is_removed = FALSE
    )

    SELECT
      payment_account_id,
      account_name,
      account_number,
      balance,

      payment_method_id,
      payment_method_name,
      payment_method_amharic,
      payment_method_emoji,

      deposit_count,
      deposit_amount,

      withdrawal_count,
      withdrawal_amount

    FROM account_stats

    ORDER BY
      payment_method_id ASC,
      payment_account_id ASC
  `);

  const accounts = rows.map((row) => ({
    paymentAccountId:
      Number(row.payment_account_id),

    accountName:
      row.account_name || "Unnamed Account",

    accountNumber:
      row.account_number || "",

    balance:
      Number(row.balance || 0),

    paymentMethodId:
      Number(row.payment_method_id),

    paymentMethodName:
      row.payment_method_name || "Payment Method",

    paymentMethodAmharic:
      row.payment_method_amharic || "",

    paymentMethodEmoji:
      row.payment_method_emoji || "💳",

    depositCount:
      Number(row.deposit_count || 0),

    depositAmount:
      Number(row.deposit_amount || 0),

    withdrawalCount:
      Number(row.withdrawal_count || 0),

    withdrawalAmount:
      Number(row.withdrawal_amount || 0)
  }));

  const totalDepositCount =
    accounts.reduce(
      (sum, account) =>
        sum + account.depositCount,
      0
    );

  const totalDepositAmount =
    accounts.reduce(
      (sum, account) =>
        sum + account.depositAmount,
      0
    );

  const totalWithdrawalCount =
    accounts.reduce(
      (sum, account) =>
        sum + account.withdrawalCount,
      0
    );

  const totalWithdrawalAmount =
    accounts.reduce(
      (sum, account) =>
        sum + account.withdrawalAmount,
      0
    );

  return {
    accounts,

    totalDepositCount,
    totalDepositAmount,

    totalWithdrawalCount,
    totalWithdrawalAmount
  };
},

  async getUserByTelegramIdIncludingInactive(
    telegramId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,
          balance,
          total_games,
          total_wins,
          total_winnings,
          is_admin,
          admin_role,
          is_active,
          is_banned,
          is_blocked,
          created_at,
          last_seen
        FROM users
        WHERE telegram_id = $1
        LIMIT 1
        `,
        [telegramId]
      );

    return rows[0] || null;
  },

  async getUserByPhone(phone) {

    const normalized =
      normalizeEthiopianPhone(phone);

    const searchLast9 =
      last9(normalized || phone);

    if (!searchLast9) {
      return null;
    }

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,
          balance,
          is_banned,
          is_active,
          is_admin,
          is_blocked,
          admin_role
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
          AND is_blocked = FALSE
        LIMIT 1
        `,
        [searchLast9]
      );

    return rows[0] || null;
  },

  async getUserByPhoneForAdmin(phone) {

    const searchLast9 =
      last9(phone);

    if (!searchLast9) {
      return null;
    }

    const { rows } =
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
          is_admin,
          admin_role,
          is_banned
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
        LIMIT 1
        `,
        [searchLast9]
      );

    return rows[0] || null;
  },

  async registerUser(
    telegramId,
    name,
    phone
  ) {

    const normalizedPhone =
      normalizeEthiopianPhone(phone);

    if (!normalizedPhone) {
      throw new Error(
        "Invalid Ethiopian phone number"
      );
    }

    const client =
      await pool.connect();

    try {

      await client.query("BEGIN");

      const telegramResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          LIMIT 1
          FOR UPDATE
          `,
          [telegramId]
        );

      if (
        telegramResult.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status:
            "existing_telegram",
          user:
            telegramResult.rows[0]
        };
      }

      const phoneResult =
        await client.query(
          `
          SELECT *
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
          LIMIT 1
          FOR UPDATE
          `,
          [normalizedPhone.slice(-9)]
        );

      if (
        phoneResult.rows.length
      ) {

        const existingUser =
          phoneResult.rows[0];

        if (
          existingUser.is_banned
        ) {

          await client.query(
            "ROLLBACK"
          );

          return {
            status: "banned",
            user: existingUser
          };
        }

        const updated =
          await client.query(
            `
            UPDATE users
            SET
              telegram_id = $1,
              name = $2,
              phone = $3,
              is_active = TRUE,
              last_seen = NOW()
            WHERE id = $4
            RETURNING *
            `,
            [
              telegramId,
              name,
              normalizedPhone,
              existingUser.id
            ]
          );

        await client.query(
          "COMMIT"
        );

        return {
          status: "reconnected",
          user: updated.rows[0]
        };
      }

      const inserted =
        await client.query(
          `
          INSERT INTO users (
            telegram_id,
            name,
            phone,
            balance,
            is_active,
            is_banned,
            is_admin,
            is_blocked,
            last_seen
          )
          VALUES (
            $1,
            $2,
            $3,
            0,
            TRUE,
            FALSE,
            FALSE,
            FALSE,
            NOW()
          )
          RETURNING *
          `,
          [
            telegramId,
            name,
            normalizedPhone
          ]
        );

      await client.query(
        "COMMIT"
      );

      return {
        status: "new",
        user: inserted.rows[0]
      };

    } catch (err) {

      await safeRollback(
        client
      );

      if (
        err.code === "23505"
      ) {

        return {
          status: "already_exists",
          user: null
        };
      }

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

    const searchLast9 =
      last9(phone);

    if (!searchLast9) {
      return {
        status: "not_found"
      };
    }

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      const { rows } =
        await client.query(
          `
          SELECT *
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
          LIMIT 1
          FOR UPDATE
          `,
          [searchLast9]
        );

      if (!rows.length) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status: "not_found"
        };
      }

      const user =
        rows[0];

      if (user.is_banned) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status: "banned",
          user
        };
      }

      if (
        String(user.telegram_id) ===
        String(telegramId)
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status: "same_account",
          user
        };
      }

      /*
       * SECURITY:
       * Do not allow an active account to be
       * taken over simply by knowing its phone.
       */
      if (user.is_active) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status: "account_active",
          user
        };
      }

      const existingTelegram =
        await client.query(
          `
          SELECT id
          FROM users
          WHERE telegram_id = $1
          LIMIT 1
          `,
          [telegramId]
        );

      if (
        existingTelegram.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          status:
            "telegram_already_used"
        };
      }

      const updated =
        await client.query(
          `
          UPDATE users
          SET
            telegram_id = $1,
            name = $2,
            is_active = TRUE,
            last_seen = NOW()
          WHERE id = $3
          RETURNING *
          `,
          [
            telegramId,
            name,
            user.id
          ]
        );

      await client.query(
        "COMMIT"
      );

      return {
        status: "reconnected",
        user: updated.rows[0]
      };

    } catch (err) {

      await safeRollback(
        client
      );

      throw err;

    } finally {

      client.release();

    }
  },

  async reactivateUserByTelegramId(
    telegramId
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE users
        SET
          is_active = TRUE,
          last_seen = NOW()
        WHERE telegram_id = $1
          AND is_banned = FALSE
        RETURNING *
        `,
        [telegramId]
      );

    return rows[0] || null;
  },

  async deactivateUser(
    telegramId
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE users
        SET is_active = FALSE
        WHERE telegram_id = $1
          AND is_admin = FALSE
        RETURNING *
        `,
        [telegramId]
      );

    return rows[0] || null;
  },

  // ============================================================
  // ADMIN / USER MANAGEMENT
  // ============================================================

  async getAdminByTelegramId(
    telegramId
  ) {

    const { rows } =
      await pool.query(
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

  async isAdmin(
    telegramId
  ) {

    const admin =
      await this.getAdminByTelegramId(
        telegramId
      );

    return !!admin;
  },

  async getAllAdmins() {

    const { rows } =
      await pool.query(
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
        WHERE is_admin = TRUE
          AND is_active = TRUE
          AND is_banned = FALSE
          AND is_blocked = FALSE
        ORDER BY id
        `
      );

    return rows;
  },

  async setUserAdminRole(
    userId,
    role
  ) {

    const validRoles = [
      "main",
      "statistics",
      "withdrawal",
      "broadcast"
    ];

    if (
      !validRoles.includes(role)
    ) {
      throw new Error(
        "Invalid admin role"
      );
    }

    const { rows } =
      await pool.query(
        `
        UPDATE users
        SET
          is_admin = TRUE,
          admin_role = $1
        WHERE id = $2
          AND is_active = TRUE
          AND is_banned = FALSE
          AND is_blocked = FALSE
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
        [
          role,
          userId
        ]
      );

    return rows[0] || null;
  },

  async removeUserAdminRole(
    userId
  ) {

    const { rows } =
      await pool.query(
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

  async setUserBlocked(
    userId,
    isBlocked
  ) {

    const { rows } =
      await pool.query(
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
          is_admin,
          is_banned
        `,
        [
          Boolean(isBlocked),
          userId
        ]
      );

    return rows[0] || null;
  },

  // ============================================================
  // USER STATISTICS
  // ============================================================

  async getUserStatistics(
    telegramId
  ) {

    const { rows } =
      await pool.query(
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
              AND w.status IN ('pending', 'processing')
          ) AS pending_withdrawals,

          (
            SELECT COUNT(*)
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status = 'approved'
          ) AS approved_withdrawals,

          (
            SELECT COUNT(*)
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status = 'rejected'              
          ) AS rejected_withdrawals

        FROM users u

        WHERE u.telegram_id = $1
          AND u.is_active = TRUE

        LIMIT 1
        `,
        [telegramId]
      );

    if (!rows.length) {
      return null;
    }

    const r = rows[0];

    return {
      totalDeposits:
        Number(r.total_deposits || 0),

      pendingWithdrawals:
        Number(
          r.pending_withdrawals || 0
        ),

      approvedWithdrawals:
        Number(
          r.approved_withdrawals || 0
        ),

      rejectedWithdrawals:
        Number(
          r.rejected_withdrawals || 0
        )
    };
  },

  async getUserFinancialStatistics(
    userId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT

          (
            SELECT COALESCE(
              SUM(d.amount),
              0
            )
            FROM deposits d
            WHERE d.user_id = u.id
          ) AS total_deposit_amount,

          (
            SELECT COALESCE(
              SUM(w.amount),
              0
            )
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status = 'approved'
          ) AS approved_withdrawal_amount,

          (
            SELECT COALESCE(
              SUM(w.amount),
              0
            )
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status IN ('pending', 'processing')
          ) AS pending_withdrawal_amount,

          (
            SELECT COALESCE(
              SUM(w.amount),
              0
            )
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.status = 'rejected'
          ) AS rejected_withdrawal_amount

        FROM users u
        WHERE u.id = $1
        LIMIT 1
        `,
        [userId]
      );

    if (!rows.length) {
      return null;
    }

    const r = rows[0];

    return {
      totalDepositAmount:
        Number(
          r.total_deposit_amount || 0
        ),

      approvedWithdrawalAmount:
        Number(
          r.approved_withdrawal_amount || 0
        ),

      pendingWithdrawalAmount:
        Number(
          r.pending_withdrawal_amount || 0
        ),

      rejectedWithdrawalAmount:
        Number(
          r.rejected_withdrawal_amount || 0
        )
    };
  },

 
  async getAdminStatistics() {

    const { rows } =
      await pool.query(
        `
        SELECT

          (
            SELECT COUNT(*)
            FROM withdrawals
            WHERE status IN ('pending', 'processing')            
          ) AS pending_withdrawals,

          (
            SELECT COUNT(*)
            FROM withdrawals
            WHERE status = 'approved'
          ) AS approved_withdrawals,

          (
            SELECT COUNT(*)
            FROM withdrawals
            WHERE status = 'rejected'
          ) AS rejected_withdrawals,

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_active = TRUE              
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

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_admin = TRUE
              AND is_active = TRUE
              AND is_blocked = FALSE
              AND admin_role = 'main'
          ) AS main_admin,                
                    
          (
            SELECT COUNT(*)
            FROM users
            WHERE is_admin = TRUE
              AND is_active = TRUE
              AND is_blocked = FALSE
              AND admin_role = 'statistics'
          ) AS statistics_admin,

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_admin = TRUE
              AND is_active = TRUE
              AND is_blocked = FALSE
              AND admin_role = 'withdrawal'
          ) AS withdrawal_admin,

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_admin = TRUE
              AND is_active = TRUE
              AND is_blocked = FALSE
              AND admin_role = 'broadcast'
          ) AS broadcast_admin
        `
      );

    const r = rows[0];

    return {
      pendingWithdrawals:
        Number(
          r.pending_withdrawals || 0
        ),

      approvedWithdrawals:
        Number(
          r.approved_withdrawals || 0
        ),

      rejectedWithdrawals:
        Number(
          r.rejected_withdrawals || 0
        ),
      
      activeUsers:
        Number(
          r.active_users || 0
        ),

      inactiveUsers:
        Number(
          r.inactive_users || 0
        ),

      blockedUsers:
        Number(
          r.blocked_users || 0
        ),

      mainAdmin:
        Number(
          r.main_admin || 0
        ),

        statisticsAdmin:
        Number(
          r.statistics_admin || 0
        ),
      
        withdrawalAdmin:
        Number(
          r.withdrawal_admin || 0
        ),

        broadcastAdmin:
        Number(
          r.broadcast_admin || 0
        )
      
    };
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
  const methodId = toPositiveInteger(
    paymentMethodId,
    "paymentMethodId"
  );

  const withdrawalAmount =
    toPositiveAmount(amount);

  if (withdrawalAmount < 10) {
    return {
      success: false,
      message: "Withdrawal amount must be at least 10 ETB."
    };
  }

  const cleanAccount =
    String(accountNumber ?? "")
      .trim()
      .replace(/[\s\-()]/g, "");

  if (!/^\d{1,50}$/.test(cleanAccount)) {
    return {
      success: false,
      message: "Invalid account number."
    };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Find user.
     *
     * Do NOT use users.balance for financial authorization.
     */
    const userResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        name
      FROM users
      WHERE telegram_id = $1
        AND is_active = TRUE        
        AND is_blocked = FALSE
      FOR UPDATE
      `,
      [telegramId]
    );

    if (!userResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Account not found or blocked."
      };
    }

    const user = userResult.rows[0];

    /*
     * Verify payment method.
     */
    const methodResult = await client.query(
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
      [methodId]
    );

    if (!methodResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Payment method not found or inactive."
      };
    }

    /*
     * Create withdrawal request first.
     *
     * Financial transaction is attached immediately afterward.
     */
    const withdrawalResult =
      await client.query(
        `
        INSERT INTO withdrawals (
          user_id,
          payment_method_id,
          payment_account_id,
          approved_by_id,
          rejected_by_id,
          account_number,
          amount,
          status,
          rejection_reason,
          claimed_by_id,
          claimed_at,
          processed_at,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          NULL,
          NULL,
          NULL,
          $3,
          $4,
          'pending',
          NULL,
          NULL,
          NULL,
          NULL,
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          user.id,
          methodId,
          cleanAccount,
          withdrawalAmount
        ]
      );

    const withdrawal =
      withdrawalResult.rows[0];

    /*
     * New wallet accounting.
     *
     * This locks Main wallet and guarantees sufficient funds.
     */
    const transactionResult =
      await client.query(
        `
        SELECT reserve_withdrawal_from_main(
          $1,
          $2,
          $3,
          $4,
          $5
        ) AS transaction_id
        `,
        [
          user.id,
          withdrawalAmount,
          withdrawal.id,
          `withdrawal:reserve:${withdrawal.id}`,
          `Withdrawal request #${withdrawal.id}`
        ]
      );

    const transactionId =
      transactionResult.rows[0]
        ?.transaction_id;

	transactionResult = await client.query(
			  `
			  SELECT
			    id,
			    type,
			    status,
			    amount,
			    source_type,
			    source_id
			  FROM financial_transactions
			  WHERE id = $1
			  FOR UPDATE
			  `,
			  [transactionId]
			);
			
			if (!transactionResult.rows.length) {
			  throw new Error(
			    "Withdrawal reservation transaction not found."
			  );
			}
			
			const financialTransaction =
			  transactionResult.rows[0];
			
			if (financialTransaction.type !== "withdrawal") {
			  throw new Error(
			    "Withdrawal transaction has an invalid transaction type."
			  );
			}
			
			if (financialTransaction.status !== "completed") {
			  throw new Error(
			    "Withdrawal reservation transaction is not completed."
			  );
			}

    /*
     * Connect withdrawal request to ledger transaction.
     */
    await client.query(
      `
      UPDATE withdrawals
      SET transaction_id = $1,
          updated_at = NOW()
      WHERE id = $2
      `,
      [
        transactionId,
        withdrawal.id
      ]
    );

    /*
     * Read new Main balance.
     */
    const balanceResult =
      await client.query(
        `
        SELECT wb.balance
        FROM wallet_balances wb
        JOIN wallets w
          ON w.id = wb.wallet_id
        WHERE w.user_id = $1
          AND w.wallet_type = 'main'
        `,
        [user.id]
      );

    const balanceAfter =
      Number(
        balanceResult.rows[0]?.balance || 0
      );

    await client.query("COMMIT");

    return {
      success: true,
      withdrawal: {
        ...withdrawal,
        transaction_id: transactionId
      },
      user_id: user.id,
      telegram_id: user.telegram_id,
      user_name: user.name,
      amount: withdrawalAmount,
      balance_after: balanceAfter
    };

  } catch (err) {

    await safeRollback(client);

    console.error(
      "createWithdrawal error:",
      err
    );

    return {
      success: false,
      message:
        err.message ||
        "Could not create withdrawal request."
    };

  } finally {
    client.release();
  }
},

  async claimPendingWithdrawals(
  adminTelegramId,
  paymentMethodId = null,
  limit = 10
) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 10, 1),
    50
  );

  const methodId = paymentMethodId
    ? toPositiveInteger(
        paymentMethodId,
        "paymentMethodId"
      )
    : null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Verify admin.
     */
    const adminResult = await client.query(
      `
      SELECT id, name, telegram_id
      FROM users
      WHERE telegram_id = $1
        AND is_admin = TRUE
        AND is_active = TRUE
        AND is_banned = FALSE
        AND is_blocked = FALSE
      LIMIT 1
      `,
      [adminTelegramId]
    );

    if (!adminResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Admin account not found."
      };
    }

    const admin = adminResult.rows[0];

    /*
     * 5-minute lease.
     *
     * Expired processing requests become claimable again.
     */
    const result = await client.query(
      `
              WITH candidates AS (
            SELECT
                w.id
            FROM withdrawals w
            WHERE
                (
                    w.status = 'pending'
                    OR (
                        w.status = 'processing'
                        AND w.claimed_at IS NOT NULL
                        AND w.claimed_at < NOW() - INTERVAL '5 minutes'
                    )
                )
                AND (
                    $1::bigint IS NULL
                    OR w.payment_method_id = $1
                )
            ORDER BY
                w.created_at ASC,
                w.id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
        ),
        claimed AS (
            UPDATE withdrawals w
            SET
                status = 'processing',
                claimed_by_id = $3,
                claimed_at = NOW(),
                updated_at = NOW()
            FROM candidates c
            WHERE w.id = c.id
            RETURNING w.*
        )
        SELECT
            c.*,
            u.name
        FROM claimed c
        JOIN users u
            ON u.id = c.user_id
        ORDER BY
            c.created_at ASC,
            c.id ASC
      `,
      [
        methodId,
        safeLimit,
        admin.id
      ]
    );

    await client.query("COMMIT");

    return {
      success: true,
      admin_id: admin.id,
      withdrawals: result.rows,
      count: result.rows.length
    };

  } catch (err) {
    await safeRollback(client);

    console.error(
      "claimPendingWithdrawals error:",
      err
    );

    return {
      success: false,
      message: "Could not claim withdrawals."
    };

  } finally {
    client.release();
  }
},
  
async getPendingWithdrawals(
  limit = 10,
  paymentMethodId = null
) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 10, 1),
    100
  );

  const methodId = paymentMethodId
    ? toPositiveInteger(
        paymentMethodId,
        "paymentMethodId"
      )
    : null;

  const { rows } = await pool.query(
    `
    SELECT
      w.id,
      w.user_id,
      w.payment_method_id,
      w.payment_account_id,

      w.account_number,
      w.amount,
      w.status,
      w.rejection_reason,

      w.created_at,
      w.updated_at,

      u.telegram_id,
      u.name,
      u.phone,

      pm.name AS payment_method,
      pm.amharic_name AS payment_method_amharic,
      pm.emoji AS payment_method_emoji

    FROM withdrawals w

    JOIN users u
      ON u.id = w.user_id

    LEFT JOIN payment_methods pm
      ON pm.id = w.payment_method_id

    WHERE w.status IN ('pending', 'processing')

      AND (
        $1::bigint IS NULL
        OR w.payment_method_id = $1
      )

    ORDER BY
      w.created_at ASC,
      w.id ASC

    LIMIT $2
    `,
    [
      methodId,
      safeLimit
    ]
  );

  return rows;
},
  async renewWithdrawalClaim(
  withdrawalId,
  adminTelegramId
) {
  const result = await pool.query(
    `
    UPDATE withdrawals w
    SET
      claimed_at = NOW(),
      updated_at = NOW()
    FROM users admin
    WHERE w.id = $1
      AND admin.telegram_id = $2
      AND admin.is_admin = TRUE
      AND admin.is_active = TRUE
      AND w.status = 'processing'
      AND w.claimed_by_id = admin.id
    RETURNING w.*
    `,
    [
      withdrawalId,
      adminTelegramId
    ]
  );

  if (!result.rows.length) {
    return {
      success: false,
      message:
        "Withdrawal is not owned by this admin or no longer processing."
    };
  }

  return {
    success: true,
    withdrawal: result.rows[0]
  };
},
async getWithdrawalHistory(
  telegramId,
  limit = 20,
  offset = 0
) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 20, 1),
    100
  );

  const safeOffset = Math.max(
    Number(offset) || 0,
    0
  );

  const { rows } = await pool.query(
    `
    SELECT
      w.id,
      w.amount,
      w.account_number,

      w.status,
      w.rejection_reason,

      w.payment_method_id,
      w.payment_account_id,

      w.approved_by_id,
      w.rejected_by_id,

      w.created_at,
      w.updated_at,
      w.processed_at,

      pm.name AS payment_method,
      pm.amharic_name AS payment_method_amharic,
      pm.emoji AS payment_method_emoji,

      pa.account_number AS payment_account_number,
      pa.account_name AS payment_account_name,

      approved_admin.name AS approved_by_name,
      rejected_admin.name AS rejected_by_name

    FROM withdrawals w

    JOIN users u
      ON u.id = w.user_id

    LEFT JOIN payment_methods pm
      ON pm.id = w.payment_method_id

    LEFT JOIN payment_accounts pa
      ON pa.id = w.payment_account_id

    LEFT JOIN users approved_admin
      ON approved_admin.id = w.approved_by_id

    LEFT JOIN users rejected_admin
      ON rejected_admin.id = w.rejected_by_id

    WHERE u.telegram_id = $1

    ORDER BY
      w.created_at DESC,
      w.id DESC

    LIMIT $2
    OFFSET $3
    `,
    [
      telegramId,
      safeLimit,
      safeOffset
    ]
  );

  return rows;
},

  async getAdminWithdrawalHistory(
  adminTelegramId,
  limit = 50,
  offset = 0
) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 50, 1),
    100
  );

  const safeOffset = Math.max(
    Number(offset) || 0,
    0
  );

  const { rows } = await pool.query(
    `
    SELECT
      w.id,
      w.user_id,
      w.account_number,
      w.amount,
      w.status,
      w.rejection_reason,

      w.payment_method_id,
      w.payment_account_id,

      w.approved_by_id,
      w.rejected_by_id,

      w.created_at,
      w.processed_at,
      w.updated_at,

      u.telegram_id AS user_telegram_id,
      u.name AS user_name,

      pm.name AS payment_method,
      pm.amharic_name AS payment_method_amharic,
      pm.emoji AS payment_method_emoji,

      pa.account_number AS payment_account_number,

      approved_admin.name AS approved_by_name,
      rejected_admin.name AS rejected_by_name

    FROM withdrawals w

    JOIN users u
      ON u.id = w.user_id

    LEFT JOIN payment_methods pm
      ON pm.id = w.payment_method_id

    LEFT JOIN payment_accounts pa
      ON pa.id = w.payment_account_id

    LEFT JOIN users approved_admin
      ON approved_admin.id = w.approved_by_id

    LEFT JOIN users rejected_admin
      ON rejected_admin.id = w.rejected_by_id

    JOIN users requesting_admin
      ON requesting_admin.telegram_id = $1
      AND requesting_admin.is_admin = TRUE
      AND requesting_admin.is_active = TRUE
      AND requesting_admin.is_banned = FALSE
      AND requesting_admin.is_blocked = FALSE

    WHERE
      w.approved_by_id = requesting_admin.id
      OR w.rejected_by_id = requesting_admin.id

    ORDER BY
      w.processed_at DESC NULLS LAST,
      w.id DESC

    LIMIT $2
    OFFSET $3
    `,
    [
      adminTelegramId,
      safeLimit,
      safeOffset
    ]
  );

  return rows;
},
  
  async approveWithdrawal(
  withdrawalId,
  adminTelegramId,
  paymentAccountId
) {
  const withdrawalIdNum =
    toPositiveInteger(
      withdrawalId,
      "withdrawalId"
    );

  const accountId =
    toPositiveInteger(
      paymentAccountId,
      "paymentAccountId"
    );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Verify admin.
     */
    const adminResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        name
      FROM users
      WHERE telegram_id = $1
        AND is_admin = TRUE
        AND is_active = TRUE        
        AND is_blocked = FALSE
      LIMIT 1
      `,
      [adminTelegramId]
    );

    if (!adminResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Admin account not found."
      };
    }

    const admin = adminResult.rows[0];

    /*
     * Lock withdrawal.
     */
    const withdrawalResult = await client.query(
      `
      SELECT
        w.*,
        u.telegram_id,
        u.name        
      FROM withdrawals w
      JOIN users u
        ON u.id = w.user_id
      WHERE w.id = $1
      FOR UPDATE
      `,
      [withdrawalIdNum]
    );

    if (!withdrawalResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Withdrawal request not found."
      };
    }

    const withdrawal = withdrawalResult.rows[0];

    /*
     * Must be actively claimed.
     */
    if (withdrawal.status !== "processing") {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          `Withdrawal is not being processed. Current status: ${withdrawal.status}`
      };
    }

    /*
     * Only the admin who claimed it can approve it.
     */
    if (
      Number(withdrawal.claimed_by_id) !==
      Number(admin.id)
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "This withdrawal is assigned to another admin."
      };
    }

    /*
     * Prevent an expired lease from being approved.
     */
    const claimedAt =
      withdrawal.claimed_at
        ? new Date(withdrawal.claimed_at)
        : null;

    if (
      !claimedAt ||
      Date.now() - claimedAt.getTime() >
        5 * 60 * 1000
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "This withdrawal claim has expired. Please claim it again."
      };
    }

    /*
     * Lock payment account.
     */
    const accountResult = await client.query(
      `
      SELECT
        id,
        payment_method_id,
        account_number,
        account_name,
        balance,
        is_active,
        is_removed
      FROM payment_accounts
      WHERE id = $1
      FOR UPDATE
      `,
      [accountId]
    );

    if (!accountResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Payment account not found."
      };
    }

    const account = accountResult.rows[0];

    if (
      !account.is_active ||
      account.is_removed
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "Selected payment account is inactive or removed."
      };
    }

    if (
      Number(account.payment_method_id) !==
      Number(withdrawal.payment_method_id)
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "Payment account does not match the withdrawal method."
      };
    }

    const amount =
      Number(withdrawal.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Invalid withdrawal amount."
      };
    }

    const accountBalance =
      Number(account.balance || 0);

    if (accountBalance < amount) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "Insufficient payment-account balance."
      };
    }

    const accountAfter =
      accountBalance - amount;

    /*
     * Deduct from the payment account.
     */
    await client.query(
      `
      UPDATE payment_accounts
      SET balance = balance - $1
      WHERE id = $2
      `,
      [
        amount,
        account.id
      ]
    );

    /*
     * Final state.
     *
     * Your actual database uses 'approved',
     * NOT 'completed'.
     */
    const updateResult = await client.query(
      `
      UPDATE withdrawals
      SET
        payment_account_id = $1,
        approved_by_id = $2,
        rejected_by_id = NULL,
        status = 'approved',
        rejection_reason = NULL,
        claimed_by_id = NULL,
        claimed_at = NULL,
        processed_at = NOW(),
        updated_at = NOW()
      WHERE id = $3
        AND status = 'processing'
        AND claimed_by_id = $2
      RETURNING *
      `,
      [
        account.id,
        admin.id,
        withdrawalIdNum
      ]
    );

    if (!updateResult.rows.length) {
      throw new Error(
        "Withdrawal could not be completed."
      );
    }

    await client.query("COMMIT");

    const approvedWithdrawal =
      updateResult.rows[0];

    return {
      success: true,

      withdrawal_id:
        approvedWithdrawal.id,

      telegram_id:
        withdrawal.telegram_id,

      user_id:
        withdrawal.user_id,

      user_name:
        withdrawal.name,

      amount,

      account_number:
        withdrawal.account_number,

      payment_method_id:
        withdrawal.payment_method_id,

      payment_account_id:
        account.id,

      payment_account_number:
        account.account_number,

      payment_account_balance_before:
        accountBalance,

      payment_account_balance_after:
        accountAfter,

      balance_after:
        Number(withdrawal.balance),

      withdrawal:
        approvedWithdrawal
    };

  } catch (err) {
    await safeRollback(client);

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


async rejectWithdrawal(
  withdrawalId,
  adminTelegramId,
  reason
) {
  const withdrawalIdNum =
    toPositiveInteger(
      withdrawalId,
      "withdrawalId"
    );

  const cleanReason =
    String(
      reason || "Rejected by admin"
    )
      .trim()
      .slice(0, 100);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Verify admin.
     */
    const adminResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        name
      FROM users
      WHERE telegram_id = $1
        AND is_admin = TRUE
        AND is_active = TRUE
        AND is_banned = FALSE
        AND is_blocked = FALSE
      LIMIT 1
      `,
      [adminTelegramId]
    );

    if (!adminResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Admin account not found."
      };
    }

    const admin = adminResult.rows[0];

    /*
     * Lock the withdrawal and its user.
     *
     * We need the transaction_id because the refund
     * must reverse the original withdrawal transaction.
     */
    const withdrawalResult = await client.query(
      `
      SELECT
        w.*,
        u.telegram_id,
        u.name
      FROM withdrawals w
      JOIN users u
        ON u.id = w.user_id
      WHERE w.id = $1
      FOR UPDATE
      `,
      [withdrawalIdNum]
    );

    if (!withdrawalResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "Withdrawal request not found."
      };
    }

    const withdrawal =
      withdrawalResult.rows[0];

    /*
     * A withdrawal can only be rejected while it
     * is actively assigned to an admin.
     */
    if (withdrawal.status !== "processing") {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          `Withdrawal is not being processed. Current status: ${withdrawal.status}`
      };
    }

    /*
     * Make sure this admin owns the claim.
     */
    if (
      Number(withdrawal.claimed_by_id) !==
      Number(admin.id)
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "This withdrawal is assigned to another admin."
      };
    }

    /*
     * Check claim lease.
     *
     * Keep the existing 5-minute claim rule.
     */
    const claimedAt =
      withdrawal.claimed_at
        ? new Date(withdrawal.claimed_at)
        : null;

    if (
      !claimedAt ||
      Date.now() - claimedAt.getTime() >
        5 * 60 * 1000
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "This withdrawal claim has expired. Please claim it again."
      };
    }

    /*
     * The withdrawal must have an original financial
     * transaction because the refund is now handled
     * by the wallet/ledger system.
     */
    if (!withdrawal.transaction_id) {
      throw new Error(
        "Withdrawal has no financial transaction to refund."
      );
    }

    /*
     * Refund the original withdrawal through the
     * wallet ledger.
     *
     * This reverses the original Main-wallet debit.
     *
     * Idempotency key prevents the same withdrawal
     * from being refunded twice.
     */
    const refundResult = await client.query(
      `
      SELECT refund_withdrawal(
        $1,
        $2,
        $3,
        $4,
        $5
      ) AS transaction_id
      `,
      [
        withdrawal.user_id,
        withdrawal.id,
        withdrawal.transaction_id,
        `withdrawal:refund:${withdrawal.id}`,
        `Withdrawal #${withdrawal.id} rejected`
      ]
    );

    const refundTransactionId =
      refundResult.rows[0]?.transaction_id;

    if (!refundTransactionId) {
      throw new Error(
        "Could not create withdrawal refund transaction."
      );
    }

    /*
     * Mark the withdrawal as rejected.
     *
     * Clear the claim because the withdrawal is no
     * longer being processed.
     */
    const updateResult = await client.query(
      `
      UPDATE withdrawals
      SET
        rejected_by_id = $1,
        approved_by_id = NULL,
        status = 'rejected',
        rejection_reason = $2,
        claimed_by_id = NULL,
        claimed_at = NULL,
        processed_at = NOW(),
        updated_at = NOW()
      WHERE id = $3
        AND status = 'processing'
        AND claimed_by_id = $1
      RETURNING *
      `,
      [
        admin.id,
        cleanReason,
        withdrawalIdNum
      ]
    );

    if (!updateResult.rows.length) {
      throw new Error(
        "Could not update withdrawal."
      );
    }

    /*
     * Get the user's current wallet balances.
     *
     * users.balance is no longer used as the source
     * of truth for financial accounting.
     */
    const walletResult = await client.query(
      `
      SELECT
        main_balance,
        play_balance,
        total_balance
      FROM user_wallet_balances
      WHERE user_id = $1
      `,
      [withdrawal.user_id]
    );

    const walletBalances =
      walletResult.rows[0] || {
        main_balance: 0,
        play_balance: 0,
        total_balance: 0
      };

    await client.query("COMMIT");

    const rejectedWithdrawal =
      updateResult.rows[0];

    return {
      success: true,

      withdrawal_id:
        rejectedWithdrawal.id,

      telegram_id:
        withdrawal.telegram_id,

      user_id:
        withdrawal.user_id,

      user_name:
        withdrawal.name,

      amount:
        Number(withdrawal.amount),

      balance_after:
        Number(walletBalances.total_balance || 0),

      main_balance:
        Number(walletBalances.main_balance || 0),

      play_balance:
        Number(walletBalances.play_balance || 0),

      total_balance:
        Number(walletBalances.total_balance || 0),

      rejection_reason:
        cleanReason,

      refund_transaction_id:
        refundTransactionId,

      withdrawal:
        rejectedWithdrawal
    };

  } catch (err) {
    await safeRollback(client);

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
// BROADCAST DRAFTS
// ============================================================

async createBroadcastDraft(adminId) {
  await pool.query(
    `
    INSERT INTO broadcast_drafts (
      admin_id,
      image_url,
      message,
      button_title,
      include_image,
      include_text,
      include_button,
      status
    )
    VALUES (
      $1,
      NULL,
      NULL,
      NULL,
      FALSE,
      FALSE,
      FALSE,
      'selecting_content'
    )
    ON CONFLICT (admin_id)
    DO UPDATE SET
      image_url = NULL,
      message = NULL,
      button_title = NULL,
      include_image = FALSE,
      include_text = FALSE,
      include_button = FALSE,
      status = 'selecting_content',
      created_at = NOW()
    `,
    [adminId]
  );
},

async getBroadcastDraft(adminId) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM broadcast_drafts
    WHERE admin_id = $1
    LIMIT 1
    `,
    [adminId]
  );

  return rows[0] || null;
},

async updateBroadcastOptions(
  adminId,
  includeImage,
  includeText,
  includeButton
) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET
      include_image = $2,
      include_text = $3,
      include_button = $4,
      status = 'building'
    WHERE admin_id = $1
    `,
    [
      adminId,
      Boolean(includeImage),
      Boolean(includeText),
      Boolean(includeButton)
    ]
  );
},

async updateBroadcastImage(adminId, imageUrl) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET image_url = $2
    WHERE admin_id = $1
    `,
    [
      adminId,
      imageUrl
    ]
  );
},

async updateBroadcastMessage(adminId, message) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET message = $2
    WHERE admin_id = $1
    `,
    [
      adminId,
      message
    ]
  );
},

async updateBroadcastButtonTitle(adminId, buttonTitle) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET button_title = $2
    WHERE admin_id = $1
    `,
    [
      adminId,
      buttonTitle
    ]
  );
},

async updateBroadcastStatus(adminId, status) {
  await pool.query(
    `
    UPDATE broadcast_drafts
    SET status = $2
    WHERE admin_id = $1
    `,
    [
      adminId,
      status
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

async getAllActiveUsers() {
  const { rows } = await pool.query(
    `
    SELECT telegram_id
    FROM users
    WHERE is_active = TRUE
      AND is_blocked = FALSE
      AND is_banned = FALSE
    `
  );

  return rows;
},

  // ============================================================
  // PAYMENT TYPES / METHODS / ACCOUNTS
  // ============================================================

  async getPaymentMethodTypes() {

    const { rows } =
      await pool.query(
        `
        SELECT
          pt.id,
          pt.name,
          pt.amharic_name,
          pt.emoji,
          pt.maximum_balance,
          pt."order",
          pt.is_active

        FROM payment_types pt

        WHERE pt.is_active = TRUE

          AND EXISTS (
            SELECT 1
            FROM payment_methods pm
            WHERE pm.type_id = pt.id
              AND pm.is_active = TRUE
          )

        ORDER BY
          pt."order" NULLS LAST,
          pt.id
        `
      );

    return rows;
  },

    async getPaymentMethodTypesById(paymentTypeId) {

    const { rows } =
      await pool.query(
        `
        SELECT
          pt.id,          
          pt.name,
          pt.amharic_name,
          pt.emoji,
          pt.maximum_balance,
          pt."order",
          pt.is_active

        FROM payment_types pt

        WHERE pt.is_active = TRUE
              AND pt.id = $1

          AND EXISTS (
            SELECT 1
            FROM payment_methods pm
            WHERE pm.type_id = pt.id
              AND pm.is_active = TRUE
          )

        ORDER BY
          pt."order" NULLS LAST,
          pt.id
        `,
        [paymentTypeId]
      );

    return rows[0] || null;
  },

  async getPaymentMethods() {

    const { rows } =
      await pool.query(
        `
        SELECT
          pm.id,
          pm.type_id,
          pm.name,
          pm.amharic_name,
          pm.emoji,

          pt.name
            AS type_name,

          pt.amharic_name
            AS am_type_name,

          pt.emoji
            AS type_emoji

        FROM payment_methods pm

        JOIN payment_types pt
          ON pt.id = pm.type_id

        WHERE pm.is_active = TRUE
          AND pt.is_active = TRUE

        ORDER BY
          pm."order",
          pm.id
        `
      );

    return rows;
  },

  async getPaymentMethodById(
    pmId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          pm.id,
          pm.type_id,
          pm.name,
          pm.amharic_name,
          pm.emoji,

          pt.name
            AS type_name,

          pt.amharic_name
            AS am_type_name,

          pt.emoji
            AS type_emoji,

          pt.maximum_balance

        FROM payment_methods pm

        JOIN payment_types pt
          ON pt.id = pm.type_id

        WHERE pm.id = $1
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE

        LIMIT 1
        `,
        [pmId]
      );

    return rows[0] || null;
  },

  async getPaymentAccount(
    paymentMethodId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          pa.*,

          pm.name
            AS pm_name,

          pm.amharic_name
            AS pm_amharic_name,

          pm.emoji
            AS pm_emoji,

          pt.name
            AS pt_name,

          pt.amharic_name
            AS pt_amharic_name,

          pt.emoji
            AS pt_emoji,

          pt.maximum_balance

        FROM payment_accounts pa

        JOIN payment_methods pm
          ON pm.id =
             pa.payment_method_id

        JOIN payment_types pt
          ON pt.id =
             pm.type_id

        WHERE pa.payment_method_id = $1
          AND pa.is_active = TRUE
          AND pa.is_removed = FALSE
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE
          AND (
            pt.maximum_balance IS NULL
            OR pa.balance <
               pt.maximum_balance
          )

        ORDER BY
          pa.balance ASC,
          pa.id ASC

        LIMIT 1
        `,
        [paymentMethodId]
      );

    return rows[0] || null;
  },

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

          pm.name
            AS pm_name,

          pm.amharic_name
            AS pm_amharic_name,

          pm.emoji
            AS pm_emoji,

          pt.name
            AS pt_name,

          pt.amharic_name
            AS pt_amharic_name,

          pt.emoji
            AS pt_emoji

        FROM payment_accounts pa

        JOIN payment_methods pm
          ON pm.id =
             pa.payment_method_id

        JOIN payment_types pt
          ON pt.id =
             pm.type_id

        WHERE pa.payment_method_id = $1
          AND pa.is_active = TRUE
          AND pa.is_removed = FALSE
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE

        ORDER BY
          pa.account_number ASC,
          pa.id ASC
        `,
        [paymentMethodId]
      );

    return rows;
  },

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

          pm.name
            AS pm_name,

          pm.amharic_name
            AS pm_amharic_name,

          pm.emoji
            AS pm_emoji,

          pt.name
            AS pt_name,

          pt.amharic_name
            AS pt_amharic_name,

          pt.emoji
            AS pt_emoji

        FROM payment_accounts pa

        JOIN payment_methods pm
          ON pm.id =
             pa.payment_method_id

        JOIN payment_types pt
          ON pt.id =
             pm.type_id

        WHERE pa.id = $1
          AND pa.is_active = TRUE
          AND pa.is_removed = FALSE
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE

        LIMIT 1
        `,
        [paymentAccountId]
      );

    return rows[0] || null;
  },

  // ============================================================
// GET PAYMENT ACCOUNT BY ID — ADMIN
// Includes inactive and removed accounts.
// ============================================================

async getPaymentAccountByIdForAdmin(
  paymentAccountId
) {

  const id =
    Number(paymentAccountId);

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    return null;
  }

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

        pm.name
          AS pm_name,

        pm.amharic_name
          AS pm_amharic_name,

        pm.emoji
          AS pm_emoji,

        pt.name
          AS pt_name,

        pt.amharic_name
          AS pt_amharic_name,

        pt.emoji
          AS pt_emoji

      FROM payment_accounts pa

      JOIN payment_methods pm
        ON pm.id =
           pa.payment_method_id

      JOIN payment_types pt
        ON pt.id =
           pm.type_id

      WHERE pa.id = $1

      LIMIT 1
      `,
      [id]
    );

  return rows[0] || null;
},
  // ============================================================
// DELETE / UNDELETE PAYMENT ACCOUNT
// Soft delete using is_removed.
// ============================================================

async setPaymentAccountRemoved(
  paymentAccountId,
  isRemoved
) {

  const id =
    Number(paymentAccountId);

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    return null;
  }

  const { rows } =
    await pool.query(
      `
      UPDATE payment_accounts

      SET
        is_removed = $1

      WHERE id = $2

      RETURNING
        id,
        payment_method_id,
        account_number,
        account_name,
        balance,
        is_active,
        is_removed
      `,
      [
        Boolean(isRemoved),
        id
      ]
    );

  return rows[0] || null;
},
  // ============================================================
// UPDATE PAYMENT ACCOUNT
// ============================================================

async updatePaymentAccount(
  paymentAccountId,
  accountName,
  accountNumber,
  balance
) {

  const id =
    Number(paymentAccountId);

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    return null;
  }

  const name =
    String(
      accountName ?? ""
    ).trim();

  const number =
    String(
      accountNumber ?? ""
    ).trim();

  const numericBalance =
    Number(balance);

  if (!name || name.length > 100) {
    throw new Error(
      "Invalid account name."
    );
  }

  if (!number || number.length > 100) {
    throw new Error(
      "Invalid account number."
    );
  }

  if (
    !Number.isFinite(numericBalance) ||
    numericBalance < 0
  ) {
    throw new Error(
      "Invalid account balance."
    );
  }

  const { rows } =
    await pool.query(
      `
      UPDATE payment_accounts

      SET
        account_name = $1,
        account_number = $2,
        balance = $3

      WHERE id = $4

      RETURNING
        id,
        payment_method_id,
        account_number,
        account_name,
        balance,
        is_active,
        is_removed
      `,
      [
        name,
        number,
        numericBalance,
        id
      ]
    );

  return rows[0] || null;
},

  // ============================================================
// PAYMENT ACCOUNTS — ADMIN LIST
// Includes removed accounts so admin can undelete them.
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

        pm.name
          AS pm_name,

        pm.amharic_name
          AS pm_amharic_name,

        pm.emoji
          AS pm_emoji,

        pt.name
          AS pt_name,

        pt.amharic_name
          AS pt_amharic_name,

        pt.emoji
          AS pt_emoji

      FROM payment_accounts pa

      JOIN payment_methods pm
        ON pm.id =
           pa.payment_method_id

      JOIN payment_types pt
        ON pt.id =
           pm.type_id

      WHERE pm.is_active = TRUE
        AND pt.is_active = TRUE

      ORDER BY
        pa.is_removed ASC,
        pm."order" ASC,
        pa.id ASC
      `
    );

  return rows;
},

  async setPaymentAccountActive(
    paymentAccountId,
    isActive
  ) {

    const id =
      Number(paymentAccountId);

    if (
      !Number.isInteger(id) ||
      id <= 0
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
          AND is_removed = FALSE

        RETURNING
          id,
          payment_method_id,
          account_number,
          account_name,
          balance,
          is_active,
          is_removed
        `,
        [
          Boolean(isActive),
          id
        ]
      );

    return rows[0] || null;
  },

  async createPaymentAccount(
    paymentMethodId,
    accountName,
    accountNumber
  ) {

    const methodId =
      toPositiveInteger(
        paymentMethodId,
        "paymentMethodId"
      );

    const name =
      String(
        accountName ?? ""
      ).trim();

    const number =
      String(
        accountNumber ?? ""
      ).trim();

    if (
      !name ||
      name.length > 100
    ) {

      return {
        success: false,
        message:
          "Invalid account name."
      };
    }

    if (
      !number ||
      number.length > 100
    ) {

      return {
        success: false,
        message:
          "Invalid account number."
      };
    }

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      const method =
        await client.query(
          `
          SELECT
            pm.id,
            pt.name
              AS type_name,
            pt.amharic_name
              AS type_amharic_name

          FROM payment_methods pm

          JOIN payment_types pt
            ON pt.id =
               pm.type_id

          WHERE pm.id = $1
            AND pm.is_active = TRUE
            AND pt.is_active = TRUE

          FOR SHARE
          `,
          [methodId]
        );

      if (
        !method.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Payment method not found or inactive."
        };
      }

      const duplicate =
        await client.query(
          `
          SELECT id
          FROM payment_accounts
          WHERE payment_method_id = $1
            AND account_number = $2
            AND is_removed = FALSE
          LIMIT 1
          `,
          [
            methodId,
            number
          ]
        );

      if (
        duplicate.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "This payment account already exists."
        };
      }

      const inserted =
        await client.query(
          `
          INSERT INTO payment_accounts (
            payment_method_id,
            account_name,
            account_number,
            balance,
            is_active,
            is_removed
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
            methodId,
            name,
            number
          ]
        );

      await client.query(
        "COMMIT"
      );

      return {
        success: true,
        account:
          inserted.rows[0]
      };

    } catch (err) {

      await safeRollback(
        client
      );

      console.error(
        "createPaymentAccount error:",
        err
      );

      return {
        success: false,
        message:
          err.message ||
          "Could not create payment account."
      };

    } finally {

      client.release();

    }
  },

  // ============================================================
  // DEPOSITS
  // ============================================================

  /*
   * IMPORTANT:
   * Keep this function name because the current bot.js
   * calls approveDeposit().
   */

  async approveDeposit(
    receipt,
    telegramId
  ) {

    const receiptNo =
      String(
        receipt?.receiptNo ??        
        ""
      ).trim();

    if (receiptNo === undefined || receiptNo === "") {
      console.log(`db.aproveDeposit No receiptNo`);
      return {success:false, errorMessage:"No receiptNo"};
    }

    const amount =
      amountFromReceipt(
        receipt
      );

    if (amount === undefined || amount === "" || amount < 1) {
      console.log(`db.aproveDeposit No amount`);
      return {success:false, errorMessage:"No amount"};
    }

    if (amount > 500) {
      console.log(`db.aproveDeposit amount > 500`);
      return {success:false, errorMessage:"Amount is greaterthan 500"};
    }

    const creditedAccount =
      String(
        receipt?.creditedPartyAccountNo ??
        ""
      ).trim();

    if (creditedAccount === undefined || creditedAccount === "") {
      console.log(`db.aproveDeposit No creditedAccount`);
      return {success:false, errorMessage:"No creditedAccount"};
    }

    const creditedName =
      String(
        receipt?.creditedPartyName ??
        ""
      ).trim();

    if (creditedName === undefined || creditedName === "") {
      console.log(`db.aproveDeposit No creditedAccount`);
      return {success:false, errorMessage:"No creditedAccount"};
    }

    const payerName =
      String(
        receipt?.payerName ??
        ""
      ).trim() || null;

    if (payerName === undefined || payerName === "" || payerName === null) {
      console.log(`db.aproveDeposit No payerName`);
      return {success:false, errorMessage:"No payerName"};
    }

    const payerAccount =
      String(
        receipt?.payerTelebirrNo ??
        ""
      ).trim() || null;

    if (payerAccount === undefined || payerAccount === "" || payerAccount === null) {
      console.log(`db.aproveDeposit No payerAccount`);
      return {success:false, errorMessage:"No payerAccount"};
    }

    const client =  await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      const duplicate =
        await client.query(
          `
          SELECT id
          FROM deposits
          WHERE reference = $1
          LIMIT 1
          `,
          [receiptNo]
        );

      if (
        duplicate.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );
        console.log(`db.aproveDeposit Used receiptNo`);
        return {success:false, errorMessage:"Used receiptNo"};
      }

      const userResult =
        await client.query(
          `
          SELECT
            id,
            telegram_id,            
            is_active,
            is_banned,
            is_blocked
          FROM users
          WHERE telegram_id = $1
          AND is_active = TRUE
          AND is_blocked = FALSE
          FOR UPDATE
          `,
          [telegramId]
        );

      if (
        !userResult.rows.length
      ) {       

        await client.query(
          "ROLLBACK"
        );
        console.log(`db.aproveDeposit User not found!`);
        return {success:false, errorMessage:"User not found!"};
      }

      const creditedAccountLast4 =
        creditedAccount
          .replace(
            /\D/g,
            ""
          )
          .slice(-4);

      if (
        creditedAccountLast4.length !== 4
      ) {

        await client.query(
          "ROLLBACK"
        );                     
        console.log(`db.aproveDeposit Deposit phone number from the receipt is not correct! ${creditedAccountLast4}`);
        return {success:false, errorMessage:"Deposit phone number from the receipt is not correct!"};
      }

      const accountResult =
        await client.query(
          `
          SELECT
            pa.id,
            pa.payment_method_id,
            pa.account_number,
            pa.account_name,
            pa.balance,
            pa.is_active,
            pa.is_removed

          FROM payment_accounts pa

          WHERE pa.is_active = TRUE
            AND pa.is_removed = FALSE
            AND RIGHT(
              REGEXP_REPLACE(
                pa.account_number,
                '[^0-9]',
                '',
                'g'
              ),
              4
            ) = $1

          ORDER BY pa.id

          FOR UPDATE
          `,
          [creditedAccountLast4]
        );

      if (
        !accountResult.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );
        
        console.log(`db.aproveDeposit Wrong account deposit number!`);
        return {success:false, errorMessage:"Wrong account deposit number!"};
      }
      let user = userResult.rows[0];
      let account =
        accountResult.rows[0];

      /*
       * If the receipt contains the credited
       * account name, prefer an exact match.
       */
      if (creditedName) {

        const exactAccount =
          accountResult.rows.find(
            (a) =>
              String(
                a.account_name || ""
              )
                .trim()
                .toLowerCase() ===
              creditedName
                .toLowerCase()
          );

        if (exactAccount) {
          account = exactAccount;
        }
        else
        {
           await client.query(
          "ROLLBACK"
        );
        console.log(`db.aproveDeposit Deposit account name for the account number can not be matched!  ${creditedName}`);
        return {success:false, errorMessage:"Deposit account name for the account number can not be matched!"};
        }
      }
      else
      {
        await client.query(
          "ROLLBACK"
        );
        console.log(`db.aproveDeposit No creditedName!`);
        return {success:false, errorMessage:"No creditedName!"};
      }

      const depositResult =
        await client.query(
          `
          INSERT INTO deposits (
            user_id,
            payment_account_id,
            deposit_method_id,
            depositor_name,
            depositor_account,
            amount,            
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
            $8,
            NOW()
          )
          RETURNING
            id,
            created_at
          `,
          [
            user.id,
            account.id,
            account.payment_method_id,
            payerName,
            payerAccount,
            amount,            
            receiptNo
          ]
        );

    const depositId =
      depositResult.rows[0]?.id;
		
  const depositvalues = depositResult.rows[0];
  const walletResult = await client.query(
    `
    SELECT credit_deposit_to_wallet(
      $1,
      $2,
      $3,      
      $4,
      $5,
	  $6
    ) AS transaction_id
    `,
    [
      user.id,
      amount,
      depositvalues.id,
      `deposit:credit:${depositId}`,
	  null,
	  null
    ]
  );

  const transactionId =
  walletResult.rows[0]?.transaction_id;

		
        await client.query(
          `
          UPDATE deposits
			SET
			    transaction_id = $1,
			    status = 'completed',
			    approved_at = NOW(),
			    updated_at = NOW()
			WHERE id = $2
          `,
          [
            transactionId,
			depositId
          ]
        );

/*
      await client.query(
        `
        UPDATE users
        SET
          balance = $1,
          last_seen = NOW()
        WHERE id = $2
        `,
        [
          amountAfter,
          user.id
        ]
      );
*/
      await client.query(
        `
        UPDATE payment_accounts
        SET
          balance =
            balance + $1
        WHERE id = $2
        `,
        [
          amount,
          account.id
        ]
      );

     

      await client.query(
        "COMMIT"
      );

      console.log(`db.aproveDeposit Successful`);
      return {success:true, errorMessage:"Successful"};

    } catch (err) {

      await safeRollback(
        client
      );

      if (
        err.code === "23505"
      ) {
        return {success:false, errorMessage:"Someting went wrong! error code = "+ err.code};
      }

      console.error(
        "approveDeposit error:",
        err
      );

      throw err;

    } finally {

      client.release();

    }
  },

  // ============================================================
  // GAMES
  // ============================================================

  async createBingoGame(
  roomId,
  stakeId,
  stakeAmount
) {
  const amount = toPositiveAmount(
    stakeAmount,
    "stakeAmount"
  );

  const { rows } = await pool.query(
    `
    INSERT INTO bingo_games (
      game_code,
      room_id,
      stake_id,
      stake_amount,
      pot,
      status,
      started_at
    )
    VALUES (
      generate_bingo_game_code(),
      $1,
      $2,
      $3,
      0,
      'waiting',
      NOW()
    )
    RETURNING *
    `,
    [
      roomId,
      stakeId,
      amount
    ]
  );

  return rows[0] || null;
},

  async getBingoGameByCode(
  gameCode
) {
  const code =
    String(gameCode || "")
      .trim()
      .toUpperCase();

  if (!code) {
    throw new Error(
      "gameCode is required."
    );
  }

  const { rows } =
    await pool.query(
      `
      SELECT *
      FROM bingo_games
      WHERE game_code = $1
      LIMIT 1
      `,
      [code]
    );

  return rows[0] || null;
},

  async getBingoParticipant(
  gameId,
  userId,
  cardId
) {
  const game = toPositiveInteger(
    gameId,
    "gameId"
  );

  const user = toPositiveInteger(
    userId,
    "userId"
  );

  const card = toPositiveInteger(
    cardId,
    "cardId"
  );

  const { rows } =
    await pool.query(
      `
      SELECT
        bp.*,
        g.game_code,
        g.status AS game_status
      FROM bingo_participants bp
      JOIN bingo_games g
        ON g.id = bp.game_id
      WHERE bp.game_id = $1
        AND bp.user_id = $2
        AND bp.card_id = $3
      LIMIT 1
      `,
      [
        game,
        user,
        card
      ]
    );

  return rows[0] || null;
},

  async getBingoUserParticipants(
  gameId,
  userId
) {
  const game = toPositiveInteger(
    gameId,
    "gameId"
  );

  const user = toPositiveInteger(
    userId,
    "userId"
  );

  const { rows } =
    await pool.query(
      `
      SELECT
        id,
        game_id,
        user_id,
        card_id,
        card_data,
        transaction_id,
        amount,
        status,
        is_winner,
        is_disqualified,
        amount_won,
        joined_at
      FROM bingo_participants
      WHERE game_id = $1
        AND user_id = $2
      ORDER BY card_id
      `,
      [
        game,
        user
      ]
    );

  return rows;
},

  async getActiveBingoParticipants(
  gameId
) {
  const game = toPositiveInteger(
    gameId,
    "gameId"
  );

  const { rows } =
    await pool.query(
      `
      SELECT
        id,
        game_id,
        user_id,
        card_id,
        card_data,
        transaction_id,
        amount,
        status,
        is_winner,
        is_disqualified,
        amount_won,
        joined_at
      FROM bingo_participants
      WHERE game_id = $1
        AND status = 'active'
        AND is_disqualified = FALSE
      ORDER BY id
      `,
      [game]
    );

  return rows;
}, 

 async addBingoParticipant(
  gameId,
  userId,
  cardId,
  cardData
) {
  const game = toPositiveInteger(
    gameId,
    "gameId"
  );

  const user = toPositiveInteger(
    userId,
    "userId"
  );

  const card = toPositiveInteger(
    cardId,
    "cardId"
  );

  if (!Array.isArray(cardData)) {
    throw new Error(
      "cardData must be an array."
    );
  }

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    /*
     * Lock the Bingo game so two users/cards
     * cannot modify the pot concurrently.
     */
    const gameResult =
      await client.query(
        `
        SELECT
          id,
          stake_amount,
          pot,
          status
        FROM bingo_games
        WHERE id = $1
        FOR UPDATE
        `,
        [game]
      );

    if (!gameResult.rows.length) {
      throw new Error(
        "Bingo game not found."
      );
    }

    const bingoGame =
      gameResult.rows[0];

    /*
     * Only allow cards to be purchased
     * while the game is accepting players.
     */
    if (
      ![
        "waiting",
        "playing"
      ].includes(
        String(bingoGame.status)
      )
    ) {
      throw new Error(
        "This Bingo game is no longer accepting cards."
      );
    }

    /*
     * A user may have multiple cards,
     * but the SAME card cannot be entered twice
     * into the same game.
     */
    const existingCard =
      await client.query(
        `
        SELECT
          id,
          user_id,
          card_id,
          transaction_id,
          amount,
          status
        FROM bingo_participants
        WHERE game_id = $1
          AND card_id = $2
        FOR UPDATE
        `,
        [
          game,
          card
        ]
      );

    if (existingCard.rows.length) {
      await client.query(
        "ROLLBACK"
      );

      return {
        success: false,
        alreadyJoined: true,
        participant:
          existingCard.rows[0]
      };
    }

    const stakeAmount =
      toPositiveAmount(
        bingoGame.stake_amount,
        "stakeAmount"
      );

    /*
     * Idempotency is per GAME + CARD + USER.
     *
     * This is important because the same user
     * is allowed to purchase multiple cards.
     */
    const idempotencyKey =
      `bingo:stake:${game}:${card}:${user}`;

    /*
     * Move money through the wallet/ledger.
     *
     * The core wallet does not know anything
     * about bingo_participants.
     */
    const walletResult =
      await client.query(
        `
        SELECT place_stake(
          $1,
          $2,
          (
            SELECT id
            FROM game_systems
            WHERE code = 'bingo'
              AND status = 'active'
            LIMIT 1
          ),
          $3,
          $4,
          $5,
          $6,
          $7::jsonb
        ) AS transaction_id
        `,
        [
          user,
          stakeAmount,
          "bingo_game",
          String(game),
          idempotencyKey,
          `Bingo game #${game} card #${card} stake`,
          JSON.stringify({
            game_id: game,
            game_system: "bingo",
            card_id: card
          })
        ]
      );

    const transactionId =
      walletResult.rows[0]?.transaction_id;

    if (!transactionId) {
      throw new Error(
        "Bingo stake transaction was not created."
      );
    }

    /*
     * Save the actual card used for this game.
     *
     * JSONB gives us a historical snapshot.
     */
    const participantResult =
      await client.query(
        `
        INSERT INTO bingo_participants (
          game_id,
          user_id,
          card_id,
          card_data,
          transaction_id,
          amount,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          $4::jsonb,
          $5,
          $6,
          'active'
        )
        RETURNING *
        `,
        [
          game,
          user,
          card,
          JSON.stringify(cardData),
          transactionId,
          stakeAmount
        ]
      );

    /*
     * Add this card's stake to the Bingo pot.
     */
    const updatedGame =
      await client.query(
        `
        UPDATE bingo_games
        SET pot = pot + $1
        WHERE id = $2
        RETURNING *
        `,
        [
          stakeAmount,
          game
        ]
      );

    if (!updatedGame.rows.length) {
      throw new Error(
        "Bingo game could not be updated."
      );
    }

    await client.query(
      "COMMIT"
    );

    return {
      success: true,
      alreadyJoined: false,
      game: updatedGame.rows[0],
      participant:
        participantResult.rows[0],
      transactionId
    };

  } catch (err) {

    await safeRollback(
      client
    );

    throw err;

  } finally {

    client.release();

  }
},  

  async updateCalledBingoNumbers(
  gameId,
  calledNumbers
) {
  const game = toPositiveInteger(
    gameId,
    "gameId"
  );

  if (!Array.isArray(calledNumbers)) {
    throw new Error(
      "calledNumbers must be an array."
    );
  }

  const { rows } = await pool.query(
    `
    UPDATE bingo_games
    SET called_numbers = $1
    WHERE id = $2
    RETURNING *
    `,
    [
      calledNumbers,
      game
    ]
  );

  return rows[0] || null;
},

  async endBingoGame(gameId, winners) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ------------------------------------------------------------
    // 1. Lock the Bingo game
    // ------------------------------------------------------------
    const gameResult = await client.query(
      `
      SELECT *
      FROM bingo_games
      WHERE id = $1
      FOR UPDATE
      `,
      [gameId]
    );

    if (gameResult.rows.length === 0) {
      throw new Error('Bingo game not found');
    }

    const game = gameResult.rows[0];

    if (game.status === 'completed') {
      throw new Error('Bingo game has already ended');
    }

    if (!['waiting', 'playing'].includes(game.status)) {
      throw new Error(
        `Cannot end Bingo game with status: ${game.status}`
      );
    }

    // ------------------------------------------------------------
    // 2. Validate winners input
    //
    // Each winning CARD is an independent winner.
    //
    // Example:
    //
    // [
    //   { userId: 10, cardId: 1, amountWon: 50 },
    //   { userId: 10, cardId: 2, amountWon: 50 },
    //   { userId: 25, cardId: 7, amountWon: 50 }
    // ]
    //
    // User 10 therefore receives 100 ETB.
    // ------------------------------------------------------------
    if (!Array.isArray(winners)) {
      throw new Error('Winners must be an array');
    }

    const uniqueWinners = [];
    const winnerKeys = new Set();

    for (const winner of winners) {
      const userId = Number(winner.userId);
      const cardId = Number(winner.cardId);
      const amountWon = Number(winner.amountWon);

      if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error(
          `Invalid winner userId: ${winner.userId}`
        );
      }

      if (!Number.isInteger(cardId) || cardId <= 0) {
        throw new Error(
          `Invalid winner cardId: ${winner.cardId}`
        );
      }

      if (!Number.isFinite(amountWon) || amountWon <= 0) {
        throw new Error(
          `Invalid winning amount for card ${cardId}`
        );
      }

      const key = `${userId}:${cardId}`;

      if (winnerKeys.has(key)) {
        throw new Error(
          `Duplicate winning card: user ${userId}, card ${cardId}`
        );
      }

      winnerKeys.add(key);

      uniqueWinners.push({
        userId,
        cardId,
        amountWon
      });
    }

    // ------------------------------------------------------------
    // 3. Load and lock all Bingo participants
    // ------------------------------------------------------------
    const participantsResult = await client.query(
      `
      SELECT
        id,
        game_id,
        user_id,
        card_id,
        card_data,
        transaction_id,
        amount,
        status,
        is_winner,
        is_disqualified,
        amount_won
      FROM bingo_participants
      WHERE game_id = $1
      FOR UPDATE
      `,
      [gameId]
    );

    const participants = participantsResult.rows;

    if (participants.length === 0) {
      throw new Error(
        'Cannot end Bingo game with no participants'
      );
    }

    // ------------------------------------------------------------
    // 4. Validate game pot against participant stakes
    // ------------------------------------------------------------
    const calculatedPot = participants.reduce(
      (sum, participant) => {
        if (participant.status === 'active') {
          return sum + Number(participant.amount || 0);
        }

        return sum;
      },
      0
    );

    const recordedPot = Number(game.pot || 0);

    if (Math.abs(calculatedPot - recordedPot) > 0.001) {
      throw new Error(
        `Bingo game pot mismatch. ` +
        `Recorded: ${recordedPot}, ` +
        `Calculated: ${calculatedPot}`
      );
    }

    // ------------------------------------------------------------
    // 5. Build participant lookup
    // ------------------------------------------------------------
    const participantMap = new Map();

    for (const participant of participants) {
      const key =
        `${participant.user_id}:${participant.card_id}`;

      participantMap.set(key, participant);
    }

    // ------------------------------------------------------------
    // 6. Validate every winning card
    // ------------------------------------------------------------
    for (const winner of uniqueWinners) {
      const key =
        `${winner.userId}:${winner.cardId}`;

      const participant = participantMap.get(key);

      if (!participant) {
        throw new Error(
          `Winning card ${winner.cardId} for user ${winner.userId} ` +
          `does not belong to Bingo game ${gameId}`
        );
      }

      if (participant.game_id !== gameId) {
        throw new Error(
          `Winning card ${winner.cardId} belongs to another game`
        );
      }

      if (participant.status !== 'active') {
        throw new Error(
          `Winning card ${winner.cardId} is not active`
        );
      }

      if (participant.is_disqualified) {
        throw new Error(
          `Winning card ${winner.cardId} is disqualified`
        );
      }

      if (participant.is_winner) {
        throw new Error(
          `Winning card ${winner.cardId} has already been settled`
        );
      }
    }

    // ------------------------------------------------------------
    // 7. Calculate total payout
    //
    // Every winning card gets its own payout.
    // ------------------------------------------------------------
    const totalPayout = uniqueWinners.reduce(
      (sum, winner) => sum + winner.amountWon,
      0
    );

    // ------------------------------------------------------------
    // 8. Never allow Bingo to pay more than the pot
    // ------------------------------------------------------------
    if (totalPayout > recordedPot + 0.001) {
      throw new Error(
        `Total Bingo payout (${totalPayout}) ` +
        `exceeds game pot (${recordedPot})`
      );
    }

    // ------------------------------------------------------------
    // 9. Resolve the generic Bingo game system
    // ------------------------------------------------------------
    const gameSystemResult = await client.query(
      `
      SELECT id
      FROM game_systems
      WHERE code = 'bingo'
        AND status = 'active'
      LIMIT 1
      `
    );

    if (gameSystemResult.rows.length === 0) {
      throw new Error(
        'Active Bingo game system is not configured'
      );
    }

    const bingoGameSystemId =
      gameSystemResult.rows[0].id;

    // ------------------------------------------------------------
    // 10. Track statistics per USER
    //
    // Financial settlement is CARD based.
    //
    // Statistics are aggregated by user.
    // ------------------------------------------------------------
    const userStats = new Map();

    // ------------------------------------------------------------
    // 11. Settle every winning card
    // ------------------------------------------------------------
    for (const winner of uniqueWinners) {
      const key =
        `${winner.userId}:${winner.cardId}`;

      const participant = participantMap.get(key);

      // ----------------------------------------------------------
      // 11a. Mark the specific card as a winner
      // ----------------------------------------------------------
      await client.query(
        `
        UPDATE bingo_participants
        SET
          is_winner = TRUE,
          amount_won = $1
        WHERE id = $2
        `,
        [
          winner.amountWon,
          participant.id
        ]
      );

      // ----------------------------------------------------------
      // 11b. Card-level idempotency
      //
      // Same user can have multiple winning cards.
      // Therefore cardId MUST be part of the key.
      // ----------------------------------------------------------
      const idempotencyKey =
        `bingo:win:${gameId}:${winner.cardId}`;

      // ----------------------------------------------------------
      // 11c. Create the generic wallet win transaction
      // ----------------------------------------------------------
      const winResult = await client.query(
        `
        SELECT record_game_win(
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        ) AS transaction_id
        `,
        [
          winner.userId,
          winner.amountWon,
          bingoGameSystemId,
          'bingo_game',
          String(gameId),
          idempotencyKey,
          JSON.stringify({
            game_id: gameId,
            game_code: game.game_code,
            card_id: winner.cardId,
            participant_id: participant.id
          })
        ]
      );

      const transactionId =
        winResult.rows[0]?.transaction_id;

      if (!transactionId) {
        throw new Error(
          `Failed to create wallet win transaction ` +
          `for game ${gameId}, card ${winner.cardId}`
        );
      }

      // ----------------------------------------------------------
      // 11d. Track user-level statistics
      // ----------------------------------------------------------
      const stats =
        userStats.get(winner.userId) || {
          winningCards: 0,
          totalWinnings: 0
        };

      stats.winningCards += 1;
      stats.totalWinnings += winner.amountWon;

      userStats.set(
        winner.userId,
        stats
      );
    }

    // ------------------------------------------------------------
    // 12. Update user winning statistics
    //
    // IMPORTANT:
    // total_wins here means WINNING CARDS.
    //
    // If a user wins 3 cards:
    //
    // total_wins += 3
    // total_winnings += sum of the 3 payouts
    // ------------------------------------------------------------
    for (const [
      userId,
      stats
    ] of userStats.entries()) {
      await client.query(
        `
        UPDATE users
        SET
          total_wins =
            COALESCE(total_wins, 0) + $1,
          total_winnings =
            COALESCE(total_winnings, 0) + $2
        WHERE id = $3
        `,
        [
          stats.winningCards,
          stats.totalWinnings,
          userId
        ]
      );
    }

    // ------------------------------------------------------------
    // 13. Update total games played
    //
    // A user with multiple cards counts as ONE game.
    // ------------------------------------------------------------
    const distinctUsers = new Set(
      participants.map(
        participant => participant.user_id
      )
    );

    for (const userId of distinctUsers) {
      await client.query(
        `
        UPDATE users
        SET
          total_games =
            COALESCE(total_games, 0) + 1
        WHERE id = $1
        `,
        [userId]
      );
    }

    // ------------------------------------------------------------
    // 14. Distinct winning users
    //
    // winner_ids is a USER-level summary.
    //
    // Actual winning cards are stored in bingo_participants.
    // ------------------------------------------------------------
    const winnerUserIds = [
      ...new Set(
        uniqueWinners.map(
          winner => winner.userId
        )
      )
    ];

    // ------------------------------------------------------------
    // 15. Determine split
    //
    // Here "split" means multiple winning cards.
    // If you instead want "multiple winning users",
    // change this to:
    //
    // winnerUserIds.length > 1
    // ------------------------------------------------------------
    const isSplit =
      uniqueWinners.length > 1;

    // ------------------------------------------------------------
    // 16. Complete the Bingo game
    // ------------------------------------------------------------
    const endGameResult = await client.query(
      `
      UPDATE bingo_games
      SET
        status = 'completed',
        winner_ids = $1,
        win_amount = $2,
        is_split = $3,
        ended_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [
        winnerUserIds,
        totalPayout,
        isSplit,
        gameId
      ]
    );

    if (endGameResult.rows.length === 0) {
      throw new Error(
        'Failed to complete Bingo game'
      );
    }

    // ------------------------------------------------------------
    // 17. Commit everything atomically
    // ------------------------------------------------------------
    await client.query('COMMIT');

    return {
      ...endGameResult.rows[0],
      winners: uniqueWinners,
      winner_count: uniqueWinners.length,
      winner_user_count: winnerUserIds.length,
      total_payout: totalPayout
    };

  } catch (error) {
    await client.query('ROLLBACK');

    console.error(
      'endBingoGame error:',
      error
    );

    throw error;

  } finally {
    client.release();
  }
},

  async getActiveBingoGame(
  roomId
) {
  const { rows } = await pool.query(
    `
    SELECT
      g.*,

      COALESCE(
        json_agg(
          json_build_object(
            'id',
            bp.id,

            'user_id',
            bp.user_id,

            'card_id',
            bp.card_id,

            'card_data',
            bp.card_data,

            'transaction_id',
            bp.transaction_id,

            'amount',
            bp.amount,

            'status',
            bp.status,

            'is_winner',
            bp.is_winner,

            'is_disqualified',
            bp.is_disqualified,

            'amount_won',
            bp.amount_won,

            'joined_at',
            bp.joined_at
          )
          ORDER BY bp.id
        ) FILTER (
          WHERE bp.id IS NOT NULL
        ),
        '[]'::json
      ) AS participants

    FROM bingo_games g

    LEFT JOIN bingo_participants bp
      ON bp.game_id = g.id

    WHERE g.room_id = $1
      AND g.status IN (
        'waiting',
        'playing'
      )

    GROUP BY g.id

    ORDER BY g.created_at DESC

    LIMIT 1
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

    const safeLimit =
      Math.min(
        Math.max(
          Number(limit) || 10,
          1
        ),
        100
      );

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
        [safeLimit]
      );

    return rows;
  } 
};
