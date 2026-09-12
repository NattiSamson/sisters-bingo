/**
 * db.js — PostgreSQL database layer for Sisters Bingo
 *
 * Database: Neon PostgreSQL
 *
 * IMPORTANT:
 *   npm install pg
 *
 * Environment:
 *   DATABASE_URL=postgresql://...
 *
 * This file is designed to match the Sisters Bingo
 * PostgreSQL schema:
 *
 * users
 * payment_types
 * payment_methods
 * payment_accounts
 * deposits
 * withdrawals
 * transfers
 * games
 * game_participants
 * broadcast_drafts
 * leaderboard
 *
 * Admin roles:
 *   main
 *   statistics
 *   withdrawal
 *   broadcast
 */

"use strict";

const { Pool } = require("pg");


// ============================================================
// DATABASE CONNECTION
// ============================================================

if (!process.env.DATABASE_URL) {
  console.warn(
    "WARNING: DATABASE_URL environment variable is not set."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  max: Number(process.env.DB_POOL_MAX || 10),

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000,

  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

pool.on("error", (err) => {
  console.error(
    "PostgreSQL pool error:",
    err
  );
});


// ============================================================
// HELPERS
// ============================================================

function normalizeEthiopianPhone(phone) {
  if (phone == null) {
    return null;
  }

  const digits = String(phone).replace(/\D/g, "");

  // 0912345678
  if (
    digits.startsWith("09") &&
    digits.length === 10
  ) {
    return "251" + digits.slice(1);
  }

  // 0712345678
  if (
    digits.startsWith("07") &&
    digits.length === 10
  ) {
    return "251" + digits.slice(1);
  }

  // 912345678
  if (
    digits.length === 9 &&
    digits.startsWith("9")
  ) {
    return "251" + digits;
  }

  // 712345678
  if (
    digits.length === 9 &&
    digits.startsWith("7")
  ) {
    return "251" + digits;
  }

  // 251912345678 / 251712345678
  if (
    digits.startsWith("251") &&
    digits.length === 12
  ) {
    return digits;
  }

  return null;
}


function validPositiveAmount(amount) {
  const value = Number(amount);

  return (
    Number.isFinite(value) &&
    value > 0
  );
}


function validId(value) {
  const number = Number(value);

  return (
    Number.isInteger(number) &&
    number > 0
  )
    ? number
    : null;
}


async function transaction(callback) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await callback(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Rollback error:",
        rollbackError
      );
    }

    throw error;
  } finally {
    client.release();
  }
}


// ============================================================
// USER LOOKUP
// ============================================================

async function getUserByTelegramId(telegramId) {
  const result = await pool.query(
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
}


async function getUserByTelegramIdIncludingInactive(
  telegramId
) {
  const result = await pool.query(
    `
    SELECT *
    FROM users
    WHERE telegram_id = $1
    LIMIT 1
    `,
    [telegramId]
  );

  return result.rows[0] || null;
}


async function getUserByPhone(phone) {
  const normalizedPhone =
    normalizeEthiopianPhone(phone);

  if (!normalizedPhone) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT *
    FROM users
    WHERE phone = $1
    LIMIT 1
    `,
    [normalizedPhone]
  );

  return result.rows[0] || null;
}


async function getUserByPhoneForAdmin(phone) {
  const normalizedPhone =
    normalizeEthiopianPhone(phone);

  if (!normalizedPhone) {
    return null;
  }

  const result = await pool.query(
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
      is_active,
      is_banned,
      is_blocked,
      is_admin,
      admin_role,
      created_at,
      last_seen
    FROM users
    WHERE phone = $1
    LIMIT 1
    `,
    [normalizedPhone]
  );

  return result.rows[0] || null;
}


// ============================================================
// USER REGISTRATION
// ============================================================

async function registerUser(
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

  return transaction(async (client) => {

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

    if (telegramResult.rows.length > 0) {
      return {
        status: "existing_telegram",
        user: telegramResult.rows[0]
      };
    }


    const phoneResult =
      await client.query(
        `
        SELECT *
        FROM users
        WHERE phone = $1
        LIMIT 1
        FOR UPDATE
        `,
        [normalizedPhone]
      );


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

    return {
      status: "new",
      user: inserted.rows[0]
    };
  });
}


// ============================================================
// RECONNECT USER
// ============================================================

async function reconnectUserByPhone(
  telegramId,
  name,
  phone
) {
  const normalizedPhone =
    normalizeEthiopianPhone(phone);

  if (!normalizedPhone) {
    return {
      status: "not_found"
    };
  }

  return transaction(async (client) => {

    const result =
      await client.query(
        `
        SELECT *
        FROM users
        WHERE phone = $1
        LIMIT 1
        FOR UPDATE
        `,
        [normalizedPhone]
      );


    if (result.rows.length === 0) {
      return {
        status: "not_found"
      };
    }


    const user = result.rows[0];


    if (
      String(user.telegram_id) ===
      String(telegramId)
    ) {
      return {
        status: "same_account",
        user
      };
    }


    const telegramCheck =
      await client.query(
        `
        SELECT *
        FROM users
        WHERE telegram_id = $1
        LIMIT 1
        `,
        [telegramId]
      );


    if (telegramCheck.rows.length > 0) {
      return {
        status: "telegram_already_used"
      };
    }


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
          user.id
        ]
      );


    return {
      status: "reconnected",
      user: updated.rows[0]
    };
  });
}


