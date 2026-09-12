/**
 * db.js — PostgreSQL database layer for Beteseb Bingo
 *
 * Admin identification:
 *   Uses users.is_admin = TRUE
 *
 * No hard-coded ADMIN_ID is used.
 *
 * Install:
 *   npm install pg
 *
 * Environment:
 *   DATABASE_URL=postgresql://user:pass@host:5432/beteseb_bingo
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
      : false
});

function normalizeEthiopianPhone(phone) {
  if (!phone) {
    return null;
  }

  let digits =
    String(phone).replace(/\D/g, "");

  // 0912345678 → 251912345678
  if (
    digits.startsWith("09") &&
    digits.length === 10
  ) {
    digits =
      "251" + digits.substring(1);
  }

  // 0712345678 → 251712345678
  else if (
    digits.startsWith("07") &&
    digits.length === 10
  ) {
    digits =
      "251" + digits.substring(1);
  }

  // 912345678 → 251912345678
  else if (
    digits.length === 9 &&
    digits.startsWith("9")
  ) {
    digits =
      "251" + digits;
  }

  // 712345678 → 251712345678
  else if (
    digits.length === 9 &&
    digits.startsWith("7")
  ) {
    digits =
      "251" + digits;
  }

  // 251912345678 / 251712345678
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
  // USER FINANCIAL STATISTICS
  // ============================================================

  async getUserFinancialStatistics(
    userId
  ) {

    const result = await pool.query(`
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
    `, [
      userId
    ]);

    if (
      result.rows.length === 0
    ) {
      return null;
    }

    const row =
      result.rows[0];

    return {

      totalDepositAmount:
        Number(
          row.total_deposit_amount || 0
        ),

      approvedWithdrawalAmount:
        Number(
          row.approved_withdrawal_amount || 0
        ),

      pendingWithdrawalAmount:
        Number(
          row.pending_withdrawal_amount || 0
        ),

      rejectedWithdrawalAmount:
        Number(
          row.rejected_withdrawal_amount || 0
        )

    };

  },

  // ============================================================
  // ADMIN FINANCIAL STATISTICS
  // ============================================================

  async getAdminFinancialStatistics() {

    const result = await pool.query(`
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
    `);

    const row =
      result.rows[0];

    return {
      totalDepositAmount:
        Number(
          row.total_deposit_amount || 0
        ),

      approvedWithdrawalAmount:
        Number(
          row.approved_withdrawal_amount || 0
        ),

      pendingWithdrawalAmount:
        Number(
          row.pending_withdrawal_amount || 0
        ),

      rejectedWithdrawalAmount:
        Number(
          row.rejected_withdrawal_amount || 0
        )
    };

  },

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

  // ============================================================
  // ADMIN USER MANAGEMENT
  // ============================================================

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
          is_admin,
          admin_role
        FROM users
        WHERE phone = $1
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
        AND is_banned = FALSE
        AND is_blocked = FALSE
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
        AND is_admin = FALSE
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

    const row =
      result.rows[0];

    return {
      totalDeposits:
        Number(
          row.total_deposits || 0
        ),

      pendingWithdrawals:
        Number(
          row.pending_withdrawals || 0
        ),

      approvedWithdrawals:
        Number(
          row.approved_withdrawals || 0
        ),

      rejectedWithdrawals:
        Number(
          row.rejected_withdrawals || 0
        ),

      totalTransfers:
        Number(
          row.total_transfers || 0
        )
    };
  },

  // ============================================================
  // USER OPERATIONS
  // ============================================================

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

      // Check Telegram ID first
      const telegramResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          FOR UPDATE
          `,
          [telegramId]
        );

      const telegramUser =
        telegramResult.rows[0];

      if (telegramUser) {

        if (
          telegramUser.is_banned
        ) {

          await client.query(
            "ROLLBACK"
          );

          return {
            status: "banned",
            user: telegramUser
          };
        }

        if (
          telegramUser.is_blocked
        ) {

          await client.query(
            "ROLLBACK"
          );

          return {
            status: "blocked",
            user: telegramUser
          };
        }

        const updateResult =
          await client.query(
            `
            UPDATE users
            SET
              name = $1,
              phone = $2,
              is_active = TRUE
            WHERE id = $3
            RETURNING *
            `,
            [
              name,
              normalizedPhone,
              telegramUser.id
            ]
          );

        await client.query(
          "COMMIT"
        );

        return {
          status: "existing",
          user:
            updateResult.rows[0]
        };
      }

      // Check whether phone already belongs to
      // another Telegram account.
      const phoneResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE phone = $1
          FOR UPDATE
          `,
          [normalizedPhone]
        );

      const phoneUser =
        phoneResult.rows[0];

      if (phoneUser) {

        if (
          phoneUser.is_banned
        ) {

          await client.query(
            "ROLLBACK"
          );

          return {
            status: "banned",
            user: phoneUser
          };
        }

        if (
          phoneUser.is_blocked
        ) {

          await client.query(
            "ROLLBACK"
          );

          return {
            status: "blocked",
            user: phoneUser
          };
        }

        const reconnectResult =
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
              phoneUser.id
            ]
          );

        await client.query(
          "COMMIT"
        );

        return {
          status: "reconnected",
          user:
            reconnectResult.rows[0]
        };
      }

      // Create new user
      const insertResult =
        await client.query(
          `
          INSERT INTO users (
            telegram_id,
            name,
            phone,
            balance,
            is_active,
            is_banned,
            is_blocked,
            is_admin
          )
          VALUES (
            $1,
            $2,
            $3,
            0,
            TRUE,
            FALSE,
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

      await client.query(
        "COMMIT"
      );

      return {
        status: "created",
        user:
          insertResult.rows[0]
      };

    } catch (err) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "registerUser error:",
        err
      );

      throw err;

    } finally {

      client.release();

    }
  },

  // ============================================================
  // RECONNECT USER BY PHONE
  // ============================================================

  async reconnectUserByPhone(
    telegramId,
    phone
  ) {

    const normalizedPhone =
      normalizeEthiopianPhone(phone);

    if (!normalizedPhone) {
      return null;
    }

    const result =
      await pool.query(
        `
        UPDATE users
        SET
          telegram_id = $1,
          is_active = TRUE
        WHERE phone = $2
          AND is_banned = FALSE
          AND is_blocked = FALSE
        RETURNING *
        `,
        [
          telegramId,
          normalizedPhone
        ]
      );

    return result.rows[0] || null;
  },

  // ============================================================
  // GET USER
  // ============================================================

  async getUserByTelegramId(
    telegramId
  ) {

    const result =
      await pool.query(
        `
        SELECT *
        FROM users
        WHERE telegram_id = $1
          AND is_active = TRUE
        LIMIT 1
        `,
        [telegramId]
      );

    return result.rows[0] || null;
  },

  async getUserById(
    userId
  ) {

    const result =
      await pool.query(
        `
        SELECT *
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      );

    return result.rows[0] || null;
  },

  // ============================================================
  // ADMIN CHECK
  // ============================================================

  async isAdmin(
    telegramId
  ) {

    const result =
      await pool.query(
        `
        SELECT
          is_admin,
          admin_role
        FROM users
        WHERE telegram_id = $1
          AND is_active = TRUE
          AND is_banned = FALSE
          AND is_blocked = FALSE
          AND is_admin = TRUE
        LIMIT 1
        `,
        [telegramId]
      );

    return result.rows[0] || null;
  },

  // ============================================================
  // GET ALL ADMINS
  // ============================================================

  async getAllAdmins() {

    const result =
      await pool.query(
        `
        SELECT
          id,
          telegram_id,
          name,
          phone,
          is_admin,
          admin_role,
          is_active
        FROM users
        WHERE is_admin = TRUE
          AND is_active = TRUE
          AND is_banned = FALSE
          AND is_blocked = FALSE
        ORDER BY
          CASE
            WHEN admin_role = 'main'
              THEN 1
            WHEN admin_role = 'statistics'
              THEN 2
            WHEN admin_role = 'withdrawal'
              THEN 3
            WHEN admin_role = 'broadcast'
              THEN 4
            ELSE 5
          END,
          name
        `
      );

    return result.rows;
  },
