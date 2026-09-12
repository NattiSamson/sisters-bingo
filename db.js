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
  const raw =
    receipt?.settledAmount ??
    receipt?.amount;

  if (raw == null) {
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
              AND w.reject_reason IS NOT NULL
          ) AS rejected_withdrawals,

          (
            SELECT COUNT(*)
            FROM transfers t
            WHERE t.sender_telegram_id = u.telegram_id
               OR t.recipient_telegram_id = u.telegram_id
          ) AS total_transfers

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
        ),

      totalTransfers:
        Number(
          r.total_transfers || 0
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
              AND w.is_pending = FALSE
              AND w.is_approved = TRUE
          ) AS approved_withdrawal_amount,

          (
            SELECT COALESCE(
              SUM(w.amount),
              0
            )
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.is_pending = TRUE
              AND w.is_approved = FALSE
          ) AS pending_withdrawal_amount,

          (
            SELECT COALESCE(
              SUM(w.amount),
              0
            )
            FROM withdrawals w
            WHERE w.user_id = u.id
              AND w.is_pending = FALSE
              AND w.is_approved = FALSE
              AND w.reject_reason IS NOT NULL
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

  async getAdminFinancialStatistics() {

    const { rows } =
      await pool.query(
        `
        SELECT

          (
            SELECT COALESCE(
              SUM(amount),
              0
            )
            FROM deposits
          ) AS total_deposit_amount,

          (
            SELECT COALESCE(
              SUM(amount),
              0
            )
            FROM withdrawals
            WHERE is_pending = FALSE
              AND is_approved = TRUE
          ) AS approved_withdrawal_amount,

          (
            SELECT COALESCE(
              SUM(amount),
              0
            )
            FROM withdrawals
            WHERE is_pending = TRUE
              AND is_approved = FALSE
          ) AS pending_withdrawal_amount,

          (
            SELECT COALESCE(
              SUM(amount),
              0
            )
            FROM withdrawals
            WHERE is_pending = FALSE
              AND is_approved = FALSE
              AND reject_reason IS NOT NULL
          ) AS rejected_withdrawal_amount
        `
      );

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

          (
            SELECT COUNT(*)
            FROM transfers
          ) AS total_transfers,

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

          (
            SELECT COUNT(*)
            FROM users
            WHERE is_admin = TRUE
              AND is_active = TRUE
              AND is_banned = FALSE
              AND is_blocked = FALSE
          ) AS administrators
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

      totalTransfers:
        Number(
          r.total_transfers || 0
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

      administrators:
        Number(
          r.administrators || 0
        )
    };
  },

  // ============================================================
  // BALANCE / GAME MONEY
  // ============================================================

  async updateBalance(
    userId,
    amount
  ) {

    const { rows } =
      await pool.query(
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

    return rows[0]?.balance ?? null;
  },

  async deductStake(
    userId,
    amount,
    gameId
  ) {

    const n =
      toPositiveAmount(amount);

    const game =
      toPositiveInteger(
        gameId,
        "gameId"
      );

    const { rows } =
      await pool.query(
        `
        SELECT deduct_stake(
          $1,
          $2,
          $3
        ) AS new_balance
        `,
        [
          userId,
          n,
          game
        ]
      );

    return (
      rows[0]?.new_balance ??
      null
    );
  },

  async awardWin(
    userId,
    amount,
    gameId
  ) {

    const n =
      toPositiveAmount(amount);

    const game =
      toPositiveInteger(
        gameId,
        "gameId"
      );

    const { rows } =
      await pool.query(
        `
        SELECT award_win(
          $1,
          $2,
          $3
        ) AS new_balance
        `,
        [
          userId,
          n,
          game
        ]
      );

    return (
      rows[0]?.new_balance ??
      null
    );
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

    const methodId =
      toPositiveInteger(
        paymentMethodId,
        "paymentMethodId"
      );

    const withdrawalAmount =
      toPositiveAmount(amount);

    if (
      !Number.isInteger(
        withdrawalAmount
      ) ||
      withdrawalAmount < 10
    ) {

      return {
        success: false,
        message:
          "Withdrawal amount must be a whole number of at least 10 ETB."
      };
    }

    const cleanAccount =
      String(
        accountNumber ?? ""
      )
        .trim()
        .replace(
          /[\s\-()]/g,
          ""
        );

    if (
      !/^\d{1,20}$/.test(
        cleanAccount
      )
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

      const userResult =
        await client.query(
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

        return {
          success: false,
          message:
            "Account not found or inactive."
        };
      }

      const user =
        userResult.rows[0];

      const currentBalance =
        Number(
          user.balance || 0
        );

      if (
        withdrawalAmount >
        currentBalance
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            `Insufficient balance. Available: ${currentBalance} ETB`
        };
      }

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
          [methodId]
        );

      if (
        !methodResult.rows.length
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

      const newBalance =
        currentBalance -
        withdrawalAmount;

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
            methodId,
            cleanAccount,
            withdrawalAmount
          ]
        );

      await client.query(
        `
        INSERT INTO transactions (
          user_id,
          type,
          amount,
          balance_after,
          reference
        )
        VALUES (
          $1,
          'withdrawal',
          $2,
          $3,
          $4
        )
        `,
        [
          user.id,
          -withdrawalAmount,
          newBalance,
          `withdrawal:${withdrawalResult.rows[0].id}`
        ]
      );

      await client.query(
        "COMMIT"
      );

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

      await safeRollback(
        client
      );

      console.error(
        "createWithdrawal error:",
        err
      );

      return {
        success: false,
        message:
          "Could not create withdrawal request."
      };

    } finally {

      client.release();

    }
  },

  async getPendingWithdrawals(
    limit = 5
  ) {

    const safeLimit =
      Math.min(
        Math.max(
          Number(limit) || 5,
          1
        ),
        100
      );

    const { rows } =
      await pool.query(
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
          w.reject_reason,
          w.created_at,
          w.updated_at,

          u.telegram_id,
          u.name,
          u.phone,
          u.balance,

          pm.name AS payment_method,
          pm.amharic_name
            AS payment_method_amharic,
          pm.emoji
            AS payment_method_emoji

        FROM withdrawals w

        JOIN users u
          ON u.id = w.user_id

        LEFT JOIN payment_methods pm
          ON pm.id =
             w.payment_method_id

        WHERE w.is_pending = TRUE
          AND w.is_approved = FALSE

        ORDER BY w.created_at ASC

        LIMIT $1
        `,
        [safeLimit]
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

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      const withdrawalResult =
        await client.query(
          `
          SELECT
            w.*,
            u.telegram_id,
            u.name,
            u.balance
          FROM withdrawals w
          JOIN users u
            ON u.id = w.user_id
          WHERE w.id = $1
          FOR UPDATE
          `,
          [withdrawalIdNum]
        );

      if (
        !withdrawalResult.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Withdrawal request not found."
        };
      }

      const withdrawal =
        withdrawalResult.rows[0];

      if (
        !withdrawal.is_pending ||
        withdrawal.is_approved
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "This withdrawal has already been processed."
        };
      }

      const adminResult =
        await client.query(
          `
          SELECT id
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

      if (
        !adminResult.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Admin account not found."
        };
      }

      const adminId =
        adminResult.rows[0].id;

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
          WHERE pa.id = $1
          FOR UPDATE
          `,
          [accountId]
        );

      if (
        !accountResult.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Payment account not found."
        };
      }

      const account =
        accountResult.rows[0];

      if (
        !account.is_active ||
        account.is_removed
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Selected payment account is inactive or removed."
        };
      }

      if (
        Number(
          account.payment_method_id
        ) !==
        Number(
          withdrawal.payment_method_id
        )
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Payment account does not match the withdrawal method."
        };
      }

      const amount =
        Number(
          withdrawal.amount
        );

      const accountBalance =
        Number(
          account.balance || 0
        );

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        accountBalance < amount
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Insufficient payment-account balance."
        };
      }

      const accountAfter =
        accountBalance -
        amount;

      await client.query(
        `
        UPDATE payment_accounts
        SET balance = $1
        WHERE id = $2
        `,
        [
          accountAfter,
          account.id
        ]
      );

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
            account.id,
            adminId,
            withdrawalIdNum
          ]
        );

      if (
        !updateResult.rows.length
      ) {

        throw new Error(
          "Withdrawal was already processed."
        );
      }

      await client.query(
        "COMMIT"
      );

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
          Number(
            withdrawal.balance
          ),

        withdrawal:
          updateResult.rows[0]
      };

    } catch (err) {

      await safeRollback(
        client
      );

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
        reason ||
        "Rejected by admin"
      )
        .trim()
        .slice(0, 100);

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      const withdrawalResult =
        await client.query(
          `
          SELECT
            w.*,
            u.telegram_id,
            u.name,
            u.balance
          FROM withdrawals w
          JOIN users u
            ON u.id = w.user_id
          WHERE w.id = $1
          FOR UPDATE
          `,
          [withdrawalIdNum]
        );

      if (
        !withdrawalResult.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Withdrawal request not found."
        };
      }

      const withdrawal =
        withdrawalResult.rows[0];

      if (
        !withdrawal.is_pending ||
        withdrawal.is_approved
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "This withdrawal has already been processed."
        };
      }

      const adminResult =
        await client.query(
          `
          SELECT id
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

      if (
        !adminResult.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Admin account not found."
        };
      }

      const balanceResult =
        await client.query(
          `
          UPDATE users
          SET balance =
              balance + $1
          WHERE id = $2
          RETURNING balance
          `,
          [
            withdrawal.amount,
            withdrawal.user_id
          ]
        );

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
            AND is_pending = TRUE
            AND is_approved = FALSE
          RETURNING *
          `,
          [
            adminResult.rows[0].id,
            cleanReason,
            withdrawalIdNum
          ]
        );

      if (
        !updateResult.rows.length
      ) {

        throw new Error(
          "Could not update withdrawal."
        );
      }

      await client.query(
        `
        INSERT INTO transactions (
          user_id,
          type,
          amount,
          balance_after,
          reference
        )
        VALUES (
          $1,
          'withdrawal_refund',
          $2,
          $3,
          $4
        )
        `,
        [
          withdrawal.user_id,
          withdrawal.amount,
          balanceResult.rows[0].balance,
          `withdrawal-refund:${withdrawalIdNum}`
        ]
      );

      await client.query(
        "COMMIT"
      );

      return {
        success: true,

        withdrawal_id:
          withdrawal.id,

        telegram_id:
          withdrawal.telegram_id,

        user_name:
          withdrawal.name,

        amount:
          Number(
            withdrawal.amount
          ),

        balance_after:
          Number(
            balanceResult.rows[0].balance
          ),

        rejection_reason:
          cleanReason,

        withdrawal:
          updateResult.rows[0]
      };

    } catch (err) {

      await safeRollback(
        client
      );

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

  async createBroadcastDraft(
    adminId
  ) {

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

  async getBroadcastDraft(
    adminId
  ) {

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

  async deleteBroadcastDraft(
    adminId
  ) {

    await pool.query(
      `
      DELETE FROM broadcast_drafts
      WHERE admin_id = $1
      `,
      [adminId]
    );
  },

  async getAllActiveUsers() {

    const { rows } =
      await pool.query(
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

  async getPaymentMethods() {

    const { rows } =
      await pool.query(
        `
        SELECT
          pm.id,
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
          AND pa.is_removed = FALSE

        ORDER BY
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
        receipt?.invoiceNo ??
        ""
      ).trim();

    if (!receiptNo) {
      return -4;
    }

    const amount =
      amountFromReceipt(
        receipt
      );

    const creditedAccount =
      String(
        receipt?.creditedPartyAccountNo ??
        ""
      ).trim();

    const creditedName =
      String(
        receipt?.creditedPartyName ??
        ""
      ).trim();

    const payerName =
      String(
        receipt?.payerName ??
        ""
      ).trim() || null;

    const payerAccount =
      String(
        receipt?.payerTelebirrNo ??
        ""
      ).trim() || null;

    if (!creditedAccount) {
      return -2;
    }

    const client =
      await pool.connect();

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

        return -1;
      }

      const userResult =
        await client.query(
          `
          SELECT
            id,
            telegram_id,
            balance,
            is_active,
            is_banned,
            is_blocked
          FROM users
          WHERE telegram_id = $1
          FOR UPDATE
          `,
          [telegramId]
        );

      if (
        !userResult.rows.length
      ) {

        throw new Error(
          "User not found"
        );
      }

      const user =
        userResult.rows[0];

      if (
        !user.is_active ||
        user.is_banned ||
        user.is_blocked
      ) {

        await client.query(
          "ROLLBACK"
        );

        return -5;
      }

      const accountLast4 =
        creditedAccount
          .replace(
            /\D/g,
            ""
          )
          .slice(-4);

      if (
        accountLast4.length !== 4
      ) {

        await client.query(
          "ROLLBACK"
        );

        return -2;
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
          [accountLast4]
        );

      if (
        !accountResult.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return -2;
      }

      let account =
        accountResult.rows[0];

      /*
       * If the receipt contains the credited
       * account name, prefer an exact match.
       */
      if (creditedName) {

        const exactName =
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

        if (exactName) {
          account = exactName;
        }
      }

      const currentBalance =
        Number(
          user.balance || 0
        );

      const amountAfter =
        currentBalance +
        amount;

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
            amountAfter,
            receiptNo
          ]
        );

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
        `
        INSERT INTO transactions (
          user_id,
          type,
          amount,
          balance_after,
          reference
        )
        VALUES (
          $1,
          'deposit',
          $2,
          $3,
          $4
        )
        `,
        [
          user.id,
          amount,
          amountAfter,
          `deposit:${depositResult.rows[0].id}`
        ]
      );

      await client.query(
        "COMMIT"
      );

      return amount;

    } catch (err) {

      await safeRollback(
        client
      );

      if (
        err.code === "23505"
      ) {
        return -1;
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
  // TRANSFERS
  // ============================================================

  async transferBalance(
    senderTelegramId,
    recipientTelegramId,
    amount
  ) {

    const transferAmount =
      toPositiveAmount(
        amount,
        "transfer amount"
      );

    if (
      String(
        senderTelegramId
      ) ===
      String(
        recipientTelegramId
      )
    ) {

      return {
        success: false,
        message:
          "You cannot transfer money to yourself."
      };
    }

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      /*
       * Lock users in deterministic order
       * to reduce deadlock risk.
       */

      const ids = [
        String(senderTelegramId),
        String(recipientTelegramId)
      ].sort();

      const result =
        await client.query(
          `
          SELECT
            id,
            telegram_id,
            phone,
            balance,
            is_active,
            is_banned,
            is_blocked
          FROM users
          WHERE telegram_id IN ($1, $2)
          ORDER BY telegram_id
          FOR UPDATE
          `,
          ids
        );

      const sender =
        result.rows.find(
          (r) =>
            String(
              r.telegram_id
            ) ===
            String(
              senderTelegramId
            )
        );

      const recipient =
        result.rows.find(
          (r) =>
            String(
              r.telegram_id
            ) ===
            String(
              recipientTelegramId
            )
        );

      if (
        !sender ||
        !recipient
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Sender or recipient account not found."
        };
      }

      if (
        !sender.is_active ||
        sender.is_banned ||
        sender.is_blocked
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Your account is not active."
        };
      }

      if (
        !recipient.is_active ||
        recipient.is_banned ||
        recipient.is_blocked
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          message:
            "Recipient account is not active."
        };
      }

      const senderBefore =
        Number(
          sender.balance || 0
        );

      const recipientBefore =
        Number(
          recipient.balance || 0
        );

      if (
        senderBefore <
        transferAmount
      ) {

        await client.query(
          "ROLLBACK"
        );

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
        WHERE id = $2
        `,
        [
          senderAfter,
          sender.id
        ]
      );

      await client.query(
        `
        UPDATE users
        SET balance = $1
        WHERE id = $2
        `,
        [
          recipientAfter,
          recipient.id
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

      await client.query(
        `
        INSERT INTO transactions (
          user_id,
          type,
          amount,
          balance_after,
          reference
        )
        VALUES
          (
            $1,
            'transfer_out',
            $2,
            $3,
            $4
          ),
          (
            $5,
            'transfer_in',
            $6,
            $7,
            $8
          )
        `,
        [
          sender.id,
          -transferAmount,
          senderAfter,
          `transfer:${transferResult.rows[0].id}:out`,

          recipient.id,
          transferAmount,
          recipientAfter,
          `transfer:${transferResult.rows[0].id}:in`
        ]
      );

      await client.query(
        "COMMIT"
      );

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

      await safeRollback(
        client
      );

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
  // GAMES
  // ============================================================

  async createGame(
    roomId,
    stakeId,
    stakeAmount
  ) {

    const amount =
      toPositiveAmount(
        stakeAmount,
        "stakeAmount"
      );

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
          amount
        ]
      );

    return rows[0];
  },

  async addParticipant(
    gameId,
    userId,
    cardId
  ) {

    const { rows } =
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
        RETURNING *
        `,
        [
          gameId,
          userId,
          cardId
        ]
      );

    return rows[0] || null;
  },

  async updateGamePot(
    gameId,
    pot
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE games
        SET pot = $1
        WHERE id = $2
        RETURNING *
        `,
        [
          pot,
          gameId
        ]
      );

    return rows[0] || null;
  },

  async updateCalledNumbers(
    gameId,
    calledNumbers
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE games
        SET called_numbers = $1
        WHERE id = $2
        RETURNING *
        `,
        [
          calledNumbers,
          gameId
        ]
      );

    return rows[0] || null;
  },

  async endGame(
    gameId,
    winnerUserIds = [],
    winAmount = 0,
    isSplit = false
  ) {

    const winners =
      Array.isArray(
        winnerUserIds
      )
        ? winnerUserIds
            .map(Number)
            .filter(
              Number.isInteger
            )
        : [];

    const totalWin =
      Math.max(
        Number(winAmount) || 0,
        0
      );

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      /*
       * Prevent the same game from paying
       * winners twice if endGame is called twice.
       */

      const gameUpdate =
        await client.query(
          `
          UPDATE games

          SET
            status = 'finished',
            winner_ids = $1,
            win_amount = $2,
            is_split = $3,
            ended_at = NOW()

          WHERE id = $4
            AND status <> 'finished'

          RETURNING id
          `,
          [
            winners,
            totalWin,
            Boolean(isSplit),
            gameId
          ]
        );

      if (
        !gameUpdate.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return;
      }

      if (
        winners.length
      ) {

        const perWinner =
          isSplit
            ? totalWin /
              winners.length
            : totalWin;

        await client.query(
          `
          UPDATE game_participants

          SET
            is_winner = TRUE,
            amount_won = $1

          WHERE game_id = $2
            AND user_id =
                ANY($3::int[])
          `,
          [
            perWinner,
            gameId,
            winners
          ]
        );

        /*
         * Credit winners here.
         * Do not call awardWin() again for these
         * same winners after calling endGame().
         */

        for (
          const userId of winners
        ) {

          const balance =
            await client.query(
              `
              UPDATE users

              SET
                balance =
                  balance + $1,
                total_wins =
                  total_wins + 1,
                total_winnings =
                  total_winnings + $1

              WHERE id = $2

              RETURNING balance
              `,
              [
                perWinner,
                userId
              ]
            );

          if (
            !balance.rows.length
          ) {

            throw new Error(
              `Winner user ${userId} not found`
            );
          }

          await client.query(
            `
            INSERT INTO transactions (
              user_id,
              type,
              amount,
              balance_after,
              reference
            )
            VALUES (
              $1,
              'win',
              $2,
              $3,
              $4
            )
            `,
            [
              userId,
              perWinner,
              balance.rows[0].balance,
              String(gameId)
            ]
          );
        }
      }

      await client.query(
        `
        UPDATE users

        SET
          total_games =
            total_games + 1

        WHERE id IN (
          SELECT user_id
          FROM game_participants
          WHERE game_id = $1
        )
        `,
        [gameId]
      );

      await client.query(
        "COMMIT"
      );

    } catch (err) {

      await safeRollback(
        client
      );

      throw err;

    } finally {

      client.release();

    }
  },

  async disqualifyParticipant(
    gameId,
    userId
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE game_participants

        SET
          is_disqualified = TRUE

        WHERE game_id = $1
          AND user_id = $2

        RETURNING *
        `,
        [
          gameId,
          userId
        ]
      );

    return rows[0] || null;
  },

  async getActiveGame(
    roomId
  ) {

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
// BONUS SYSTEM
// ============================================================

async addBonusToUser(
  client,
  userId,
  amount,
  bonusType,
  reference,
  description,
  campaignId = null
) {
  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount <= 0
  ) {
    throw new Error("Invalid bonus amount");
  }

  const userResult = await client.query(
    `
    SELECT
      id,
      telegram_id,
      balance,
      is_active,
      is_banned,
      is_blocked
    FROM users
    WHERE id = $1
    FOR UPDATE
    `,
    [userId]
  );

  if (!userResult.rows.length) {
    throw new Error("User not found");
  }

  const user = userResult.rows[0];

  if (
    !user.is_active ||
    user.is_banned ||
    user.is_blocked
  ) {
    throw new Error("User is not eligible for bonus");
  }

  // Deposit bonuses must never be duplicated.
  if (
    bonusType === "deposit_bonus" &&
    campaignId &&
    reference
  ) {
    const duplicate = await client.query(
      `
      SELECT id
      FROM bonus_transactions
      WHERE bonus_campaign_id = $1
        AND bonus_type = 'deposit_bonus'
        AND reference = $2
      LIMIT 1
      `,
      [
        campaignId,
        reference
      ]
    );

    if (duplicate.rows.length) {
      return {
        applied: false,
        duplicate: true,
        amount: 0,
        balance: Number(user.balance || 0)
      };
    }
  }

  const balanceResult = await client.query(
    `
    UPDATE users
    SET balance = balance + $1
    WHERE id = $2
    RETURNING balance
    `,
    [
      numericAmount,
      userId
    ]
  );

  const newBalance = Number(
    balanceResult.rows[0].balance
  );

  await client.query(
    `
    INSERT INTO bonus_transactions (
      user_id,
      bonus_campaign_id,
      bonus_type,
      amount,
      balance_after,
      reference,
      description
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7
    )
    `,
    [
      userId,
      campaignId,
      bonusType,
      numericAmount,
      newBalance,
      reference || null,
      description || null
    ]
  );

  // Also put the bonus into the existing transaction history.
  await client.query(
    `
    INSERT INTO transactions (
      user_id,
      type,
      amount,
      balance_after,
      reference
    )
    VALUES (
      $1,
      'bonus',
      $2,
      $3,
      $4
    )
    `,
    [
      userId,
      numericAmount,
      newBalance,
      reference || null
    ]
  );

  return {
    applied: true,
    duplicate: false,
    amount: numericAmount,
    balance: newBalance,
    telegramId: user.telegram_id
  };
}


// ============================================================
// SPECIFIC USER BONUS
// ============================================================

async giveBonusToUserByPhone(
  phone,
  amount,
  adminTelegramId
) {
  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount <= 0
  ) {
    throw new Error("Invalid bonus amount");
  }

  const searchLast9 = last9(phone);

  if (!searchLast9) {
    throw new Error(
      "Invalid Ethiopian phone number"
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        name,
        phone,
        balance,
        is_active,
        is_banned,
        is_blocked
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

    if (!userResult.rows.length) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message: "User not found."
      };
    }

    const user = userResult.rows[0];

    if (
      !user.is_active ||
      user.is_banned ||
      user.is_blocked
    ) {
      await client.query("ROLLBACK");

      return {
        success: false,
        message:
          "This user is inactive, blocked, or banned."
      };
    }

    const reference =
      `manual_bonus:user:${user.id}:${Date.now()}`;

    const result = await addBonusToUser(
      client,
      user.id,
      numericAmount,
      "manual_user_bonus",
      reference,
      `Manual bonus by admin ${adminTelegramId}`
    );

    await client.query("COMMIT");

    return {
      success: true,
      user,
      amount: result.amount,
      balance: result.balance
    };

  } catch (err) {

    await safeRollback(client);

    throw err;

  } finally {

    client.release();

  }
}


// ============================================================
// BONUS FOR ALL ACTIVE / UNBLOCKED USERS
// ============================================================

async giveBonusToAllActiveUsers(
  amount,
  adminTelegramId
) {
  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount <= 0
  ) {
    throw new Error("Invalid bonus amount");
  }

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const usersResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        name,
        balance
      FROM users
      WHERE is_active = TRUE
        AND is_banned = FALSE
        AND is_blocked = FALSE
      ORDER BY id
      FOR UPDATE
      `
    );

    let count = 0;
    let total = 0;

    const recipients = [];

    for (
      const user of usersResult.rows
    ) {

      const reference =
        `manual_bonus:all:${Date.now()}:${user.id}`;

      const result =
        await addBonusToUser(
          client,
          user.id,
          numericAmount,
          "manual_all_bonus",
          reference,
          `Bonus for all active users by admin ${adminTelegramId}`
        );

      if (result.applied) {

        count++;

        total += numericAmount;

        recipients.push({
          telegramId: user.telegram_id,
          name: user.name,
          amount: numericAmount,
          balance: result.balance
        });
      }
    }

    await client.query("COMMIT");

    return {
      success: true,
      count,
      total,
      recipients
    };

  } catch (err) {

    await safeRollback(client);

    throw err;

  } finally {

    client.release();

  }
}