// ============================================================
// USER ACTIVATION / DEACTIVATION
// ============================================================

async function deactivateUser(
  telegramId
) {
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
}


async function reactivateUserByTelegramId(
  telegramId
) {
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
}


// ============================================================
// BLOCK / UNBLOCK USER
// ============================================================

async function setUserBlocked(
  userId,
  isBlocked
) {
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
      is_admin,
      admin_role
    `,
    [
      Boolean(isBlocked),
      userId
    ]
  );

  return result.rows[0] || null;
}


// ============================================================
// ADMIN MANAGEMENT
// ============================================================

async function getAdminByTelegramId(
  telegramId
) {
  const result = await pool.query(
    `
    SELECT *
    FROM users
    WHERE telegram_id = $1
      AND is_admin = TRUE
      AND is_active = TRUE
      AND COALESCE(is_banned, FALSE) = FALSE
    LIMIT 1
    `,
    [telegramId]
  );

  return result.rows[0] || null;
}


async function isAdmin(telegramId) {
  const result = await pool.query(
    `
    SELECT 1
    FROM users
    WHERE telegram_id = $1
      AND is_admin = TRUE
      AND is_active = TRUE
      AND COALESCE(is_banned, FALSE) = FALSE
    LIMIT 1
    `,
    [telegramId]
  );

  return result.rows.length > 0;
}


async function getAllAdmins() {
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
      is_blocked,
      created_at,
      last_seen
    FROM users
    WHERE is_admin = TRUE
    ORDER BY id ASC
    `
  );

  return result.rows;
}


