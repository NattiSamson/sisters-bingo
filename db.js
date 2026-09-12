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
      await client.query("ROLLBACK");
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

  // ============================================================
  // PAYMENT METHODS
  // ============================================================

  async getActivePaymentMethods() {

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          name,
          amharic_name,
          type,
          emoji,
          is_active
        FROM payment_methods
        WHERE is_active = TRUE
        ORDER BY id
        `
      );

    return rows;
  },

  async getPaymentMethodById(
    paymentMethodId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          id,
          name,
          amharic_name,
          type,
          emoji,
          is_active
        FROM payment_methods
        WHERE id = $1
        LIMIT 1
        `,
        [paymentMethodId]
      );

    return rows[0] || null;
  },

  // ============================================================
  // PAYMENT ACCOUNTS
  // ============================================================

  async getActivePaymentAccounts(
    paymentMethodId
  ) {

    const { rows } =
      await pool.query(
        `
        SELECT
          pa.id,
          pa.payment_method_id,
          pa.account_name,
          pa.account_number,
          pa.balance,
          pa.is_active,
          pa.is_removed,

          pm.name AS payment_method,
          pm.amharic_name AS payment_method_amharic,
          pm.type AS payment_method_type,
          pm.emoji AS payment_method_emoji

        FROM payment_accounts pa

        INNER JOIN payment_methods pm
          ON pm.id = pa.payment_method_id

        WHERE pa.payment_method_id = $1
          AND pa.is_active = TRUE
          AND COALESCE(pa.is_removed, FALSE) = FALSE
          AND pm.is_active = TRUE

        ORDER BY pa.id
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
          pa.account_name,
          pa.account_number,
          pa.balance,
          pa.is_active,
          pa.is_removed,

          pm.name AS payment_method,
          pm.amharic_name AS payment_method_amharic,
          pm.type AS payment_method_type,
          pm.emoji AS payment_method_emoji

        FROM payment_accounts pa

        INNER JOIN payment_methods pm
          ON pm.id = pa.payment_method_id

        WHERE pa.id = $1
        LIMIT 1
        `,
        [paymentAccountId]
      );

    return rows[0] || null;
  },

  // ============================================================
  // CREATE PAYMENT ACCOUNT
  // ============================================================

  async createPaymentAccount(
    paymentMethodId,
    accountName,
    accountNumber,
    balance = 0
  ) {

    const methodResult =
      await pool.query(
        `
        SELECT
          id,
          name,
          type,
          is_active
        FROM payment_methods
        WHERE id = $1
          AND is_active = TRUE
        LIMIT 1
        `,
        [paymentMethodId]
      );

    if (
      methodResult.rows.length === 0
    ) {
      throw new Error(
        "Payment method not found or inactive."
      );
    }

    const method =
      methodResult.rows[0];

    let cleanAccount =
      String(accountNumber || "")
        .trim();

    /*
     * Only mobile payment accounts are
     * normalized by removing spaces,
     * dashes and parentheses.
     *
     * Bank accounts / other payment types
     * keep their supplied format.
     */
    if (
      String(method.type || "")
        .toLowerCase() === "mobile" ||
      String(method.type || "")
        .includes("ሞባይል")
    ) {
      cleanAccount =
        cleanAccount.replace(
          /[\s\-()]/g,
          ""
        );
    }

    if (!cleanAccount) {
      throw new Error(
        "Account number is required."
      );
    }

    const accountNameClean =
      String(accountName || "")
        .trim();

    if (!accountNameClean) {
      throw new Error(
        "Account name is required."
      );
    }

    const initialBalance =
      Number(balance);

    if (
      !Number.isFinite(initialBalance) ||
      initialBalance < 0
    ) {
      throw new Error(
        "Invalid initial balance."
      );
    }

    // Prevent duplicate active account
    // under the same payment method.
    const duplicateResult =
      await pool.query(
        `
        SELECT id
        FROM payment_accounts
        WHERE payment_method_id = $1
          AND account_number = $2
          AND COALESCE(is_removed, FALSE) = FALSE
        LIMIT 1
        `,
        [
          paymentMethodId,
          cleanAccount
        ]
      );

    if (
      duplicateResult.rows.length > 0
    ) {
      throw new Error(
        "This payment account already exists."
      );
    }

    const { rows } =
      await pool.query(
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
          $4,
          TRUE,
          FALSE
        )
        RETURNING
          id,
          payment_method_id,
          account_name,
          account_number,
          balance,
          is_active,
          is_removed
        `,
        [
          paymentMethodId,
          accountNameClean,
          cleanAccount,
          initialBalance
        ]
      );

    return rows[0] || null;
  },

  // ============================================================
  // TOGGLE PAYMENT ACCOUNT
  // ============================================================

  async togglePaymentAccount(
    paymentAccountId
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE payment_accounts

        SET
          is_active =
            NOT COALESCE(is_active, FALSE)

        WHERE id = $1
          AND COALESCE(is_removed, FALSE) = FALSE

        RETURNING
          id,
          payment_method_id,
          account_name,
          account_number,
          balance,
          is_active,
          is_removed
        `,
        [paymentAccountId]
      );

    return rows[0] || null;
  },

  async removePaymentAccount(
    paymentAccountId
  ) {

    const { rows } =
      await pool.query(
        `
        UPDATE payment_accounts

        SET
          is_active = FALSE,
          is_removed = TRUE

        WHERE id = $1

        RETURNING
          id,
          payment_method_id,
          account_name,
          account_number,
          balance,
          is_active,
          is_removed
        `,
        [paymentAccountId]
      );

    return rows[0] || null;
  },

  // ============================================================
  // FIND TELEBIRR PAYMENT ACCOUNT
  // ============================================================

  async findActivePaymentAccountByLast4(
    last4
  ) {

    const cleanLast4 =
      String(last4 || "")
        .replace(/\D/g, "")
        .slice(-4);

    if (
      cleanLast4.length !== 4
    ) {
      return null;
    }

    const { rows } =
      await pool.query(
        `
        SELECT
          pa.id,
          pa.payment_method_id,
          pa.account_name,
          pa.account_number,
          pa.balance,
          pa.is_active,
          pa.is_removed,

          pm.name AS payment_method,
          pm.amharic_name AS payment_method_amharic,
          pm.type AS payment_method_type,
          pm.emoji AS payment_method_emoji

        FROM payment_accounts pa

        INNER JOIN payment_methods pm
          ON pm.id = pa.payment_method_id

        WHERE pa.is_active = TRUE
          AND COALESCE(pa.is_removed, FALSE) = FALSE
          AND pm.is_active = TRUE

          AND (
            LOWER(COALESCE(pm.name, '')) =
              LOWER('Telebirr')

            OR LOWER(
              COALESCE(pm.type, '')
            ) = LOWER('mobile')

            OR COALESCE(pm.type, '') LIKE '%ሞባይል%'
          )

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

        LIMIT 1
        `,
        [cleanLast4]
      );

    return rows[0] || null;
  },

  // ============================================================
  // DEPOSIT APPROVAL
  //
  // IMPORTANT:
  // This operation is transactional.
  //
  // It locks:
  //   1. User
  //   2. Payment account
  //
  // Then:
  //   - checks duplicate receipt
  //   - increases user balance
  //   - inserts deposit
  //   - increases payment account balance
  //
  // Everything commits together.
  // ============================================================

  async approveDepositttttttttttt(
    receipt,
    telegramId
  ) {

    if (!receipt) {
      throw new Error(
        "Receipt data is missing."
      );
    }

    const receiptNo =
      String(
        receipt.receiptNo ||
        receipt.receiptNumber ||
        ""
      ).trim();

    if (!receiptNo) {
      throw new Error(
        "Receipt number is missing."
      );
    }

    const creditedAccount =
      String(
        receipt.creditedPartyAccountNo ||
        receipt.creditedPartyAccount ||
        ""
      ).trim();

    if (!creditedAccount) {
      throw new Error(
        "Credited payment account is missing."
      );
    }

    const amountString =
      String(
        receipt.settledAmount ||
        receipt.totalPaidAmount ||
        ""
      );

    const numericAmount =
      Number(
        amountString.replace(
          /[^0-9.]/g,
          ""
        )
      );

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      throw new Error(
        "Invalid receipt amount."
      );
    }

    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );

      // ========================================================
      // 1. LOCK USER
      // ========================================================

      const userResult =
        await client.query(
          `
          SELECT
            id,
            telegram_id,
            name,
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
        userResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        throw new Error(
          "User account not found."
        );
      }

      const user =
        userResult.rows[0];

      if (
        user.is_active !== true
      ) {

        await client.query(
          "ROLLBACK"
        );

        throw new Error(
          "Your account is inactive."
        );
      }

      if (
        user.is_banned === true
      ) {

        await client.query(
          "ROLLBACK"
        );

        throw new Error(
          "Your account is banned."
        );
      }

      if (
        user.is_blocked === true
      ) {

        await client.query(
          "ROLLBACK"
        );

        throw new Error(
          "Your account is blocked."
        );
      }

      // ========================================================
      // 2. FIND + LOCK PAYMENT ACCOUNT
      // ========================================================

      const accountDigits =
        creditedAccount
          .replace(
            /\D/g,
            ""
          );

      const last4 =
        accountDigits.slice(-4);

      if (
        last4.length !== 4
      ) {

        await client.query(
          "ROLLBACK"
        );

        throw new Error(
          "Invalid credited payment account."
        );
      }

      const accountResult =
        await client.query(
          `
          SELECT
            pa.id,
            pa.payment_method_id,
            pa.account_name,
            pa.account_number,
            pa.balance,
            pa.is_active,
            pa.is_removed,

            pm.name AS payment_method,
            pm.amharic_name AS payment_method_amharic,
            pm.type AS payment_method_type

          FROM payment_accounts pa

          INNER JOIN payment_methods pm
            ON pm.id = pa.payment_method_id

          WHERE pa.is_active = TRUE
            AND COALESCE(pa.is_removed, FALSE) = FALSE
            AND pm.is_active = TRUE

            AND (
              LOWER(COALESCE(pm.name, '')) =
                LOWER('Telebirr')

              OR LOWER(
                COALESCE(pm.type, '')
              ) = LOWER('mobile')

              OR COALESCE(pm.type, '') LIKE '%ሞባይል%'
            )

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

          LIMIT 1

          FOR UPDATE
          `,
          [last4]
        );

      if (
        accountResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        throw new Error(
          "The payment account in the receipt does not match an active Telebirr account."
        );
      }

      const account =
        accountResult.rows[0];

      // ========================================================
      // 3. OPTIONAL ACCOUNT NAME MATCH
      // ========================================================

      if (
        receipt.creditedPartyName &&
        account.account_name
      ) {

        const receiptName =
          String(
            receipt.creditedPartyName
          )
            .trim()
            .toLowerCase();

        const accountName =
          String(
            account.account_name
          )
            .trim()
            .toLowerCase();

        if (
          receiptName &&
          accountName &&
          receiptName !== accountName
        ) {

          await client.query(
            "ROLLBACK"
          );

          throw new Error(
            "The payment account name does not match."
          );
        }
      }

      // ========================================================
      // 4. DUPLICATE RECEIPT CHECK
      // ========================================================

      const duplicateResult =
        await client.query(
          `
          SELECT
            id
          FROM deposits
          WHERE reference = $1
          LIMIT 1
          `,
          [receiptNo]
        );

      if (
        duplicateResult.rows.length > 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          duplicate: true,
          message:
            "This deposit receipt has already been used."
        };
      }

      // ========================================================
      // 5. BALANCES
      // ========================================================

      const currentUserBalance =
        Number(
          user.balance || 0
        );

      const currentAccountBalance =
        Number(
          account.balance || 0
        );

      const userBalanceAfter =
        currentUserBalance +
        numericAmount;

      const accountBalanceAfter =
        currentAccountBalance +
        numericAmount;

      // ========================================================
      // 6. UPDATE USER BALANCE
      // ========================================================

      const userUpdate =
        await client.query(
          `
          UPDATE users

          SET
            balance = $1,
            last_seen = NOW()

          WHERE id = $2

          RETURNING balance
          `,
          [
            userBalanceAfter,
            user.id
          ]
        );

      if (
        userUpdate.rows.length === 0
      ) {

        throw new Error(
          "Could not update user balance."
        );
      }

      // ========================================================
      // 7. INSERT DEPOSIT
      // ========================================================

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

          ON CONFLICT (reference)
          WHERE reference IS NOT NULL
          DO NOTHING

          RETURNING id
          `,
          [
            user.id,
            account.id,
            account.payment_method_id,
            receipt.payerName || null,
            receipt.payerTelebirrNo || null,
            numericAmount,
            userBalanceAfter,
            receiptNo
          ]
        );

      // If another request inserted the same
      // receipt between the duplicate check
      // and this insert, do not credit twice.
      if (
        depositResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return {
          success: false,
          duplicate: true,
          message:
            "This deposit receipt has already been used."
        };
      }

      // ========================================================
      // 8. UPDATE PAYMENT ACCOUNT BALANCE
      // ========================================================

      const accountUpdate =
        await client.query(
          `
          UPDATE payment_accounts

          SET
            balance = $1

          WHERE id = $2

          RETURNING balance
          `,
          [
            accountBalanceAfter,
            account.id
          ]
        );

      if (
        accountUpdate.rows.length === 0
      ) {

        throw new Error(
          "Could not update payment account balance."
        );
      }

      // ========================================================
      // 9. COMMIT
      // ========================================================

      await client.query(
        "COMMIT"
      );

      return {

        success: true,

        deposit_id:
          depositResult.rows[0].id,

        user_id:
          user.id,

        telegram_id:
          user.telegram_id,

        amount:
          numericAmount,

        balance_before:
          currentUserBalance,

        balance_after:
          userBalanceAfter,

        payment_account_id:
          account.id,

        payment_account_balance_before:
          currentAccountBalance,

        payment_account_balance_after:
          accountBalanceAfter,

        receipt_no:
          receiptNo,

        payer_name:
          receipt.payerName || null,

        payer_account:
          receipt.payerTelebirrNo || null

      };

    } catch (err) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (rollbackError) {
        console.error(
          "Deposit rollback error:",
          rollbackError
        );
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
            AND is_blocked = FALSE
            AND admin_role IN ('main', 'withdrawal')
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

  /**
   * Create a payment account for an active payment method.
   * Main-admin authorization is enforced by bot.js; this function
   * performs database validation and returns the complete account row.
   */
  async createPaymentAccount(
    paymentMethodId,
    accountName,
    accountNumber,
    initialBalance = 0
  ) {
    const methodId = Number(paymentMethodId);
    const balance = Number(initialBalance);
    const name = String(accountName || "").trim();
    const number = String(accountNumber || "").trim();

    if (!Number.isInteger(methodId) || methodId <= 0) {
      return { success: false, message: "Invalid payment method." };
    }
    if (!name || name.length > 100) {
      return { success: false, message: "Invalid account name." };
    }
    if (!number || number.length > 100) {
      return { success: false, message: "Invalid account number." };
    }
    if (!Number.isFinite(balance) || balance < 0 || balance > 99999999.99) {
      return { success: false, message: "Invalid initial balance." };
    }

    try {
      const duplicate = await pool.query(
        `SELECT 1
         FROM payment_accounts
         WHERE payment_method_id = $1
           AND account_number = $2
           AND is_removed = FALSE
         LIMIT 1`,
        [methodId, number]
      );

      if (duplicate.rows.length) {
        return { success: false, message: "This payment account already exists for the selected payment method." };
      }

      const { rows } = await pool.query(
        `
        INSERT INTO payment_accounts (
          payment_method_id,
          account_name,
          account_number,
          balance,
          is_active,
          is_removed
        )
        SELECT
          pm.id,
          $2,
          $3,
          $4,
          TRUE,
          FALSE
        FROM payment_methods pm
        JOIN payment_types pt ON pt.id = pm.type_id
        WHERE pm.id = $1
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE
          AND (pt.maximum_balance IS NULL OR $4 <= pt.maximum_balance)
        RETURNING id
        `,
        [methodId, name, number, balance]
      );

      if (!rows.length) {
        return { success: false, message: "Payment method is inactive or not found." };
      }

      const { rows: accountRows } = await pool.query(
        `
        SELECT
          pa.id, pa.payment_method_id, pa.account_name, pa.account_number,
          pa.balance, pa.is_active, pa.is_removed,
          pm.name AS pm_name, pm.amharic_name AS pm_amharic_name, pm.emoji AS pm_emoji,
          pt.name AS pt_name, pt.amharic_name AS pt_amharic_name, pt.emoji AS pt_emoji
        FROM payment_accounts pa
        JOIN payment_methods pm ON pm.id = pa.payment_method_id
        JOIN payment_types pt ON pt.id = pm.type_id
        WHERE pa.id = $1
        LIMIT 1
        `,
        [rows[0].id]
      );

      return { success: true, account: accountRows[0] || null };
    } catch (err) {
      console.error("createPaymentAccount error:", err);
      return { success: false, message: "Could not create payment account." };
    }
  },

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

        pm.is_active = TRUE

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

  async approveDepositttttttttttt(receipt, telegramId) {
    const client = await pool.connect();

    try {
      const reference = String(receipt?.receiptNo || "").trim();
      if (!reference) return -1;

      const creditedAccount = String(receipt?.creditedPartyAccountNo || "").trim();
      const creditedName = String(receipt?.creditedPartyName || "").trim();
      const rawAmount = String(receipt?.settledAmount || "");
      const depositAmount = Number(rawAmount.replace(/[^0-9.]/g, ""));

      if (!creditedAccount || creditedAccount.length < 4 || !Number.isFinite(depositAmount) || depositAmount <= 0) {
        return -2;
      }

      await client.query("BEGIN");

      // Lock the target user so concurrent deposits cannot overwrite balance.
      const userResult = await client.query(
        `SELECT id, telegram_id, balance, is_active, is_banned, is_blocked
         FROM users WHERE telegram_id = $1 FOR UPDATE`,
        [telegramId]
      );
      if (!userResult.rows.length) throw new Error("User not found");
      const user = userResult.rows[0];
      if (!user.is_active || user.is_banned || user.is_blocked) {
        await client.query("ROLLBACK");
        return -3;
      }

      // Match an active Telebirr receiving account by the last 4 digits.
      const accountResult = await client.query(
        `
        SELECT
          pa.id, pa.payment_method_id, pa.account_number, pa.account_name, pa.balance,
          pm.name AS pm_name, pm.amharic_name AS pm_amharic_name,
          pt.name AS pt_name, pt.amharic_name AS pt_amharic_name
        FROM payment_accounts pa
        JOIN payment_methods pm ON pm.id = pa.payment_method_id
        JOIN payment_types pt ON pt.id = pm.type_id
        WHERE pa.is_active = TRUE
          AND pa.is_removed = FALSE
          AND pm.is_active = TRUE
          AND pt.is_active = TRUE
          AND RIGHT(REGEXP_REPLACE(pa.account_number, '[^0-9]', '', 'g'), 4) =
              RIGHT(REGEXP_REPLACE($1, '[^0-9]', '', 'g'), 4)
          AND LOWER(pm.name) LIKE '%telebirr%'
        ORDER BY pa.id
        LIMIT 1
        FOR UPDATE OF pa
        `,
        [creditedAccount]
      );

      if (!accountResult.rows.length) {
        await client.query("ROLLBACK");
        return -4;
      }

      const account = accountResult.rows[0];

      // If Telebirr supplied the credited name, require the configured account name to match.
      if (creditedName && account.account_name && creditedName.trim() !== account.account_name.trim()) {
        await client.query("ROLLBACK");
        return -5;
      }

      // Database uniqueness is the final duplicate-protection layer.
      const duplicate = await client.query(
        `SELECT 1 FROM deposits WHERE reference = $1 LIMIT 1 FOR UPDATE`,
        [reference]
      );
      if (duplicate.rows.length) {
        await client.query("ROLLBACK");
        return -1;
      }

      const userBalanceResult = await client.query(
        `UPDATE users
         SET balance = balance + $1, last_seen = NOW()
         WHERE id = $2
         RETURNING balance`,
        [depositAmount, user.id]
      );
      const amountAfter = Number(userBalanceResult.rows[0].balance);

      const depositResult = await client.query(
        `INSERT INTO deposits (
          user_id, payment_account_id, deposit_method_id, depositor_name,
          depositor_account, amount, amount_after, reference, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (reference) DO NOTHING
        RETURNING id`,
        [
          user.id, account.id, account.payment_method_id, creditedName || receipt?.payerName || null,
          receipt?.payerTelebirrNo || null, depositAmount, amountAfter, reference
        ]
      );

      if (!depositResult.rows.length) {
        throw new Error("Duplicate deposit reference");
      }

      await client.query(
        `UPDATE payment_accounts
         SET balance = COALESCE(balance, 0) + $1
         WHERE id = $2`,
        [depositAmount, account.id]
      );

      await client.query("COMMIT");
      return depositAmount;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      if (err.message === "Duplicate deposit reference") return -1;
      console.error("approveDeposit error:", err);
      throw err;
    } finally {
      client.release();
    }
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
        AND is_blocked = FALSE
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
            is_banned,
            is_blocked

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
        sender.is_banned ||
        sender.is_blocked
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
        recipient.is_banned ||
        recipient.is_blocked
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