// ============================================================
// CREATE TIME-BASED DEPOSIT BONUS
// ============================================================

async createBonusCampaign(
  name,
  startsAt,
  endsAt,
  bonusMode,
  bonusAmount,
  adminTelegramId
) {
  const mode = String(
    bonusMode || ""
  ).trim();

  if (
    mode !== "match_deposit" &&
    mode !== "fixed"
  ) {
    throw new Error(
      "Invalid bonus mode"
    );
  }

  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  ) {
    throw new Error(
      "Invalid start or end date"
    );
  }

  if (end <= start) {
    throw new Error(
      "End time must be after start time"
    );
  }

  let amount = null;

  if (mode === "fixed") {

    amount = Number(
      bonusAmount
    );

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      throw new Error(
        "Invalid fixed bonus amount"
      );
    }
  }

  const { rows } = await pool.query(
    `
    INSERT INTO bonus_campaigns (
      name,
      starts_at,
      ends_at,
      bonus_mode,
      bonus_amount,
      is_active,
      created_by
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      TRUE,
      $6
    )
    RETURNING *
    `,
    [
      String(name || "Deposit Bonus")
        .trim()
        .substring(0, 100),

      start,

      end,

      mode,

      amount,

      adminTelegramId
    ]
  );

  return rows[0];
}