async function setUserAdminRole(
  userId,
  role
) {
  const validRoles = [
    "main",
    "statistics",
    "withdrawal",
    "broadcast"
  ];

  if (!validRoles.includes(role)) {
    throw new Error(
      "Invalid admin role"
    );
  }

  const result = await pool.query(
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
      balance,
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

  return result.rows[0] || null;
}


async function removeUserAdminRole(
  userId
) {
  const result = await pool.query(
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
      balance,
      is_admin,
      admin_role,
      is_active,
      is_banned,
      is_blocked
    `,
    [userId]
  );

  return result.rows[0] || null;
}


// ============================================================
// USER STATISTICS
// ============================================================

async function getUserStatistics(
  telegramId
) {
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
        WHERE
          t.sender_telegram_id = u.telegram_id
          OR
          t.recipient_telegram_id = u.telegram_id
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
    totalDeposits:
      Number(row.total_deposits || 0),

    pendingWithdrawals:
      Number(row.pending_withdrawals || 0),

    approvedWithdrawals:
      Number(row.approved_withdrawals || 0),

    rejectedWithdrawals:
      Number(row.rejected_withdrawals || 0),

    totalTransfers:
      Number(row.total_transfers || 0)
  };
}


// ============================================================
// USER FINANCIAL STATISTICS
// ============================================================

async function getUserFinancialStatistics(
  userId
) {
  const result = await pool.query(
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

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    totalDepositAmount:
      Number(row.total_deposit_amount || 0),

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
}


// ============================================================
// ADMIN FINANCIAL STATISTICS
// ============================================================

async function getAdminFinancialStatistics() {
  const result = await pool.query(
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

  const row = result.rows[0];

  return {
    totalDepositAmount:
      Number(row.total_deposit_amount || 0),

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
}


// ============================================================
// ADMIN STATISTICS
// ============================================================

async function getAdminStatistics() {
  const result = await pool.query(
    `
    SELECT
      COUNT(*) AS total_users,

      COUNT(*) FILTER (
        WHERE is_active = TRUE
      ) AS active_users,

      COUNT(*) FILTER (
        WHERE COALESCE(is_blocked, FALSE) = TRUE
      ) AS blocked_users,

      COUNT(*) FILTER (
        WHERE COALESCE(is_banned, FALSE) = TRUE
      ) AS banned_users,

      COUNT(*) FILTER (
        WHERE is_admin = TRUE
      ) AS total_admins,

      COALESCE(
        SUM(balance),
        0
      ) AS total_user_balance,

      COALESCE(
        SUM(total_games),
        0
      ) AS total_games,

      COALESCE(
        SUM(total_wins),
        0
      ) AS total_wins,

      COALESCE(
        SUM(total_winnings),
        0
      ) AS total_winnings

    FROM users
    `
  );

  return result.rows[0] || null;
}


// ============================================================
// BALANCE
// ============================================================

async function updateBalance(
  userId,
  amount
) {
  if (!validPositiveAmount(amount)) {
    throw new Error(
      "Invalid balance amount"
    );
  }

  const result = await pool.query(
    `
    UPDATE users
    SET balance = balance + $1
    WHERE id = $2
    RETURNING *
    `,
    [
      amount,
      userId
    ]
  );

  return result.rows[0] || null;
}


// ============================================================
// PAYMENT TYPES
// ============================================================

async function getPaymentMethodTypes() {
  const result = await pool.query(
    `
    SELECT *
    FROM payment_types
    WHERE is_active = TRUE
    ORDER BY "order" ASC, id ASC
    `
  );

  return result.rows;
}


// ============================================================
// PAYMENT METHODS
// ============================================================

async function getPaymentMethods(
  typeId = null
) {
  let result;

  if (typeId != null) {
    result = await pool.query(
      `
      SELECT *
      FROM payment_methods
      WHERE type_id = $1
        AND is_active = TRUE
      ORDER BY "order" ASC, id ASC
      `,
      [typeId]
    );
  } else {
    result = await pool.query(
      `
      SELECT *
      FROM payment_methods
      WHERE is_active = TRUE
      ORDER BY "order" ASC, id ASC
      `
    );
  }

  return result.rows;
}


async function getPaymentMethodById(
  methodId
) {
  const result = await pool.query(
    `
    SELECT *
    FROM payment_methods
    WHERE id = $1
    LIMIT 1
    `,
    [methodId]
  );

  return result.rows[0] || null;
}


// ============================================================
// PAYMENT ACCOUNTS
// ============================================================

async function getPaymentAccount(
  accountId
) {
  const result = await pool.query(
    `
    SELECT
      pa.*,
      pm.name AS payment_method_name,
      pm.amharic_name AS payment_method_amharic_name,
      pm.emoji AS payment_method_emoji
    FROM payment_accounts pa
    LEFT JOIN payment_methods pm
      ON pm.id = pa.payment_method_id
    WHERE pa.id = $1
      AND COALESCE(pa.is_removed, FALSE) = FALSE
    LIMIT 1
    `,
    [accountId]
  );

  return result.rows[0] || null;
}


async function getPaymentAccountById(
  accountId
) {
  return getPaymentAccount(accountId);
}


async function getPaymentAccountsByMethod(
  paymentMethodId
) {
  const result = await pool.query(
    `
    SELECT
      pa.*,
      pm.name AS payment_method_name,
      pm.amharic_name AS payment_method_amharic_name,
      pm.emoji AS payment_method_emoji
    FROM payment_accounts pa
    LEFT JOIN payment_methods pm
      ON pm.id = pa.payment_method_id
    WHERE pa.payment_method_id = $1
      AND pa.is_active = TRUE
      AND COALESCE(pa.is_removed, FALSE) = FALSE
    ORDER BY pa.id ASC
    `,
    [paymentMethodId]
  );

  return result.rows;
}


async function getAllPaymentAccounts() {
  const result = await pool.query(
    `
    SELECT
      pa.*,
      pm.name AS payment_method_name,
      pm.amharic_name AS payment_method_amharic_name,
      pm.emoji AS payment_method_emoji
    FROM payment_accounts pa
    LEFT JOIN payment_methods pm
      ON pm.id = pa.payment_method_id
    WHERE COALESCE(pa.is_removed, FALSE) = FALSE
    ORDER BY pa.id ASC
    `
  );

  return result.rows;
}


async function getAllPaymentAccountsForAdmin() {
  const result = await pool.query(
    `
    SELECT
      pa.*,
      pm.name AS payment_method_name,
      pm.amharic_name AS payment_method_amharic_name,
      pm.emoji AS payment_method_emoji
    FROM payment_accounts pa
    LEFT JOIN payment_methods pm
      ON pm.id = pa.payment_method_id
    WHERE COALESCE(pa.is_removed, FALSE) = FALSE
    ORDER BY
      pm."order" ASC,
      pa.id ASC
    `
  );

  return result.rows;
}


// ============================================================
// CREATE PAYMENT ACCOUNT
// ============================================================

async function createPaymentAccount(
  paymentMethodId,
  accountNumber,
  accountName,
  balance = 0
) {
  if (!validId(paymentMethodId)) {
    throw new Error(
      "Invalid payment method"
    );
  }

  if (!accountNumber) {
    throw new Error(
      "Payment account number is required"
    );
  }

  const result = await pool.query(
    `
    INSERT INTO payment_accounts (
      payment_method_id,
      account_number,
      account_name,
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
    RETURNING *
    `,
    [
      paymentMethodId,
      String(accountNumber).trim(),
      accountName || null,
      Number(balance) || 0
    ]
  );

  return result.rows[0] || null;
}


// ============================================================
// PAYMENT ACCOUNT STATUS
// ============================================================

async function setPaymentAccountActive(
  accountId,
  isActive
) {
  const result = await pool.query(
    `
    UPDATE payment_accounts
    SET is_active = $1
    WHERE id = $2
      AND COALESCE(is_removed, FALSE) = FALSE
    RETURNING *
    `,
    [
      Boolean(isActive),
      accountId
    ]
  );

  return result.rows[0] || null;
}


async function activatePaymentAccount(
  accountId
) {
  return setPaymentAccountActive(
    accountId,
    true
  );
}


async function deactivatePaymentAccount(
  accountId
) {
  return setPaymentAccountActive(
    accountId,
    false
  );
}


async function removePaymentAccount(
  accountId
) {
  const result = await pool.query(
    `
    UPDATE payment_accounts
    SET
      is_active = FALSE,
      is_removed = TRUE
    WHERE id = $1
    RETURNING *
    `,
    [accountId]
  );

  return result.rows[0] || null;
}


async function deletePaymentAccount(
  accountId
) {
  return removePaymentAccount(accountId);
}


// ============================================================
// DEPOSIT
// ============================================================

/**
 * Process a verified Telebirr deposit.
 *
 * Return values intentionally preserved for bot compatibility:
 *
 *   -1 = duplicate receipt/reference
 *   -2 = payment account not found
 *   -3 = account name mismatch
 *   -4 = invalid receipt/amount
 *   >0 = successfully deposited amount
 *
 * Expected receipt:
 * {
 *   receiptNo,
 *   payerName,
 *   payerTelebirrNo,
 *   settledAmount
 * }
 */

async function approveDeposit(
  userId,
  receipt,
  expectedAccountName = null
) {
  if (!validId(userId)) {
    return -4;
  }

  if (!receipt) {
    return -4;
  }

  const reference =
    receipt.receiptNo ||
    receipt.reference;

  const payerName =
    receipt.payerName ||
    null;

  const payerAccount =
    receipt.payerTelebirrNo ||
    receipt.payerAccount ||
    receipt.payerAccountNumber ||
    null;

  const amountText =
    receipt.settledAmount ||
    receipt.amount;

  const amount =
    Number(
      String(amountText || "")
        .replace(/[^0-9.]/g, "")
    );

  if (
    !reference ||
    !validPositiveAmount(amount)
  ) {
    return -4;
  }


  return transaction(async (client) => {

    // --------------------------------------------------------
    // Duplicate reference
    // --------------------------------------------------------

    const duplicate =
      await client.query(
        `
        SELECT id
        FROM deposits
        WHERE reference = $1
        LIMIT 1
        FOR UPDATE
        `,
        [reference]
      );

    if (duplicate.rows.length > 0) {
      return -1;
    }


    // --------------------------------------------------------
    // Lock user
    // --------------------------------------------------------

    const userResult =
      await client.query(
        `
        SELECT
          id,
          balance,
          is_active,
          is_banned,
          is_blocked
        FROM users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [userId]
      );


    if (userResult.rows.length === 0) {
      return -4;
    }


    const user =
      userResult.rows[0];


    if (
      user.is_active === false ||
      user.is_banned === true ||
      user.is_blocked === true
    ) {
      return -4;
    }


    // --------------------------------------------------------
    // Find matching active payment account
    //
    // The receipt contains the account number that received
    // the money. The schema stores payment_accounts.account_number.
    //
    // Match last four digits.
    // --------------------------------------------------------

    if (!payerAccount) {
      return -2;
    }

    const payerDigits =
      String(payerAccount)
        .replace(/\D/g, "");

    if (payerDigits.length < 4) {
      return -2;
    }

    const lastFour =
      payerDigits.slice(-4);


    const accountResult =
      await client.query(
        `
        SELECT
          pa.*,
          pm.name AS payment_method_name
        FROM payment_accounts pa
        LEFT JOIN payment_methods pm
          ON pm.id = pa.payment_method_id
        WHERE pa.is_active = TRUE
          AND COALESCE(pa.is_removed, FALSE) = FALSE
          AND RIGHT(
            REGEXP_REPLACE(
              pa.account_number,
              '[^0-9]',
              '',
              'g'
            ),
            4
          ) = $1
        ORDER BY pa.id ASC
        LIMIT 1
        FOR UPDATE
        `,
        [lastFour]
      );


    if (accountResult.rows.length === 0) {
      return -2;
    }


    const paymentAccount =
      accountResult.rows[0];


    // --------------------------------------------------------
    // Optional account-name verification
    // --------------------------------------------------------

    if (expectedAccountName) {

      const expected =
        String(expectedAccountName)
          .trim()
          .toLowerCase();

      const actual =
        String(
          paymentAccount.account_name || ""
        )
          .trim()
          .toLowerCase();

      if (
        expected &&
        actual &&
        expected !== actual
      ) {
        return -3;
      }
    }


    // --------------------------------------------------------
    // Deposit method must correspond to the payment account
    // --------------------------------------------------------

    const depositMethodId =
      paymentAccount.payment_method_id;

    if (!validId(depositMethodId)) {
      return -4;
    }


    // --------------------------------------------------------
    // Insert deposit
    // --------------------------------------------------------

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
        RETURNING *
        `,
        [
          userId,
          paymentAccount.id,
          depositMethodId,
          payerName,
          payerAccount,
          amount,
          Number(user.balance) + amount,
          reference
        ]
      );


    // --------------------------------------------------------
    // Update user balance
    // --------------------------------------------------------

    const updatedUser =
      await client.query(
        `
        UPDATE users
        SET balance = balance + $1
        WHERE id = $2
        RETURNING balance
        `,
        [
          amount,
          userId
        ]
      );


    // --------------------------------------------------------
    // Update payment account balance
    // --------------------------------------------------------

    await client.query(
      `
      UPDATE payment_accounts
      SET balance = COALESCE(balance, 0) + $1
      WHERE id = $2
      `,
      [
        amount,
        paymentAccount.id
      ]
    );


    if (
      depositResult.rows.length === 0 ||
      updatedUser.rows.length === 0
    ) {
      return -4;
    }


    return amount;
  });
}


// ------------------------------------------------------------
// Compatibility with the existing bot typo
// ------------------------------------------------------------

async function approveDepositttttttttttt(
  userId,
  receipt,
  expectedAccountName = null
) {
  return approveDeposit(
    userId,
    receipt,
    expectedAccountName
  );
}


// ============================================================
// TRANSFERS
// ============================================================

async function transferBalance(
  senderTelegramId,
  recipientTelegramId,
  amount
) {
  if (
    !validPositiveAmount(amount)
  ) {
    return {
      success: false,
      error: "invalid_amount"
    };
  }

  if (
    String(senderTelegramId) ===
    String(recipientTelegramId)
  ) {
    return {
      success: false,
      error: "self_transfer"
    };
  }


  return transaction(async (client) => {

    // --------------------------------------------------------
    // Always lock users in deterministic ID order
    // to reduce deadlock risk.
    // --------------------------------------------------------

    const usersResult =
      await client.query(
        `
        SELECT *
        FROM users
        WHERE telegram_id IN ($1, $2)
        ORDER BY id ASC
        FOR UPDATE
        `,
        [
          senderTelegramId,
          recipientTelegramId
        ]
      );


    if (usersResult.rows.length !== 2) {
      return {
        success: false,
        error: "user_not_found"
      };
    }


    const sender =
      usersResult.rows.find(
        (u) =>
          String(u.telegram_id) ===
          String(senderTelegramId)
      );

    const recipient =
      usersResult.rows.find(
        (u) =>
          String(u.telegram_id) ===
          String(recipientTelegramId)
      );


    if (!sender || !recipient) {
      return {
        success: false,
        error: "user_not_found"
      };
    }


    if (
      sender.is_active === false ||
      sender.is_banned === true ||
      sender.is_blocked === true
    ) {
      return {
        success: false,
        error: "sender_unavailable"
      };
    }


    if (
      recipient.is_active === false ||
      recipient.is_banned === true ||
      recipient.is_blocked === true
    ) {
      return {
        success: false,
        error: "recipient_unavailable"
      };
    }


    if (
      Number(sender.balance) < Number(amount)
    ) {
      return {
        success: false,
        error: "insufficient_balance"
      };
    }


    const senderBefore =
      Number(sender.balance);

    const recipientBefore =
      Number(recipient.balance);


    const senderAfter =
      senderBefore - Number(amount);

    const recipientAfter =
      recipientBefore + Number(amount);


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
          sender_phone,
          recipient_phone,
          amount,
          sender_balance_before,
          sender_balance_after,
          recipient_balance_before,
          recipient_balance_after,
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
          amount,
          senderBefore,
          senderAfter,
          recipientBefore,
          recipientAfter
        ]
      );


    return {
      success: true,

      amount: Number(amount),

      senderBalance:
        senderAfter,

      recipientBalance:
        recipientAfter,

      transfer:
        transferResult.rows[0] || null
    };
  });
}


// ============================================================
// WITHDRAWALS
// ============================================================

async function createWithdrawal(
  userId,
  paymentMethodId,
  paymentAccountId,
  accountNumber,
  amount
) {
  if (!validId(userId)) {
    throw new Error(
      "Invalid user ID"
    );
  }

  if (!validId(paymentMethodId)) {
    throw new Error(
      "Invalid payment method"
    );
  }

  if (!validPositiveAmount(amount)) {
    throw new Error(
      "Invalid withdrawal amount"
    );
  }


  return transaction(async (client) => {

    const userResult =
      await client.query(
        `
        SELECT *
        FROM users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [userId]
      );


    if (userResult.rows.length === 0) {
      throw new Error(
        "User not found"
      );
    }


    const user =
      userResult.rows[0];


    if (
      user.is_active === false ||
      user.is_banned === true ||
      user.is_blocked === true
    ) {
      throw new Error(
        "User account unavailable"
      );
    }


    if (
      Number(user.balance) <
      Number(amount)
    ) {
      throw new Error(
        "Insufficient balance"
      );
    }


    let paymentAccount = null;


    if (validId(paymentAccountId)) {

      const accountResult =
        await client.query(
          `
          SELECT *
          FROM payment_accounts
          WHERE id = $1
            AND payment_method_id = $2
            AND is_active = TRUE
            AND COALESCE(is_removed, FALSE) = FALSE
          LIMIT 1
          FOR UPDATE
          `,
          [
            paymentAccountId,
            paymentMethodId
          ]
        );

      if (
        accountResult.rows.length === 0
      ) {
        throw new Error(
          "Payment account not found"
        );
      }

      paymentAccount =
        accountResult.rows[0];
    }


    const balanceBefore =
      Number(user.balance);

    const balanceAfter =
      balanceBefore -
      Number(amount);


    await client.query(
      `
      UPDATE users
      SET balance = $1
      WHERE id = $2
      `,
      [
        balanceAfter,
        userId
      ]
    );


    const withdrawalResult =
      await client.query(
        `
        INSERT INTO withdrawals (
          user_id,
          payment_method_id,
          payment_account_id,
          account_number,
          amount,
          is_pending,
          is_approved,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          TRUE,
          FALSE,
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          userId,
          paymentMethodId,
          paymentAccountId || null,
          accountNumber || null,
          amount
        ]
      );


    return withdrawalResult.rows[0] || null;
  });
}


// ============================================================
// PENDING WITHDRAWALS
// ============================================================

async function getPendingWithdrawals() {
  const result = await pool.query(
    `
    SELECT
      w.*,

      u.name AS user_name,
      u.phone AS user_phone,
      u.telegram_id,

      pm.name AS payment_method_name,
      pm.amharic_name AS payment_method_amharic_name,
      pm.emoji AS payment_method_emoji,

      pa.account_number AS payment_account_number,
      pa.account_name AS payment_account_name

    FROM withdrawals w

    LEFT JOIN users u
      ON u.id = w.user_id

    LEFT JOIN payment_methods pm
      ON pm.id = w.payment_method_id

    LEFT JOIN payment_accounts pa
      ON pa.id = w.payment_account_id

    WHERE w.is_pending = TRUE
      AND w.is_approved = FALSE

    ORDER BY
      w.created_at ASC,
      w.id ASC
    `
  );

  return result.rows;
}


// ============================================================
// APPROVE WITHDRAWAL
// ============================================================

async function approveWithdrawal(
  withdrawalId,
  adminId
) {
  if (!validId(withdrawalId)) {
    throw new Error(
      "Invalid withdrawal ID"
    );
  }

  if (!validId(adminId)) {
    throw new Error(
      "Invalid admin ID"
    );
  }


  return transaction(async (client) => {

    const adminResult =
      await client.query(
        `
        SELECT id
        FROM users
        WHERE id = $1
          AND is_admin = TRUE
          AND is_active = TRUE
        LIMIT 1
        `,
        [adminId]
      );


    if (adminResult.rows.length === 0) {
      throw new Error(
        "Unauthorized admin"
      );
    }


    const withdrawalResult =
      await client.query(
        `
        SELECT *
        FROM withdrawals
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [withdrawalId]
      );


    if (
      withdrawalResult.rows.length === 0
    ) {
      throw new Error(
        "Withdrawal not found"
      );
    }


    const withdrawal =
      withdrawalResult.rows[0];


    if (
      withdrawal.is_pending !== true ||
      withdrawal.is_approved !== false
    ) {
      throw new Error(
        "Withdrawal already processed"
      );
    }


    let paymentAccount = null;


    if (
      validId(
        withdrawal.payment_account_id
      )
    ) {

      const accountResult =
        await client.query(
          `
          SELECT *
          FROM payment_accounts
          WHERE id = $1
            AND payment_method_id = $2
            AND is_active = TRUE
            AND COALESCE(is_removed, FALSE) = FALSE
          LIMIT 1
          FOR UPDATE
          `,
          [
            withdrawal.payment_account_id,
            withdrawal.payment_method_id
          ]
        );


      if (
        accountResult.rows.length === 0
      ) {
        throw new Error(
          "Payment account unavailable"
        );
      }


      paymentAccount =
        accountResult.rows[0];


      if (
        Number(paymentAccount.balance) <
        Number(withdrawal.amount)
      ) {
        throw new Error(
          "Payment account has insufficient balance"
        );
      }
    }


    const userResult =
      await client.query(
        `
        SELECT *
        FROM users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [withdrawal.user_id]
      );


    if (userResult.rows.length === 0) {
      throw new Error(
        "User not found"
      );
    }


    if (paymentAccount) {

      await client.query(
        `
        UPDATE payment_accounts
        SET balance =
          COALESCE(balance, 0) - $1
        WHERE id = $2
        `,
        [
          withdrawal.amount,
          paymentAccount.id
        ]
      );
    }


    const updated =
      await client.query(
        `
        UPDATE withdrawals
        SET
          is_pending = FALSE,
          is_approved = TRUE,
          approved_by_id = $1,
          updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [
          adminId,
          withdrawalId
        ]
      );


    return updated.rows[0] || null;
  });
}