// ============================================================
// GET CURRENT ACTIVE DEPOSIT BONUS
// ============================================================

async getActiveDepositBonus(
  client,
  depositTime = new Date()
) {
  const { rows } = await client.query(
    `
    SELECT
      id,
      name,
      starts_at,
      ends_at,
      bonus_mode,
      bonus_amount
    FROM bonus_campaigns
    WHERE is_active = TRUE
      AND starts_at <= $1
      AND ends_at >= $1
    ORDER BY id DESC
    LIMIT 1
    `,
    [depositTime]
  );

  return rows[0] || null;
}


// ============================================================
// APPLY TIME-BASED BONUS TO A DEPOSIT
// ============================================================
//
// Call this AFTER the deposit has successfully been approved.
//
// depositReference should be the Telebirr receipt number.
// ============================================================

async applyDepositBonus(
  telegramId,
  depositAmount,
  depositReference,
  depositTime = new Date()
) {
  const amount = Number(
    depositAmount
  );

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return {
      applied: false,
      amount: 0,
      campaign: null
    };
  }

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const userResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        balance,
        is_active,
        is_banned,
        is_blocked
      FROM users
      WHERE telegram_id = $1
      FOR UPDATE
      `,
      [telegramId]
    );

    if (!userResult.rows.length) {

      await client.query("ROLLBACK");

      return {
        applied: false,
        amount: 0,
        campaign: null
      };
    }

    const user = userResult.rows[0];

    if (
      !user.is_active ||
      user.is_banned ||
      user.is_blocked
    ) {

      await client.query("ROLLBACK");

      return {
        applied: false,
        amount: 0,
        campaign: null
      };
    }

    const campaign =
      await getActiveDepositBonus(
        client,
        depositTime
      );

    if (!campaign) {

      await client.query("ROLLBACK");

      return {
        applied: false,
        amount: 0,
        campaign: null
      };
    }

    let bonusAmount;

    if (
      campaign.bonus_mode ===
      "match_deposit"
    ) {

      bonusAmount = amount;

    } else {

      bonusAmount =
        Number(
          campaign.bonus_amount
        );
    }

    if (
      !Number.isFinite(bonusAmount) ||
      bonusAmount <= 0
    ) {

      await client.query("ROLLBACK");

      return {
        applied: false,
        amount: 0,
        campaign
      };
    }

    const result =
      await addBonusToUser(
        client,
        user.id,
        bonusAmount,
        "deposit_bonus",
        depositReference,
        `Deposit bonus: ${campaign.name}`,
        campaign.id
      );

    await client.query("COMMIT");

    return {
      applied: result.applied,
      duplicate: result.duplicate,
      amount: result.amount,
      balance: result.balance,
      campaign
    };

  } catch (err) {

    await safeRollback(client);

    throw err;

  } finally {

    client.release();

  }
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