// ============================================================
// REJECT WITHDRAWAL
// ============================================================

async function rejectWithdrawal(
  withdrawalId,
  adminId,
  rejectReason = null
) {
  if (!validId(withdrawalId)) {
    throw new Error(
      "Invalid withdrawal ID"
    );
  }

  if (!validId(adminId)) {
    throw new Error(
      "Invalid admin ID"
    );
  }


  return transaction(async (client) => {

    const adminResult =
      await client.query(
        `
        SELECT id
        FROM users
        WHERE id = $1
          AND is_admin = TRUE
          AND is_active = TRUE
        LIMIT 1
        `,
        [adminId]
      );


    if (adminResult.rows.length === 0) {
      throw new Error(
        "Unauthorized admin"
      );
    }


    const withdrawalResult =
      await client.query(
        `
        SELECT *
        FROM withdrawals
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [withdrawalId]
      );


    if (
      withdrawalResult.rows.length === 0
    ) {
      throw new Error(
        "Withdrawal not found"
      );
    }


    const withdrawal =
      withdrawalResult.rows[0];


    if (
      withdrawal.is_pending !== true ||
      withdrawal.is_approved !== false
    ) {
      throw new Error(
        "Withdrawal already processed"
      );
    }


    // Refund the user.
    await client.query(
      `
      UPDATE users
      SET balance = balance + $1
      WHERE id = $2
      `,
      [
        withdrawal.amount,
        withdrawal.user_id
      ]
    );


    const updated =
      await client.query(
        `
        UPDATE withdrawals
        SET
          is_pending = FALSE,
          is_approved = FALSE,
          reject_reason = $1,
          updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [
          rejectReason || "Rejected by admin",
          withdrawalId
        ]
      );


    return updated.rows[0] || null;
  });
}


// ============================================================
// LEADERBOARD
// ============================================================

async function getLeaderboard(
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

  const result = await pool.query(
    `
    SELECT *
    FROM leaderboard
    LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows;
}


// ============================================================
// BROADCAST DRAFTS
// ============================================================

async function getBroadcastDraft(
  adminId
) {
  const result = await pool.query(
    `
    SELECT *
    FROM broadcast_drafts
    WHERE admin_id = $1
    LIMIT 1
    `,
    [adminId]
  );

  return result.rows[0] || null;
}


async function updateBroadcastImage(
  adminId,
  imageUrl
) {
  const result = await pool.query(
    `
    INSERT INTO broadcast_drafts (
      admin_id,
      image_url,
      created_at
    )
    VALUES (
      $1,
      $2,
      NOW()
    )
    ON CONFLICT (admin_id)
    DO UPDATE SET
      image_url = EXCLUDED.image_url

    RETURNING *
    `,
    [
      adminId,
      imageUrl
    ]
  );

  return result.rows[0] || null;
}


async function updateBroadcastMessage(
  adminId,
  message
) {
  const result = await pool.query(
    `
    INSERT INTO broadcast_drafts (
      admin_id,
      message,
      created_at
    )
    VALUES (
      $1,
      $2,
      NOW()
    )
    ON CONFLICT (admin_id)
    DO UPDATE SET
      message = EXCLUDED.message

    RETURNING *
    `,
    [
      adminId,
      message
    ]
  );

  return result.rows[0] || null;
}


async function deleteBroadcastDraft(
  adminId
) {
  const result = await pool.query(
    `
    DELETE FROM broadcast_drafts
    WHERE admin_id = $1
    RETURNING *
    `,
    [adminId]
  );

  return result.rows[0] || null;
}


async function getAllActiveUsers() {
  const result = await pool.query(
    `
    SELECT
      id,
      telegram_id,
      name,
      phone,
      balance
    FROM users
    WHERE is_active = TRUE
      AND COALESCE(is_banned, FALSE) = FALSE
      AND COALESCE(is_blocked, FALSE) = FALSE
    ORDER BY id ASC
    `
  );

  return result.rows;
}


// ============================================================
// GAME OPERATIONS
// ============================================================

async function createGame(
  roomId,
  stakeId,
  stakeAmount
) {
  if (
    !validPositiveAmount(stakeAmount)
  ) {
    throw new Error(
      "Invalid stake amount"
    );
  }

  const result = await pool.query(
    `
    INSERT INTO games (
      room_id,
      stake_id,
      stake_amount,
      pot,
      status,
      called_numbers,
      winner_ids,
      win_amount,
      is_split,
      started_at
    )
    VALUES (
      $1,
      $2,
      $3,
      0,
      'waiting',
      '[]'::jsonb,
      '[]'::jsonb,
      0,
      FALSE,
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

  return result.rows[0] || null;
}


async function addParticipant(
  gameId,
  userId,
  cardId
) {
  return transaction(async (client) => {

    const userResult =
      await client.query(
        `
        SELECT *
        FROM users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [userId]
      );


    if (userResult.rows.length === 0) {
      throw new Error(
        "User not found"
      );
    }


    const user =
      userResult.rows[0];


    const gameResult =
      await client.query(
        `
        SELECT *
        FROM games
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [gameId]
      );


    if (gameResult.rows.length === 0) {
      throw new Error(
        "Game not found"
      );
    }


    const game =
      gameResult.rows[0];


    const stake =
      Number(game.stake_amount);


    if (
      Number(user.balance) < stake
    ) {
      throw new Error(
        "Insufficient balance"
      );
    }


    await client.query(
      `
      UPDATE users
      SET balance = balance - $1,
          total_games =
            COALESCE(total_games, 0) + 1
      WHERE id = $2
      `,
      [
        stake,
        userId
      ]
    );


    const participant =
      await client.query(
        `
        INSERT INTO game_participants (
          game_id,
          user_id,
          card_id,
          is_winner,
          amount_won,
          is_disqualified
        )
        VALUES (
          $1,
          $2,
          $3,
          FALSE,
          0,
          FALSE
        )
        RETURNING *
        `,
        [
          gameId,
          userId,
          cardId
        ]
      );


    await client.query(
      `
      UPDATE games
      SET pot =
        COALESCE(pot, 0) + $1
      WHERE id = $2
      `,
      [
        stake,
        gameId
      ]
    );


    return participant.rows[0] || null;
  });
}


// ============================================================
// GAME POT
// ============================================================

async function updateGamePot(
  gameId,
  amount
) {
  const result = await pool.query(
    `
    UPDATE games
    SET pot = COALESCE(pot, 0) + $1
    WHERE id = $2
    RETURNING *
    `,
    [
      amount,
      gameId
    ]
  );

  return result.rows[0] || null;
}


// ============================================================
// CALLED NUMBERS
// ============================================================

async function updateCalledNumbers(
  gameId,
  calledNumbers
) {
  const result = await pool.query(
    `
    UPDATE games
    SET called_numbers = $1::jsonb
    WHERE id = $2
    RETURNING *
    `,
    [
      JSON.stringify(
        calledNumbers || []
      ),
      gameId
    ]
  );

  return result.rows[0] || null;
}


// ============================================================
// DISQUALIFY PARTICIPANT
// ============================================================

async function disqualifyParticipant(
  gameId,
  userId
) {
  const result = await pool.query(
    `
    UPDATE game_participants
    SET is_disqualified = TRUE
    WHERE game_id = $1
      AND user_id = $2
    RETURNING *
    `,
    [
      gameId,
      userId
    ]
  );

  return result.rows[0] || null;
}


// ============================================================
// ACTIVE GAME
// ============================================================

async function getActiveGame(
  roomId
) {
  const result = await pool.query(
    `
    SELECT *
    FROM games
    WHERE room_id = $1
      AND status IN (
        'waiting',
        'active',
        'started'
      )
    ORDER BY id DESC
    LIMIT 1
    `,
    [roomId]
  );

  return result.rows[0] || null;
}


// ============================================================
// END GAME
// ============================================================

async function endGame(
  gameId,
  winnerIds = [],
  winAmount = 0,
  isSplit = false
) {
  return transaction(async (client) => {

    const gameResult =
      await client.query(
        `
        SELECT *
        FROM games
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [gameId]
      );


    if (gameResult.rows.length === 0) {
      throw new Error(
        "Game not found"
      );
    }


    const game =
      gameResult.rows[0];


    const winners =
      Array.isArray(winnerIds)
        ? winnerIds
        : [];


    // --------------------------------------------------------
    // Mark winners
    // --------------------------------------------------------

    for (const winnerId of winners) {

      await client.query(
        `
        UPDATE game_participants
        SET
          is_winner = TRUE,
          amount_won = $1
        WHERE game_id = $2
          AND user_id = $3
        `,
        [
          Number(winAmount) || 0,
          gameId,
          winnerId
        ]
      );


      await client.query(
        `
        UPDATE users
        SET
          total_wins =
            COALESCE(total_wins, 0) + 1,

          total_winnings =
            COALESCE(total_winnings, 0) + $1,

          balance =
            balance + $1
        WHERE id = $2
        `,
        [
          Number(winAmount) || 0,
          winnerId
        ]
      );
    }


    const updated =
      await client.query(
        `
        UPDATE games
        SET
          status = 'completed',
          winner_ids = $1::jsonb,
          win_amount = $2,
          is_split = $3,
          ended_at = NOW()
        WHERE id = $4
        RETURNING *
        `,
        [
          JSON.stringify(winners),
          Number(winAmount) || 0,
          Boolean(isSplit),
          gameId
        ]
      );


    return updated.rows[0] || null;
  });
}


// ============================================================
// DEDUCT STAKE
// ============================================================

async function deductStake(
  userId,
  amount
) {
  if (!validPositiveAmount(amount)) {
    throw new Error(
      "Invalid stake amount"
    );
  }

  const result = await pool.query(
    `
    UPDATE users
    SET balance = balance - $1
    WHERE id = $2
      AND balance >= $1
      AND is_active = TRUE
      AND COALESCE(is_banned, FALSE) = FALSE
      AND COALESCE(is_blocked, FALSE) = FALSE
    RETURNING *
    `,
    [
      amount,
      userId
    ]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}


// ============================================================
// AWARD WIN
// ============================================================

async function awardWin(
  userId,
  amount
) {
  if (!validPositiveAmount(amount)) {
    throw new Error(
      "Invalid winning amount"
    );
  }

  const result = await pool.query(
    `
    UPDATE users
    SET
      balance = balance + $1,
      total_wins =
        COALESCE(total_wins, 0) + 1,
      total_winnings =
        COALESCE(total_winnings, 0) + $1
    WHERE id = $2
    RETURNING *
    `,
    [
      amount,
      userId
    ]
  );

  return result.rows[0] || null;
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

  // Connection
  pool,

  // Helpers
  normalizeEthiopianPhone,

  // Users
  registerUser,
  reconnectUserByPhone,
  getUserByTelegramId,
  getUserByTelegramIdIncludingInactive,
  getUserByPhone,
  getUserByPhoneForAdmin,
  deactivateUser,
  reactivateUserByTelegramId,
  setUserBlocked,

  // Admin
  isAdmin,
  getAdminByTelegramId,
  getAllAdmins,
  setUserAdminRole,
  removeUserAdminRole,

  // Statistics
  getUserStatistics,
  getUserFinancialStatistics,
  getAdminFinancialStatistics,
  getAdminStatistics,

  // Balance
  updateBalance,
  deductStake,
  awardWin,

  // Payment types
  getPaymentMethodTypes,

  // Payment methods
  getPaymentMethods,
  getPaymentMethodById,

  // Payment accounts
  getPaymentAccount,
  getPaymentAccountById,
  getPaymentAccountsByMethod,
  getAllPaymentAccounts,
  getAllPaymentAccountsForAdmin,
  createPaymentAccount,
  setPaymentAccountActive,
  activatePaymentAccount,
  deactivatePaymentAccount,
  removePaymentAccount,
  deletePaymentAccount,

  // Deposits
  approveDeposit,
  approveDepositttttttttttt,

  // Transfers
  transferBalance,

  // Withdrawals
  createWithdrawal,
  getPendingWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,

  // Leaderboard
  getLeaderboard,

  // Broadcast
  getBroadcastDraft,
  updateBroadcastImage,
  updateBroadcastMessage,
  deleteBroadcastDraft,
  getAllActiveUsers,

  // Games
  createGame,
  addParticipant,
  updateGamePot,
  updateCalledNumbers,
  disqualifyParticipant,
  getActiveGame,
  endGame
};
