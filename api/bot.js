/**
 * bot.js — Sisters Bingo Telegram Bot
 *
 * Install:
 *   npm install grammy
 *
 * Environment:
 *   BOT_TOKEN=your_telegram_bot_token
 *   GAME_URL=https://sisters-bingo.vercel.app
 */

const { Bot, webhookCallback } = require("grammy");

const db = require("../db");

const {
  processDeposit
} = require("../deposit");


// ============================================================
// CONFIG
// ============================================================

const BOT_TOKEN =
  process.env.BOT_TOKEN;

const GAME_URL =
  process.env.GAME_URL ||
  "https://sisters-bingo.vercel.app";


if (!BOT_TOKEN) {

  throw new Error(
    "BOT_TOKEN environment variable is missing"
  );

}


const bot =
  new Bot(BOT_TOKEN);


// ============================================================
// STATE
// ============================================================

const pendingPhone = {};

const pendingDeposit = {};

const pendingTransfer = {};

const pendingWithdrawal = {};

const pendingAdminWithdrawal  = {};

// Admin payment-account creation state
// telegramId -> {
//   step,
//   paymentMethodId,
//   paymentMethod,
//   paymentTypeName,
//   paymentTypeAmharicName,
//   accountName,
//   accountNumber
// }
const pendingAdminAccount = {};

const pendingDelete = {};

// Admin rejection state
// telegramId -> { withdrawalId, withdrawal }
const pendingAdminReject = {};

// Admin user search state
const pendingAdminUserSearch = new Map();

const pendingAdminRoleSearch = new Map();


// ============================================================
// CLEAR USER STATE
// ============================================================

function clearPendingState(
  telegramId
) {

  delete pendingDeposit[
    telegramId
  ];

  delete pendingTransfer[
    telegramId
  ];

  delete pendingWithdrawal[
    telegramId
  ];

  delete pendingAdminWithdrawal[
    telegramId
  ];

  delete pendingDelete[
    telegramId
  ];

  delete pendingAdminAccount[
    telegramId
  ];

  pendingAdminUserSearch.delete(
    telegramId
  );

  pendingAdminRoleSearch.delete(
    telegramId
  );
}


// ============================================================
// BLOCKED USER GUARD
// ============================================================

bot.use(
  async (ctx, next) => {

    try {

      if (!ctx.from) {
        return next();
      }

      const telegramId =
        ctx.from.id;

      const user =
        await db.getUserByTelegramId(
          telegramId
        );

      if (
        user &&
        user.is_blocked === true
      ) {

        await ctx.reply(
          "🚫 Your account has been blocked.\n\nPlease contact Support."
        );

        return;

      }

    } catch (error) {

      console.error(
        "Blocked user guard error:",
        error
      );

      return next();

    }

    return next();

  }
);


// ============================================================
// HELPERS
// ============================================================

function normalizeEthiopianPhone(
  phone
) {

  if (!phone) {
    return null;
  }

  let value =
    String(phone)
      .trim()
      .replace(/[\s\-()]/g, "");

  if (
    value.startsWith("+251")
  ) {

    value =
      value.substring(1);

  }

  if (
    value.startsWith("251")
  ) {

    const local =
      value.substring(3);

    if (
      local.startsWith("9") ||
      local.startsWith("7")
    ) {

      return "0" + local;

    }

  }

  if (
    /^09\d{8}$/.test(value) ||
    /^07\d{8}$/.test(value)
  ) {

    return value;

  }

  return null;

}


function normalizePaymentAccountNumber(
  accountNumber,
  paymentTypeName
) {

  if (!accountNumber) {
    return null;
  }

  let value =
    String(accountNumber)
      .trim()
      .replace(/[\s\-()]/g, "");

  const type =
    String(
      paymentTypeName || ""
    ).toLowerCase();

  if (
    type.includes("telebirr") ||
    type.includes("tele birr") ||
    type.includes("mobile")
  ) {

    const normalized =
      normalizeEthiopianPhone(
        value
      );

    return normalized || value;

  }

  return value;

}


function parseAmount(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return 0;

  }

  const cleaned =
    String(value)
      .replace(/,/g, "")
      .replace(/[^0-9.]/g, "");

  const amount =
    Number(cleaned);

  return Number.isFinite(amount)
    ? amount
    : 0;

}


function formatAmount(
  value
) {

  const amount =
    Number(value || 0);

  return amount.toLocaleString(
    "en-US",
    {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }
  );

}


function escapeMarkdown(
  value
) {

  return String(
    value || ""
  ).replace(
    /([_*[\]()~`>#+\-=|{}.!])/g,
    "\\$1"
  );

}


function getTelegramId(
  ctx
) {

  return ctx.from
    ? ctx.from.id
    : null;

}


async function answerCallback(
  ctx
) {

  try {

    if (
      ctx.callbackQuery
    ) {

      await ctx.answerCallbackQuery();

    }

  } catch (error) {

    console.error(
      "Callback answer error:",
      error
    );

  }

}


async function safeEditMessage(
  ctx,
  text,
  extra = {}
) {

  try {

    if (
      ctx.callbackQuery &&
      ctx.callbackQuery.message
    ) {

      await ctx.editMessageText(
        text,
        extra
      );

    } else {

      await ctx.reply(
        text,
        extra
      );

    }

  } catch (error) {

    console.error(
      "Message edit error:",
      error
    );

    try {

      await ctx.reply(
        text,
        extra
      );

    } catch (replyError) {

      console.error(
        "Fallback reply error:",
        replyError
      );

    }

  }

}


async function getCurrentUser(
  ctx,
  includeInactive = false
) {

  const telegramId =
    getTelegramId(ctx);

  if (!telegramId) {
    return null;
  }

  if (
    includeInactive &&
    typeof db.getUserByTelegramIdIncludingInactive ===
      "function"
  ) {

    return db.getUserByTelegramIdIncludingInactive(
      telegramId
    );

  }

  return db.getUserByTelegramId(
    telegramId
  );

}


// ============================================================
// ADMIN HELPERS
// ============================================================

async function getCurrentAdmin(
  ctx
) {

  const telegramId =
    getTelegramId(ctx);

  if (!telegramId) {
    return null;
  }

  try {

    if (
      typeof db.getAdminByTelegramId !==
      "function"
    ) {

      return null;

    }

    return await db.getAdminByTelegramId(
      telegramId
    );

  } catch (error) {

    console.error(
      "Get current admin error:",
      error
    );

    return null;

  }

}


async function requireAdmin(
  ctx
) {

  const admin =
    await getCurrentAdmin(ctx);

  if (!admin) {

    await ctx.reply(
      "🚫 You do not have administrator permission."
    );

    return null;

  }

  return admin;

}


async function requireAdminPermission(
  ctx,
  permission
) {

  const admin =
    await getCurrentAdmin(ctx);

  if (!admin) {

    await ctx.reply(
      "🚫 You do not have administrator permission."
    );

    return null;

  }

  const role =
    String(
      admin.admin_role || ""
    ).toLowerCase();

  if (
    role === "main"
  ) {

    return admin;

  }

  if (
    role === "broadcast" &&
    permission === "broadcast"
  ) {

    return admin;

  }

  if (
    role === "statistics" &&
    permission === "statistics"
  ) {

    return admin;

  }

  if (
    role === "withdrawal" &&
    permission === "withdrawals"
  ) {

    return admin;

  }

  await ctx.reply(
    "🚫 You do not have permission to perform this action."
  );

  return null;

}


// ============================================================
// USER HOME
// ============================================================

async function showBalance(
  ctx
) {

  const user =
    await getCurrentUser(ctx);

  if (!user) {

    await ctx.reply(
      "Please /start to register first."
    );

    return;

  }

  await safeEditMessage(
    ctx,
    `💰 *Your Balance*\n\n` +
    `💵 ${formatAmount(user.balance)} ETB`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🏠 Home",
              callback_data: "user_home"
            }
          ]
        ]
      }
    }
  );

}


async function showSupport(
  ctx
) {

  const user =
    await getCurrentUser(ctx);

  if (!user) {

    await ctx.reply(
      "Please /start to register first."
    );

    return;

  }

  await safeEditMessage(
    ctx,
    "🆘 *Support*\n\n" +
    "ማንኛውም ጥያቄ ወይም ችግር ካለዎት ከታች ባለው የSupport አካውንት ያግኙን።\n\n" +
    "👤 @sistersbingosupport",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🏠 Home",
              callback_data: "user_home"
            }
          ]
        ]
      }
    }
  );

}


// ============================================================
// DEPOSIT
// ============================================================

async function showDeposit(
  ctx
) {

  const user =
    await getCurrentUser(ctx);

  if (!user) {

    await ctx.reply(
      "Please /start to register first."
    );

    return;

  }

  try {

    const methods =
      await db.getPaymentMethods();

    if (
      !methods ||
      methods.length === 0
    ) {

      await safeEditMessage(
        ctx,
        "💎 *Deposit*\n\n" +
        "Deposit is currently unavailable.\n\n" +
        "Please contact Support.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🆘 Support",
                  callback_data: "support"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data: "user_home"
                }
              ]
            ]
          }
        }
      );

      return;

    }

    const rows =
      [];

    for (
      const method of methods
    ) {

      rows.push(
        [
          {
            text:
              `${method.name || method.payment_method_name || "Payment"} 💎`,
            callback_data:
              `deposit_method_${method.id}`
          }
        ]
      );

    }

    rows.push(
      [
        {
          text: "🏠 Home",
          callback_data: "user_home"
        }
      ]
    );

    await safeEditMessage(
      ctx,
      "💎 *Deposit*\n\n" +
      "እባክዎ የDeposit ዘዴ ይምረጡ።",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: rows
        }
      }
    );

  } catch (error) {

    console.error(
      "Show deposit error:",
      error
    );

    await ctx.reply(
      "❌ Unable to load deposit methods. Please try again later."
    );

  }

}


// ============================================================
// DEPOSIT METHOD SELECTION
// ============================================================

bot.callbackQuery(
  /^deposit_method_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const methodId =
      Number(
        ctx.match[1]
      );

    const user =
      await getCurrentUser(ctx);

    if (!user) {

      await ctx.reply(
        "Please /start to register first."
      );

      return;

    }

    try {

      const method =
        await db.getPaymentMethodById(
          methodId
        );

      if (!method) {

        await ctx.reply(
          "❌ Payment method not found."
        );

        return;

      }

      const types =
        await db.getPaymentMethodTypes(
          methodId
        );

      if (
        !types ||
        types.length === 0
      ) {

        await ctx.reply(
          "❌ No active payment accounts are available for this method."
        );

        return;

      }

      if (
        types.length === 1
      ) {

        const type =
          types[0];

        const account =
          await db.getPaymentAccount(
            methodId,
            type.id
          );

        if (!account) {

          await ctx.reply(
            "❌ No active payment account is currently available."
          );

          return;

        }

        pendingDeposit[
          getTelegramId(ctx)
        ] = {
          methodId,
          paymentMethod:
            method.name ||
            method.payment_method_name ||
            "Payment",
          paymentTypeId:
            type.id,
          paymentTypeName:
            type.name ||
            type.payment_type_name ||
            "",
          accountId:
            account.id,
          accountNumber:
            account.account_number
        };

        await safeEditMessage(
          ctx,
          "💎 *Deposit*\n\n" +
          `Payment method: *${escapeMarkdown(
            method.name ||
            method.payment_method_name ||
            "Payment"
          )}*\n\n` +
          `📱 Account: *${escapeMarkdown(
            account.account_number || ""
          )}*\n\n` +
          "Please send the payment to the account above, then paste the Telebirr SMS message here.",
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "❌ Cancel",
                    callback_data: "deposit_cancel"
                  }
                ]
              ]
            }
          }
        );

        return;

      }

      const rows =
        types.map(
          (type) => [
            {
              text:
                `${type.name || type.payment_type_name || "Account"} 💎`,
              callback_data:
                `deposit_type_${methodId}_${type.id}`
            }
          ]
        );

      rows.push(
        [
          {
            text: "⬅️ Back",
            callback_data: "deposit"
          }
        ]
      );

      await safeEditMessage(
        ctx,
        "💎 *Deposit*\n\n" +
        "እባክዎ የክፍያ አይነት ይምረጡ።",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: rows
          }
        }
      );

    } catch (error) {

      console.error(
        "Deposit method selection error:",
        error
      );

      await ctx.reply(
        "❌ Unable to load the selected payment method."
      );

    }

  }
);


// ============================================================
// DEPOSIT TYPE SELECTION
// ============================================================

bot.callbackQuery(
  /^deposit_type_(\d+)_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const methodId =
      Number(
        ctx.match[1]
      );

    const typeId =
      Number(
        ctx.match[2]
      );

    const user =
      await getCurrentUser(ctx);

    if (!user) {

      await ctx.reply(
        "Please /start to register first."
      );

      return;

    }

    try {

      const method =
        await db.getPaymentMethodById(
          methodId
        );

      const types =
        await db.getPaymentMethodTypes(
          methodId
        );

      const type =
        (types || []).find(
          item =>
            Number(item.id) ===
            typeId
        );

      if (!method || !type) {

        await ctx.reply(
          "❌ Payment option not found."
        );

        return;

      }

      const account =
        await db.getPaymentAccount(
          methodId,
          typeId
        );

      if (!account) {

        await safeEditMessage(
          ctx,
          "❌ No active payment account is currently available for this payment type.",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "⬅️ Back",
                    callback_data:
                      `deposit_method_${methodId}`
                  }
                ],
                [
                  {
                    text: "🏠 Home",
                    callback_data: "user_home"
                  }
                ]
              ]
            }
          }
        );

        return;

      }

      pendingDeposit[
        getTelegramId(ctx)
      ] = {
        methodId,
        paymentMethod:
          method.name ||
          method.payment_method_name ||
          "Payment",
        paymentTypeId:
          type.id,
        paymentTypeName:
          type.name ||
          type.payment_type_name ||
          "",
        accountId:
          account.id,
        accountNumber:
          account.account_number
      };

      await safeEditMessage(
        ctx,
        "💎 *Deposit*\n\n" +
        `Payment method: *${escapeMarkdown(
          method.name ||
          method.payment_method_name ||
          "Payment"
        )}*\n` +
        `Payment type: *${escapeMarkdown(
          type.name ||
          type.payment_type_name ||
          ""
        )}*\n\n` +
        `📱 Account: *${escapeMarkdown(
          account.account_number || ""
        )}*\n\n` +
        "Please send the payment to the account above, then paste the Telebirr SMS message here.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "❌ Cancel",
                  callback_data: "deposit_cancel"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Deposit type selection error:",
        error
      );

      await ctx.reply(
        "❌ Unable to process the selected payment type."
      );

    }

  }
);


// ============================================================
// DEPOSIT CANCEL
// ============================================================

bot.callbackQuery(
  "deposit_cancel",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      getTelegramId(ctx);

    delete pendingDeposit[
      telegramId
    ];

    await showHome(ctx);

  }
);


// ============================================================
// TELEBIRR DEPOSIT PROCESSING
// ============================================================

async function handleDepositText(
  ctx
) {

  const telegramId =
    getTelegramId(ctx);

  if (!telegramId) {
    return false;
  }

  const state =
    pendingDeposit[
      telegramId
    ];

  if (!state) {
    return false;
  }

  const text =
    ctx.message &&
    ctx.message.text
      ? ctx.message.text.trim()
      : "";

  if (!text) {
    return false;
  }

  try {

    await ctx.reply(
      "⏳ Verifying your payment. Please wait..."
    );

    const result =
      await processDeposit(
        {
          telegramId,
          text,
          paymentMethodId:
            state.methodId,
          paymentTypeId:
            state.paymentTypeId,
          paymentAccountId:
            state.accountId,
          paymentAccountNumber:
            state.accountNumber
        }
      );

    delete pendingDeposit[
      telegramId
    ];

    if (
      result &&
      result.success
    ) {

      const receipt =
        result.receipt || {};

      const dateText =
        receipt.paymentDate
          ? String(
              receipt.paymentDate
            ).split(" ")[0]
          : "";

      let payerLast4 =
        "";

      if (
        receipt.payerTelebirrNo
      ) {

        const digits =
          String(
            receipt.payerTelebirrNo
          ).replace(
            /\D/g,
            ""
          );

        if (
          digits.length >= 4
        ) {

          payerLast4 =
            digits.slice(-4);

        }

      }

      await ctx.reply(
        "✅ *Deposit Successful!*\n\n" +
        `💵 Amount: *${escapeMarkdown(
          receipt.settledAmount ||
          result.amount ||
          ""
        )}*\n` +
        `👤 Payer: *${escapeMarkdown(
          receipt.payerName ||
          result.depositorName ||
          ""
        )}*\n` +
        (
          payerLast4
            ? `📱 Telebirr: *••••${payerLast4}*\n`
            : ""
        ) +
        (
          dateText
            ? `📅 Date: *${escapeMarkdown(
                dateText
              )}*\n`
            : ""
        ) +
        (
          receipt.receiptNo
            ? `🧾 Receipt: *${escapeMarkdown(
                receipt.receiptNo
              )}*\n`
            : ""
        ) +
        "\nYour balance has been updated.",
        {
          parse_mode: "Markdown"
        }
      );

      return true;

    }

    await ctx.reply(
      "❌ *Deposit Verification Failed*\n\n" +
      `${escapeMarkdown(
        result &&
        result.message
          ? result.message
          : "The payment could not be verified."
      )}`,
      {
        parse_mode: "Markdown"
      }
    );

    return true;

  } catch (error) {

    console.error(
      "Deposit processing error:",
      error
    );

    delete pendingDeposit[
      telegramId
    ];

    await ctx.reply(
      "❌ An error occurred while verifying your deposit.\n\nPlease contact Support if the problem continues."
    );

    return true;

  }

}


// ============================================================
// TRANSFER
// ============================================================

async function showTransfer(
  ctx
) {

  const user =
    await getCurrentUser(ctx);

  if (!user) {

    await ctx.reply(
      "Please /start to register first."
    );

    return;

  }

  pendingTransfer[
    getTelegramId(ctx)
  ] = {
    step: "phone"
  };

  await safeEditMessage(
    ctx,
    "🔄 *Transfer*\n\n" +
    "ወደሚላኩለት ተጠቃሚ የተመዘገበ ስልክ ቁጥር ያስገቡ።",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "❌ Cancel",
              callback_data: "transfer_cancel"
            }
          ]
        ]
      }
    }
  );

}


bot.callbackQuery(
  "transfer_cancel",
  async (ctx) => {

    await answerCallback(ctx);

    delete pendingTransfer[
      getTelegramId(ctx)
    ];

    await showHome(ctx);

  }
);


// ============================================================
// WITHDRAWAL
// ============================================================

async function showWithdrawal(
  ctx
) {

  const user =
    await getCurrentUser(ctx);

  if (!user) {

    await ctx.reply(
      "Please /start to register first."
    );

    return;

  }

  pendingWithdrawal[
    getTelegramId(ctx)
  ] = {
    step: "amount"
  };

  await safeEditMessage(
    ctx,
    "🏧 *Withdraw*\n\n" +
    `Available balance: *${formatAmount(
      user.balance
    )} ETB*\n\n` +
    "የሚያወጡትን የገንዘብ መጠን ያስገቡ።",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "❌ Cancel",
              callback_data: "withdraw_cancel"
            }
          ]
        ]
      }
    }
  );

}


bot.callbackQuery(
  "withdraw_cancel",
  async (ctx) => {

    await answerCallback(ctx);

    delete pendingWithdrawal[
      getTelegramId(ctx)
    ];

    await showHome(ctx);

  }
);


// ============================================================
// USER STATISTICS
// IMPORTANT: These handlers must be registered OUTSIDE showHome()
// ============================================================

async function showUserStatistics(
  ctx
) {

  const user =
    await getCurrentUser(ctx);

  if (!user) {

    await ctx.reply(
      "Please /start to register first."
    );

    return;

  }

  try {

    const stats =
      await db.getUserStatistics(
        user.telegram_id
      );

    const financial =
      typeof db.getUserFinancialStatistics ===
      "function"
        ? await db.getUserFinancialStatistics(
            user.id
          )
        : null;

    const totalDeposits =
      Number(
        stats &&
        stats.totalDeposits || 0
      );

    const pendingWithdrawals =
      Number(
        stats &&
        stats.pendingWithdrawals || 0
      );

    const approvedWithdrawals =
      Number(
        stats &&
        stats.approvedWithdrawals || 0
      );

    const rejectedWithdrawals =
      Number(
        stats &&
        stats.rejectedWithdrawals || 0
      );

    const totalTransfers =
      Number(
        stats &&
        stats.totalTransfers || 0
      );

    const totalDepositAmount =
      Number(
        financial &&
        financial.totalDepositAmount || 0
      );

    const approvedWithdrawalAmount =
      Number(
        financial &&
        financial.approvedWithdrawalAmount || 0
      );

    const pendingWithdrawalAmount =
      Number(
        financial &&
        financial.pendingWithdrawalAmount || 0
      );

    const rejectedWithdrawalAmount =
      Number(
        financial &&
        financial.rejectedWithdrawalAmount || 0
      );

    await safeEditMessage(
      ctx,
      "📊 *My Statistics*\n\n" +
      `🎮 Total Games: *${Number(
        user.total_games || 0
      )}*\n` +
      `🏆 Total Wins: *${Number(
        user.total_wins || 0
      )}*\n` +
      `💰 Total Winnings: *${formatAmount(
        user.total_winnings || 0
      )} ETB*\n\n` +
      `💎 Deposits: *${totalDeposits}*\n` +
      `💵 Deposit Amount: *${formatAmount(
        totalDepositAmount
      )} ETB*\n\n` +
      `🏧 Pending Withdrawals: *${pendingWithdrawals}*\n` +
      `⏳ Pending Amount: *${formatAmount(
        pendingWithdrawalAmount
      )} ETB*\n` +
      `✅ Approved Withdrawals: *${approvedWithdrawals}*\n` +
      `💵 Approved Amount: *${formatAmount(
        approvedWithdrawalAmount
      )} ETB*\n` +
      `❌ Rejected Withdrawals: *${rejectedWithdrawals}*\n` +
      `💵 Rejected Amount: *${formatAmount(
        rejectedWithdrawalAmount
      )} ETB*\n\n` +
      `🔄 Transfers: *${totalTransfers}*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🏠 Home",
                callback_data: "user_home"
              }
            ]
          ]
        }
      }
    );

  } catch (error) {

    console.error(
      "User statistics error:",
      error
    );

    await ctx.reply(
      "❌ Unable to load your statistics."
    );

  }

}


bot.callbackQuery(
  "statistics",
  async (ctx) => {

    await answerCallback(ctx);

    await showUserStatistics(ctx);

  }
);


bot.callbackQuery(
  "user_home",
  async (ctx) => {

    await answerCallback(ctx);

    await showHome(ctx);

  }
);


bot.callbackQuery(
  "delete",
  async (ctx) => {

    await answerCallback(ctx);

    const user =
      await getCurrentUser(ctx);

    if (!user) {

      await ctx.reply(
        "Please /start to register first."
      );

      return;

    }

    pendingDelete[
      getTelegramId(ctx)
    ] = {
      step: "confirm"
    };

    await safeEditMessage(
      ctx,
      "⚠️ *Delete Account*\n\n" +
      "Are you sure you want to deactivate your Sisters Bingo account?\n\n" +
      "Your account and financial history will be retained securely, but you will no longer be able to use the account until it is reactivated.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⚠️ Yes, Delete",
                callback_data:
                  "delete_confirm"
              },
              {
                text: "❌ Cancel",
                callback_data:
                  "delete_cancel"
              }
            ]
          ]
        }
      }
    );

  }
);


bot.callbackQuery(
  "delete_cancel",
  async (ctx) => {

    await answerCallback(ctx);

    delete pendingDelete[
      getTelegramId(ctx)
    ];

    await showHome(ctx);

  }
);


bot.callbackQuery(
  "delete_confirm",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      getTelegramId(ctx);

    try {

      const user =
        await getCurrentUser(ctx);

      if (!user) {

        delete pendingDelete[
          telegramId
        ];

        await ctx.reply(
          "Your account could not be found."
        );

        return;

      }

      if (
        Number(user.balance || 0) >
        0
      ) {

        await ctx.reply(
          "❌ You cannot delete your account while your balance is greater than 0 ETB.\n\nPlease withdraw your remaining balance first."
        );

        return;

      }

      if (
        typeof db.deactivateUser !==
        "function"
      ) {

        await ctx.reply(
          "Account deletion is currently unavailable.\nPlease contact Support if you want to delete your account."
        );

        return;

      }

      await db.deactivateUser(
        telegramId
      );

      delete pendingDelete[
        telegramId
      ];

      await ctx.reply(
        "✅ Your account has been deactivated successfully.\n\nThank you for using Sisters Bingo."
      );

    } catch (error) {

      console.error(
        "Account deletion error:",
        error
      );

      await ctx.reply(
        "❌ Unable to delete your account right now.\n\nPlease contact Support."
      );

    }

  }
);


// ============================================================
// HOME
// ============================================================

async function showHome(
  ctx
) {

  try {

    const telegramId =
      getTelegramId(ctx);

    if (!telegramId) {
      return;
    }

    const user =
      await db.getUserByTelegramId(
        telegramId
      );

    if (!user) {

      await ctx.reply(
        "Please /start to register first."
      );

      return;

    }

    const admin =
      await getCurrentAdmin(ctx);

    const keyboard = [
      [
        {
          text: "🎮 Play Bingo",
          web_app: {
            url:
              `${GAME_URL}?tid=${telegramId}`
          }
        }
      ],
      [
        {
          text: "💰 Balance",
          callback_data: "balance"
        },
        {
          text: "💎 Deposit",
          callback_data: "deposit"
        }
      ],
      [
        {
          text: "🔄 Transfer",
          callback_data: "transfer"
        },
        {
          text: "🏧 Withdraw",
          callback_data: "withdraw"
        }
      ],
      [
        {
          text: "📊 Statistics",
          callback_data: "statistics"
        },
        {
          text: "📚 Instruction",
          callback_data: "instruction"
        }
      ],
      [
        {
          text: "🏆 Leaderboard",
          callback_data: "leaderboard"
        },
        {
          text: "🆘 Support",
          callback_data: "support"
        }
      ],
      [
        {
          text: "🗑️ Delete Account",
          callback_data: "delete"
        }
      ]
    ];

    if (admin) {

      const role =
        String(
          admin.admin_role || ""
        ).toLowerCase();

      if (
        role === "main"
      ) {

        keyboard.push(
          [
            {
              text: "👥 Manage Users",
              callback_data:
                "admin_manage_users"
            }
          ],
          [
            {
              text: "👤 Manage Admins",
              callback_data:
                "admin_manage_admins"
            }
          ],
          [
            {
              text: "🏧 Pending Withdrawals",
              callback_data:
                "admin_pending"
            }
          ],
          [
            {
              text: "📢 Broadcast",
              callback_data:
                "admin_broadcast"
            }
          ],
          [
            {
              text: "💳 Payment Accounts",
              callback_data:
                "admin_accounts"
            }
          ],
          [
            {
              text: "📊 Admin Statistics",
              callback_data:
                "admin_statistics_menu"
            }
          ]
        );

      } else if (
        role === "broadcast"
      ) {

        keyboard.push(
          [
            {
              text: "📢 Broadcast",
              callback_data:
                "admin_broadcast"
            }
          ]
        );

      } else if (
        role === "withdrawal"
      ) {

        keyboard.push(
          [
            {
              text: "🏧 Pending Withdrawals",
              callback_data:
                "admin_pending"
            }
          ]
        );

      } else if (
        role === "statistics"
      ) {

        keyboard.push(
          [
            {
              text: "📊 Admin Statistics",
              callback_data:
                "admin_statistics_menu"
            }
          ]
        );

      }

    }

    const caption =
      `🎱 *Welcome, ${escapeMarkdown(
        user.name || "Player"
      )}!*\n\n` +
      `💰 Balance: *${formatAmount(
        user.balance || 0
      )} ETB*\n\n` +
      "Choose an option below:";

    const extra = {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard:
          keyboard
      }
    };

    try {

      await ctx.replyWithPhoto(
        "https://sisters-bingo.vercel.app/MainLogo.png",
        {
          caption,
          ...extra
        }
      );

    } catch (photoError) {

      console.error(
        "Home photo error:",
        photoError
      );

      await ctx.reply(
        caption,
        extra
      );

    }

  } catch (error) {

    console.error(
      "User home button error:",
      error
    );

    await ctx.reply(
      "❌ Unable to load the home menu. Please try again."
    );

  }

}


// ============================================================
// /START
// ============================================================

bot.command(
  "start",
  async (ctx) => {

    const telegramId =
      getTelegramId(ctx);

    if (!telegramId) {
      return;
    }

    try {

      clearPendingState(
        telegramId
      );

      delete pendingPhone[
        telegramId
      ];

      const user =
        typeof db.getUserByTelegramIdIncludingInactive ===
        "function"
          ? await db.getUserByTelegramIdIncludingInactive(
              telegramId
            )
          : await db.getUserByTelegramId(
              telegramId
            );

      if (
        user &&
        user.is_blocked === true
      ) {

        await ctx.reply(
          "🚫 Your account has been blocked.\n\nPlease contact Support."
        );

        return;

      }

      if (
        user &&
        user.is_active === false
      ) {

        if (
          typeof db.reactivateUserByTelegramId ===
          "function"
        ) {

          await db.reactivateUserByTelegramId(
            telegramId
          );

          const reactivatedUser =
            await db.getUserByTelegramId(
              telegramId
            );

          if (reactivatedUser) {

            await ctx.reply(
              "✅ Welcome back! Your account has been reactivated."
            );

            await showHome(ctx);

            return;

          }

        }

      }

      if (user) {

        await showHome(ctx);

        return;

      }

      const firstName =
        ctx.from.first_name ||
        "Player";

      pendingPhone[
        telegramId
      ] = {
        name: firstName,
        step: "ask_name"
      };

      await ctx.reply(
        "🎱 *Welcome to Sisters Bingo!*\n\n" +
        "Let's create your account.\n\n" +
        "Please enter your full name:",
        {
          parse_mode: "Markdown"
        }
      );

    } catch (error) {

      console.error(
        "Start error:",
        error
      );

      await ctx.reply(
        "❌ Something went wrong while starting the bot. Please try again."
      );

    }

  }
);


// ============================================================
// /BALANCE
// ============================================================

bot.command(
  "balance",
  async (ctx) => {

    await showBalance(ctx);

  }
);


bot.hears(
  "balance",
  async (ctx) => {

    await showBalance(ctx);

  }
);


bot.hears(
  "💰 Balance",
  async (ctx) => {

    await showBalance(ctx);

  }
);


bot.callbackQuery(
  "balance",
  async (ctx) => {

    await answerCallback(ctx);

    await showBalance(ctx);

  }
);


// ============================================================
// /SUPPORT
// ============================================================

bot.command(
  "support",
  async (ctx) => {

    await showSupport(ctx);

  }
);


bot.hears(
  "support",
  async (ctx) => {

    await showSupport(ctx);

  }
);


bot.callbackQuery(
  "support",
  async (ctx) => {

    await answerCallback(ctx);

    await showSupport(ctx);

  }
);


// ============================================================
// /DEPOSIT
// ============================================================

bot.command(
  "deposit",
  async (ctx) => {

    await showDeposit(ctx);

  }
);


bot.hears(
  "deposit",
  async (ctx) => {

    await showDeposit(ctx);

  }
);


bot.callbackQuery(
  "deposit",
  async (ctx) => {

    await answerCallback(ctx);

    await showDeposit(ctx);

  }
);


// ============================================================
// /TRANSFER
// ============================================================

bot.command(
  "transfer",
  async (ctx) => {

    await showTransfer(ctx);

  }
);


bot.hears(
  "transfer",
  async (ctx) => {

    await showTransfer(ctx);

  }
);


bot.callbackQuery(
  "transfer",
  async (ctx) => {

    await answerCallback(ctx);

    await showTransfer(ctx);

  }
);


// ============================================================
// /WITHDRAW
// ============================================================

bot.command(
  "withdraw",
  async (ctx) => {

    await showWithdrawal(ctx);

  }
);


bot.hears(
  "withdraw",
  async (ctx) => {

    await showWithdrawal(ctx);

  }
);


bot.callbackQuery(
  "withdraw",
  async (ctx) => {

    await answerCallback(ctx);

    await showWithdrawal(ctx);

  }
);


// ============================================================
// REGISTRATION — CONTACT
// ============================================================

bot.on(
  "message:contact",
  async (ctx) => {

    const telegramId =
      getTelegramId(ctx);

    if (!telegramId) {
      return;
    }

    const state =
      pendingPhone[
        telegramId
      ];

    if (!state) {
      return;
    }

    try {

      const contact =
        ctx.message.contact;

      const phone =
        normalizeEthiopianPhone(
          contact.phone_number
        );

      if (!phone) {

        await ctx.reply(
          "❌ Please provide a valid Ethiopian phone number."
        );

        return;

      }

      const name =
        state.name ||
        contact.first_name ||
        ctx.from.first_name ||
        "Player";

      const existing =
        typeof db.getUserByPhoneForAdmin ===
        "function"
          ? await db.getUserByPhoneForAdmin(
              phone
            )
          : null;

      if (
        existing &&
        Number(existing.telegram_id) !==
        Number(telegramId)
      ) {

        await ctx.reply(
          "❌ This phone number is already registered to another account."
        );

        return;

      }

      const registered =
        await db.registerUser(
          telegramId,
          name,
          phone
        );

      delete pendingPhone[
        telegramId
      ];

      await ctx.reply(
        "✅ *Registration successful!*\n\n" +
        `Welcome, *${escapeMarkdown(
          registered.name ||
          name
        )}*!`,
        {
          parse_mode: "Markdown"
        }
      );

      await showHome(ctx);

    } catch (error) {

      console.error(
        "Registration contact error:",
        error
      );

      await ctx.reply(
        "❌ Unable to complete registration. Please try again."
      );

    }

  }
);


// ============================================================
// REGISTRATION — TEXT
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const telegramId =
      getTelegramId(ctx);

    if (!telegramId) {
      return next();
    }

    const state =
      pendingPhone[
        telegramId
      ];

    if (!state) {
      return next();
    }

    const text =
      ctx.message.text.trim();

    if (
      !text
    ) {

      await ctx.reply(
        "Please enter your name."
      );

      return;

    }

    if (
      state.step === "ask_name"
    ) {

      state.name =
        text;

      state.step =
        "ask_phone";

      await ctx.reply(
        "📱 Please share your Ethiopian phone number using the button below.",
        {
          reply_markup: {
            keyboard: [
              [
                {
                  text: "📱 Share Phone Number",
                  request_contact: true
                }
              ]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );

      return;

    }

    return next();

  }
);


// ============================================================
// DEPOSIT TEXT MESSAGES
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const handled =
      await handleDepositText(ctx);

    if (handled) {
      return;
    }

    return next();

  }
);


// ============================================================
// TRANSFER TEXT FLOW
// ============================================================

async function handleTransferText(
  ctx
) {

  const telegramId =
    getTelegramId(ctx);

  const state =
    pendingTransfer[
      telegramId
    ];

  if (!state) {
    return false;
  }

  const text =
    ctx.message.text.trim();

  if (
    state.step === "phone"
  ) {

    const phone =
      normalizeEthiopianPhone(
        text
      );

    if (!phone) {

      await ctx.reply(
        "❌ Please enter a valid Ethiopian phone number."
      );

      return true;

    }

    const recipient =
      await db.getUserByPhone(
        phone
      );

    if (!recipient) {

      await ctx.reply(
        "❌ No active user was found with that phone number."
      );

      return true;

    }

    if (
      Number(recipient.id) ===
      Number(
        (await getCurrentUser(ctx)).id
      )
    ) {

      await ctx.reply(
        "❌ You cannot transfer money to yourself."
      );

      return true;

    }

    state.recipient =
      recipient;

    state.step =
      "amount";

    await ctx.reply(
      `👤 Recipient: *${escapeMarkdown(
        recipient.name || "User"
      )}*\n\n` +
      "💵 Enter the amount you want to transfer:",
      {
        parse_mode: "Markdown"
      }
    );

    return true;

  }

  if (
    state.step === "amount"
  ) {

    const amount =
      parseAmount(text);

    if (
      amount <= 0
    ) {

      await ctx.reply(
        "❌ Please enter a valid amount."
      );

      return true;

    }

    const user =
      await getCurrentUser(ctx);

    if (!user) {

      delete pendingTransfer[
        telegramId
      ];

      await ctx.reply(
        "Please /start to register first."
      );

      return true;

    }

    if (
      amount >
      Number(user.balance || 0)
    ) {

      await ctx.reply(
        "❌ Insufficient balance."
      );

      return true;

    }

    state.amount =
      amount;

    state.step =
      "confirm";

    await ctx.reply(
      "🔄 *Confirm Transfer*\n\n" +
      `👤 To: *${escapeMarkdown(
        state.recipient.name || ""
      )}*\n` +
      `📱 Phone: *${escapeMarkdown(
        state.recipient.phone || ""
      )}*\n` +
      `💵 Amount: *${formatAmount(
        amount
      )} ETB*\n\n` +
      "Do you want to continue?",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Confirm",
                callback_data:
                  "transfer_confirm"
              },
              {
                text: "❌ Cancel",
                callback_data:
                  "transfer_cancel"
              }
            ]
          ]
        }
      }
    );

    return true;

  }

  return true;

}


bot.on(
  "message:text",
  async (ctx, next) => {

    const handled =
      await handleTransferText(ctx);

    if (handled) {
      return;
    }

    return next();

  }
);


// ============================================================
// CONFIRM TRANSFER
// ============================================================

bot.callbackQuery(
  "transfer_confirm",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      getTelegramId(ctx);

    const state =
      pendingTransfer[
        telegramId
      ];

    if (!state) {

      await ctx.reply(
        "❌ Transfer session expired. Please start again."
      );

      return;

    }

    try {

      const sender =
        await getCurrentUser(ctx);

      if (!sender) {

        delete pendingTransfer[
          telegramId
        ];

        await ctx.reply(
          "Please /start to register first."
        );

        return;

      }

      if (
        !state.recipient ||
        !state.amount
      ) {

        delete pendingTransfer[
          telegramId
        ];

        await ctx.reply(
          "❌ Transfer information is incomplete."
        );

        return;

      }

      const result =
        await db.createTransfer(
          sender.id,
          state.recipient.id,
          state.amount
        );

      delete pendingTransfer[
        telegramId
      ];

      await safeEditMessage(
        ctx,
        "✅ *Transfer Successful!*\n\n" +
        `👤 Recipient: *${escapeMarkdown(
          state.recipient.name || ""
        )}*\n` +
        `💵 Amount: *${formatAmount(
          state.amount
        )} ETB*\n\n` +
        `💰 New Balance: *${formatAmount(
          result &&
          result.senderBalance !== undefined
            ? result.senderBalance
            : (
                Number(sender.balance || 0) -
                Number(state.amount)
              )
        )} ETB*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🏠 Home",
                  callback_data: "user_home"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Transfer confirmation error:",
        error
      );

      await ctx.reply(
        "❌ Transfer failed. Please try again later."
      );

    }

  }
);


// ============================================================
// WITHDRAWAL TEXT FLOW
// ============================================================

async function handleWithdrawalText(
  ctx
) {

  const telegramId =
    getTelegramId(ctx);

  const state =
    pendingWithdrawal[
      telegramId
    ];

  if (!state) {
    return false;
  }

  const text =
    ctx.message.text.trim();

  if (
    state.step === "amount"
  ) {

    const amount =
      parseAmount(text);

    if (
      amount <= 0
    ) {

      await ctx.reply(
        "❌ Please enter a valid withdrawal amount."
      );

      return true;

    }

    const user =
      await getCurrentUser(ctx);

    if (!user) {

      delete pendingWithdrawal[
        telegramId
      ];

      await ctx.reply(
        "Please /start to register first."
      );

      return true;

    }

    if (
      amount >
      Number(user.balance || 0)
    ) {

      await ctx.reply(
        "❌ Insufficient balance."
      );

      return true;

    }

    state.amount =
      amount;

    state.step =
      "account";

    await ctx.reply(
      `💵 Withdrawal amount: *${formatAmount(
        amount
      )} ETB*\n\n` +
      "📱 Enter your payment account number:",
      {
        parse_mode: "Markdown"
      }
    );

    return true;

  }

  if (
    state.step === "account"
  ) {

    const accountNumber =
      normalizeEthiopianPhone(
        text
      ) || text;

    if (
      !accountNumber
    ) {

      await ctx.reply(
        "❌ Please enter a valid payment account number."
      );

      return true;

    }

    state.accountNumber =
      accountNumber;

    state.step =
      "confirm";

    await ctx.reply(
      "🏧 *Confirm Withdrawal*\n\n" +
      `💵 Amount: *${formatAmount(
        state.amount
      )} ETB*\n` +
      `📱 Account: *${escapeMarkdown(
        state.accountNumber
      )}*\n\n` +
      "Do you want to submit this withdrawal request?",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Submit",
                callback_data:
                  "withdraw_confirm"
              },
              {
                text: "❌ Cancel",
                callback_data:
                  "withdraw_cancel"
              }
            ]
          ]
        }
      }
    );

    return true;

  }

  return true;

}


bot.on(
  "message:text",
  async (ctx, next) => {

    const handled =
      await handleWithdrawalText(ctx);

    if (handled) {
      return;
    }

    return next();

  }
);


// ============================================================
// CONFIRM WITHDRAWAL
// ============================================================

bot.callbackQuery(
  "withdraw_confirm",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      getTelegramId(ctx);

    const state =
      pendingWithdrawal[
        telegramId
      ];

    if (!state) {

      await ctx.reply(
        "❌ Withdrawal session expired. Please start again."
      );

      return;

    }

    try {

      const user =
        await getCurrentUser(ctx);

      if (!user) {

        delete pendingWithdrawal[
          telegramId
        ];

        await ctx.reply(
          "Please /start to register first."
        );

        return;

      }

      if (
        Number(state.amount) <= 0 ||
        Number(state.amount) >
          Number(user.balance || 0)
      ) {

        await ctx.reply(
          "❌ Invalid withdrawal amount or insufficient balance."
        );

        return;

      }

      if (
        typeof db.createWithdrawal !==
        "function"
      ) {

        await ctx.reply(
          "❌ Withdrawal service is currently unavailable."
        );

        return;

      }

      const withdrawal =
        await db.createWithdrawal(
          user.id,
          state.amount,
          state.accountNumber
        );

      delete pendingWithdrawal[
        telegramId
      ];

      await safeEditMessage(
        ctx,
        "✅ *Withdrawal Request Submitted*\n\n" +
        `💵 Amount: *${formatAmount(
          state.amount
        )} ETB*\n` +
        `📱 Account: *${escapeMarkdown(
          state.accountNumber
        )}*\n\n` +
        "Your withdrawal request is now pending admin approval.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "user_home"
                }
              ]
            ]
          }
        }
      );

      console.log(
        "Withdrawal created:",
        withdrawal
      );

    } catch (error) {

      console.error(
        "Withdrawal confirmation error:",
        error
      );

      await ctx.reply(
        "❌ Unable to submit your withdrawal request. Please try again later."
      );

    }

  }
);
// ============================================================
// INSTRUCTION
// ============================================================

async function showInstruction(
  ctx
) {

  const text =
    "📚 *How to Play Sisters Bingo*\n\n" +
    "1️⃣ Register your account and add your phone number.\n\n" +
    "2️⃣ Deposit money into your Sisters Bingo account.\n\n" +
    "3️⃣ Tap *🎮 Play Bingo* to open the Bingo game.\n\n" +
    "4️⃣ Select the game you want to join.\n\n" +
    "5️⃣ Your balance will be used to purchase your Bingo ticket.\n\n" +
    "6️⃣ Numbers will be called during the game.\n\n" +
    "7️⃣ Match the called numbers on your ticket.\n\n" +
    "8️⃣ Complete the required Bingo pattern to win.\n\n" +
    "9️⃣ Winners receive the applicable prize according to the game rules.\n\n" +
    "💡 *Important:* Make sure your account has sufficient balance before joining a game.";

  await safeEditMessage(
    ctx,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🏠 Home",
              callback_data: "user_home"
            }
          ]
        ]
      }
    }
  );

}


bot.command(
  "instruction",
  async (ctx) => {

    await showInstruction(ctx);

  }
);


bot.hears(
  "instruction",
  async (ctx) => {

    await showInstruction(ctx);

  }
);


bot.callbackQuery(
  "instruction",
  async (ctx) => {

    await answerCallback(ctx);

    await showInstruction(ctx);

  }
);


// ============================================================
// LEADERBOARD
// ============================================================

async function showLeaderboard(
  ctx
) {

  try {

    const leaderboard =
      await db.getLeaderboard(10);

    if (
      !leaderboard ||
      leaderboard.length === 0
    ) {

      await safeEditMessage(
        ctx,
        "🏆 *Leaderboard*\n\n" +
        "No leaderboard data is available yet.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🏠 Home",
                  callback_data: "user_home"
                }
              ]
            ]
          }
        }
      );

      return;

    }

    let message =
      "🏆 *Sisters Bingo Leaderboard*\n\n";

    leaderboard.forEach(
      (player, index) => {

        const position =
          index + 1;

        let medal =
          "";

        if (
          position === 1
        ) {

          medal = "🥇";

        } else if (
          position === 2
        ) {

          medal = "🥈";

        } else if (
          position === 3
        ) {

          medal = "🥉";

        } else {

          medal = `${position}.`;

        }

        message +=
          `${medal} *${escapeMarkdown(
            player.name ||
            "Player"
          )}* — ` +
          `${formatAmount(
            player.total_winnings ||
            player.winnings ||
            0
          )} ETB\n`;

      }
    );

    await safeEditMessage(
      ctx,
      message,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🏠 Home",
                callback_data: "user_home"
              }
            ]
          ]
        }
      }
    );

  } catch (error) {

    console.error(
      "Leaderboard error:",
      error
    );

    await ctx.reply(
      "❌ Unable to load the leaderboard."
    );

  }

}


bot.command(
  "leaderboard",
  async (ctx) => {

    await showLeaderboard(ctx);

  }
);


bot.callbackQuery(
  "leaderboard",
  async (ctx) => {

    await answerCallback(ctx);

    await showLeaderboard(ctx);

  }
);


// ============================================================
// ADMIN — MAIN MENU
// ============================================================

async function showAdminMenu(
  ctx
) {

  const admin =
    await requireAdmin(ctx);

  if (!admin) {
    return;
  }

  const role =
    String(
      admin.admin_role || ""
    ).toLowerCase();

  const rows = [];

  if (
    role === "main"
  ) {

    rows.push(
      [
        {
          text: "👥 Manage Users",
          callback_data:
            "admin_manage_users"
        }
      ],
      [
        {
          text: "👤 Manage Admins",
          callback_data:
            "admin_manage_admins"
        }
      ],
      [
        {
          text: "🏧 Pending Withdrawals",
          callback_data:
            "admin_pending"
        }
      ],
      [
        {
          text: "📢 Broadcast",
          callback_data:
            "admin_broadcast"
        }
      ],
      [
        {
          text: "💳 Payment Accounts",
          callback_data:
            "admin_accounts"
        }
      ],
      [
        {
          text: "📊 Statistics",
          callback_data:
            "admin_statistics_menu"
        }
      ]
    );

  } else if (
    role === "statistics"
  ) {

    rows.push(
      [
        {
          text: "📊 Statistics",
          callback_data:
            "admin_statistics_menu"
        }
      ]
    );

  } else if (
    role === "withdrawal"
  ) {

    rows.push(
      [
        {
          text: "🏧 Pending Withdrawals",
          callback_data:
            "admin_pending"
        }
      ]
    );

  } else if (
    role === "broadcast"
  ) {

    rows.push(
      [
        {
          text: "📢 Broadcast",
          callback_data:
            "admin_broadcast"
        }
      ]
    );

  }

  rows.push(
    [
      {
        text: "🏠 User Home",
        callback_data:
          "user_home"
      }
    ]
  );

  await safeEditMessage(
    ctx,
    "🔐 *Admin Panel*\n\n" +
    `👤 Admin: *${escapeMarkdown(
      admin.name ||
      "Administrator"
    )}*\n` +
    `🛡️ Role: *${escapeMarkdown(
      role || "admin"
    )}*`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard:
          rows
      }
    }
  );

}


bot.callbackQuery(
  "admin_menu",
  async (ctx) => {

    await answerCallback(ctx);

    await showAdminMenu(ctx);

  }
);


// ============================================================
// ADMIN — MANAGE USERS
// ============================================================

async function showAdminManageUsers(
  ctx
) {

  const admin =
    await requireAdminPermission(
      ctx,
      "main"
    );

  if (!admin) {
    return;
  }

  pendingAdminUserSearch.set(
    getTelegramId(ctx),
    {
      step: "phone"
    }
  );

  await safeEditMessage(
    ctx,
    "👥 *Manage Users*\n\n" +
    "Please enter the user's registered phone number.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "❌ Cancel",
              callback_data:
                "admin_cancel"
            }
          ]
        ]
      }
    }
  );

}


bot.callbackQuery(
  "admin_manage_users",
  async (ctx) => {

    await answerCallback(ctx);

    await showAdminManageUsers(ctx);

  }
);


// ============================================================
// ADMIN USER SEARCH
// ============================================================

async function handleAdminUserSearch(
  ctx
) {

  const telegramId =
    getTelegramId(ctx);

  const state =
    pendingAdminUserSearch.get(
      telegramId
    );

  if (!state) {
    return false;
  }

  const admin =
    await getCurrentAdmin(ctx);

  if (!admin) {

    pendingAdminUserSearch.delete(
      telegramId
    );

    await ctx.reply(
      "🚫 You do not have administrator permission."
    );

    return true;

  }

  const text =
    ctx.message.text.trim();

  if (
    !text
  ) {

    await ctx.reply(
      "Please enter a phone number."
    );

    return true;

  }

  try {

    const phone =
      normalizeEthiopianPhone(
        text
      );

    if (!phone) {

      await ctx.reply(
        "❌ Please enter a valid Ethiopian phone number."
      );

      return true;

    }

    const user =
      await db.getUserByPhoneForAdmin(
        phone
      );

    if (!user) {

      await ctx.reply(
        "❌ No active user was found with that phone number."
      );

      return true;

    }

    pendingAdminUserSearch.set(
      telegramId,
      {
        step: "view",
        user
      }
    );

    const status =
      user.is_blocked === true
        ? "🚫 Blocked"
        : user.is_active === false
          ? "⛔ Inactive"
          : "✅ Active";

    const adminStatus =
      user.is_admin === true
        ? `\n🛡️ Admin Role: *${escapeMarkdown(
            user.admin_role ||
            "admin"
          )}*`
        : "";

    await ctx.reply(
      "👤 *User Information*\n\n" +
      `🆔 ID: *${user.id}*\n` +
      `👤 Name: *${escapeMarkdown(
        user.name || ""
      )}*\n` +
      `📱 Phone: *${escapeMarkdown(
        user.phone || ""
      )}*\n` +
      `💰 Balance: *${formatAmount(
        user.balance || 0
      )} ETB*\n` +
      `🎮 Games: *${Number(
        user.total_games || 0
      )}*\n` +
      `🏆 Wins: *${Number(
        user.total_wins || 0
      )}*\n` +
      `💵 Winnings: *${formatAmount(
        user.total_winnings || 0
      )} ETB*\n` +
      `📌 Status: *${status}*` +
      adminStatus,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  user.is_blocked === true
                    ? "🔓 Unblock User"
                    : "🚫 Block User",
                callback_data:
                  `admin_user_block_${user.id}`
              }
            ],
            [
              {
                text: "📊 Financial Statistics",
                callback_data:
                  `admin_user_financial_${user.id}`
              }
            ],
            [
              {
                text: "⬅️ Search Another User",
                callback_data:
                  "admin_manage_users"
              }
            ],
            [
              {
                text: "🏠 Admin Menu",
                callback_data:
                  "admin_menu"
              }
            ]
          ]
        }
      }
    );

    return true;

  } catch (error) {

    console.error(
      "Admin user search error:",
      error
    );

    await ctx.reply(
      "❌ Unable to search for this user."
    );

    return true;

  }

}


bot.on(
  "message:text",
  async (ctx, next) => {

    const handled =
      await handleAdminUserSearch(ctx);

    if (handled) {
      return;
    }

    return next();

  }
);


// ============================================================
// ADMIN USER BLOCK / UNBLOCK
// ============================================================

bot.callbackQuery(
  /^admin_user_block_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    const userId =
      Number(
        ctx.match[1]
      );

    try {

      if (
        typeof db.getUserById !==
        "function"
      ) {

        await ctx.reply(
          "❌ User lookup function is unavailable."
        );

        return;

      }

      const user =
        await db.getUserById(
          userId
        );

      if (!user) {

        await ctx.reply(
          "❌ User not found."
        );

        return;

      }

      const newBlocked =
        user.is_blocked !== true;

      await db.setUserBlocked(
        userId,
        newBlocked
      );

      pendingAdminUserSearch.set(
        getTelegramId(ctx),
        {
          step: "view",
          user: {
            ...user,
            is_blocked:
              newBlocked
          }
        }
      );

      await safeEditMessage(
        ctx,
        newBlocked
          ? "🚫 *User Blocked*\n\n" +
            `👤 ${escapeMarkdown(
              user.name || "User"
            )} has been blocked successfully.`
          : "🔓 *User Unblocked*\n\n" +
            `👤 ${escapeMarkdown(
              user.name || "User"
            )} has been unblocked successfully.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⬅️ Back to User",
                  callback_data:
                    "admin_manage_users"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Admin block/unblock error:",
        error
      );

      await ctx.reply(
        "❌ Unable to change the user's block status."
      );

    }

  }
);


// ============================================================
// ADMIN USER FINANCIAL STATISTICS
// ============================================================

bot.callbackQuery(
  /^admin_user_financial_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    const userId =
      Number(
        ctx.match[1]
      );

    try {

      const user =
        typeof db.getUserById ===
        "function"
          ? await db.getUserById(
              userId
            )
          : null;

      if (!user) {

        await ctx.reply(
          "❌ User not found."
        );

        return;

      }

      if (
        typeof db.getUserFinancialStatistics !==
        "function"
      ) {

        await ctx.reply(
          "❌ Financial statistics are currently unavailable."
        );

        return;

      }

      const stats =
        await db.getUserFinancialStatistics(
          userId
        );

      await safeEditMessage(
        ctx,
        "📊 *User Financial Statistics*\n\n" +
        `👤 User: *${escapeMarkdown(
          user.name || "User"
        )}*\n` +
        `📱 Phone: *${escapeMarkdown(
          user.phone || ""
        )}*\n\n` +
        `💎 Total Deposits: *${formatAmount(
          stats.totalDepositAmount || 0
        )} ETB*\n` +
        `✅ Approved Withdrawals: *${formatAmount(
          stats.approvedWithdrawalAmount || 0
        )} ETB*\n` +
        `⏳ Pending Withdrawals: *${formatAmount(
          stats.pendingWithdrawalAmount || 0
        )} ETB*\n` +
        `❌ Rejected Withdrawals: *${formatAmount(
          stats.rejectedWithdrawalAmount || 0
        )} ETB*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⬅️ Back",
                  callback_data:
                    "admin_manage_users"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Admin user financial statistics error:",
        error
      );

      await ctx.reply(
        "❌ Unable to load financial statistics."
      );

    }

  }
);


// ============================================================
// ADMIN — MANAGE ADMINS
// ============================================================

async function showManageAdmins(
  ctx
) {

  const admin =
    await requireAdminPermission(
      ctx,
      "main"
    );

  if (!admin) {
    return;
  }

  try {

    const admins =
      await db.getAllAdmins();

    let text =
      "👤 *Manage Admins*\n\n";

    if (
      !admins ||
      admins.length === 0
    ) {

      text +=
        "No administrators found.";

    } else {

      admins.forEach(
        (item, index) => {

          text +=
            `${index + 1}. *${escapeMarkdown(
              item.name || "Admin"
            )}*\n` +
            `📱 ${escapeMarkdown(
              item.phone || ""
            )}\n` +
            `🛡️ Role: *${escapeMarkdown(
              item.admin_role || ""
            )}*\n\n`;

        }
      );

    }

    await safeEditMessage(
      ctx,
      text,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Add / Change Admin Role",
                callback_data:
                  "admin_role_add"
              }
            ],
            [
              {
                text: "➖ Remove Admin Role",
                callback_data:
                  "admin_role_remove"
              }
            ],
            [
              {
                text: "🏠 Admin Menu",
                callback_data:
                  "admin_menu"
              }
            ]
          ]
        }
      }
    );

  } catch (error) {

    console.error(
      "Manage admins error:",
      error
    );

    await ctx.reply(
      "❌ Unable to load administrators."
    );

  }

}


bot.callbackQuery(
  "admin_manage_admins",
  async (ctx) => {

    await answerCallback(ctx);

    await showManageAdmins(ctx);

  }
);


// ============================================================
// ADMIN ROLE SEARCH
// ============================================================

bot.callbackQuery(
  "admin_role_add",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    pendingAdminRoleSearch.set(
      getTelegramId(ctx),
      {
        action: "add",
        step: "phone"
      }
    );

    await safeEditMessage(
      ctx,
      "➕ *Add / Change Admin Role*\n\n" +
      "Enter the user's registered phone number.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel",
                callback_data:
                  "admin_manage_admins"
              }
            ]
          ]
        }
      }
    );

  }
);


bot.callbackQuery(
  "admin_role_remove",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    pendingAdminRoleSearch.set(
      getTelegramId(ctx),
      {
        action: "remove",
        step: "phone"
      }
    );

    await safeEditMessage(
      ctx,
      "➖ *Remove Admin Role*\n\n" +
      "Enter the administrator's registered phone number.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel",
                callback_data:
                  "admin_manage_admins"
              }
            ]
          ]
        }
      }
    );

  }
);


// ============================================================
// ADMIN ROLE TEXT SEARCH
// ============================================================

async function handleAdminRoleSearch(
  ctx
) {

  const telegramId =
    getTelegramId(ctx);

  const state =
    pendingAdminRoleSearch.get(
      telegramId
    );

  if (!state) {
    return false;
  }

  const admin =
    await getCurrentAdmin(ctx);

  if (!admin) {

    pendingAdminRoleSearch.delete(
      telegramId
    );

    await ctx.reply(
      "🚫 You do not have administrator permission."
    );

    return true;

  }

  const text =
    ctx.message.text.trim();

  const phone =
    normalizeEthiopianPhone(
      text
    );

  if (!phone) {

    await ctx.reply(
      "❌ Please enter a valid Ethiopian phone number."
    );

    return true;

  }

  try {

    const user =
      await db.getUserByPhoneForAdmin(
        phone
      );

    if (!user) {

      await ctx.reply(
        "❌ No active user was found with that phone number."
      );

      return true;

    }

    if (
      state.action === "add"
    ) {

      pendingAdminRoleSearch.set(
        telegramId,
        {
          action: "add",
          step: "role",
          user
        }
      );

      await ctx.reply(
        "🛡️ *Select Admin Role*\n\n" +
        `👤 User: *${escapeMarkdown(
          user.name || "User"
        )}*\n` +
        `📱 Phone: *${escapeMarkdown(
          user.phone || ""
        )}*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "👑 Main",
                  callback_data:
                    `admin_set_role_main_${user.id}`
                }
              ],
              [
                {
                  text: "📊 Statistics",
                  callback_data:
                    `admin_set_role_statistics_${user.id}`
                }
              ],
              [
                {
                  text: "🏧 Withdrawal",
                  callback_data:
                    `admin_set_role_withdrawal_${user.id}`
                }
              ],
              [
                {
                  text: "📢 Broadcast",
                  callback_data:
                    `admin_set_role_broadcast_${user.id}`
                }
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    "admin_manage_admins"
                }
              ]
            ]
          }
        }
      );

      return true;

    }

    if (
      state.action === "remove"
    ) {

      await db.removeAdminUser(
        user.id
      );

      pendingAdminRoleSearch.delete(
        telegramId
      );

      await ctx.reply(
        `✅ Admin role removed from *${escapeMarkdown(
          user.name || "User"
        )}*.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "👤 Manage Admins",
                  callback_data:
                    "admin_manage_admins"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

      return true;

    }

    return true;

  } catch (error) {

    console.error(
      "Admin role search error:",
      error
    );

    await ctx.reply(
      "❌ Unable to process administrator role request."
    );

    return true;

  }

}


bot.on(
  "message:text",
  async (ctx, next) => {

    const handled =
      await handleAdminRoleSearch(ctx);

    if (handled) {
      return;
    }

    return next();

  }
);


// ============================================================
// SET ADMIN ROLE
// ============================================================

bot.callbackQuery(
  /^admin_set_role_(main|statistics|withdrawal|broadcast)_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    const role =
      ctx.match[1];

    const userId =
      Number(
        ctx.match[2]
      );

    try {

      if (
        ![
          "main",
          "statistics",
          "withdrawal",
          "broadcast"
        ].includes(role)
      ) {

        await ctx.reply(
          "❌ Invalid admin role."
        );

        return;

      }

      const user =
        typeof db.getUserById ===
        "function"
          ? await db.getUserById(
              userId
            )
          : null;

      if (!user) {

        await ctx.reply(
          "❌ User not found."
        );

        return;

      }

      await db.setUserAdminRole(
        userId,
        role
      );

      pendingAdminRoleSearch.delete(
        getTelegramId(ctx)
      );

      await safeEditMessage(
        ctx,
        "✅ *Admin Role Updated*\n\n" +
        `👤 User: *${escapeMarkdown(
          user.name || "User"
        )}*\n` +
        `📱 Phone: *${escapeMarkdown(
          user.phone || ""
        )}*\n` +
        `🛡️ Role: *${escapeMarkdown(
          role
        )}*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "👤 Manage Admins",
                  callback_data:
                    "admin_manage_admins"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Set admin role error:",
        error
      );

      await ctx.reply(
        "❌ Unable to update administrator role."
      );

    }

  }
);


// ============================================================
// ADMIN — PENDING WITHDRAWALS
// ============================================================

async function showPendingWithdrawals(
  ctx
) {

  const admin =
    await requireAdminPermission(
      ctx,
      "withdrawals"
    );

  if (!admin) {
    return;
  }

  try {

    if (
      typeof db.getPendingWithdrawals !==
      "function"
    ) {

      await ctx.reply(
        "❌ Pending withdrawal function is unavailable."
      );

      return;

    }

    const withdrawals =
      await db.getPendingWithdrawals();

    if (
      !withdrawals ||
      withdrawals.length === 0
    ) {

      await safeEditMessage(
        ctx,
        "🏧 *Pending Withdrawals*\n\n" +
        "✅ There are no pending withdrawal requests.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

      return;

    }

    const rows =
      [];

    withdrawals.forEach(
      (withdrawal) => {

        rows.push(
          [
            {
              text:
                `🏧 ${formatAmount(
                  withdrawal.amount || 0
                )} ETB — ${
                  withdrawal.name ||
                  withdrawal.user_name ||
                  "User"
                }`,
              callback_data:
                `admin_withdrawal_${withdrawal.id}`
            }
          ]
        );

      }
    );

    rows.push(
      [
        {
          text: "🏠 Admin Menu",
          callback_data:
            "admin_menu"
        }
      ]
    );

    await safeEditMessage(
      ctx,
      "🏧 *Pending Withdrawals*\n\n" +
      "Select a withdrawal request to review:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard:
            rows
        }
      }
    );

  } catch (error) {

    console.error(
      "Pending withdrawals error:",
      error
    );

    await ctx.reply(
      "❌ Unable to load pending withdrawals."
    );

  }

}


bot.callbackQuery(
  "admin_pending",
  async (ctx) => {

    await answerCallback(ctx);

    await showPendingWithdrawals(ctx);

  }
);


// ============================================================
// ADMIN WITHDRAWAL DETAILS
// ============================================================

bot.callbackQuery(
  /^admin_withdrawal_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "withdrawals"
      );

    if (!admin) {
      return;
    }

    const withdrawalId =
      Number(
        ctx.match[1]
      );

    try {

      if (
        typeof db.getWithdrawalById !==
        "function"
      ) {

        await ctx.reply(
          "❌ Withdrawal lookup function is unavailable."
        );

        return;

      }

      const withdrawal =
        await db.getWithdrawalById(
          withdrawalId
        );

      if (!withdrawal) {

        await ctx.reply(
          "❌ Withdrawal request not found."
        );

        return;

      }

      pendingAdminWithdrawal[
        getTelegramId(ctx)
      ] = {
        withdrawalId,
        withdrawal
      };

      await safeEditMessage(
        ctx,
        "🏧 *Withdrawal Request*\n\n" +
        `👤 User: *${escapeMarkdown(
          withdrawal.name ||
          withdrawal.user_name ||
          "User"
        )}*\n` +
        `📱 Phone: *${escapeMarkdown(
          withdrawal.phone ||
          ""
        )}*\n` +
        `💵 Amount: *${formatAmount(
          withdrawal.amount || 0
        )} ETB*\n` +
        `🏦 Account: *${escapeMarkdown(
          withdrawal.account_number ||
          withdrawal.payment_account ||
          ""
        )}*\n` +
        `📅 Date: *${escapeMarkdown(
          withdrawal.created_at
            ? new Date(
                withdrawal.created_at
              ).toISOString().split("T")[0]
            : ""
        )}*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Approve",
                  callback_data:
                    `admin_approve_withdrawal_${withdrawalId}`
                }
              ],
              [
                {
                  text: "❌ Reject",
                  callback_data:
                    `admin_reject_withdrawal_${withdrawalId}`
                }
              ],
              [
                {
                  text: "⬅️ Back",
                  callback_data:
                    "admin_pending"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Withdrawal details error:",
        error
      );

      await ctx.reply(
        "❌ Unable to load withdrawal details."
      );

    }

  }
);


// ============================================================
// ADMIN APPROVE WITHDRAWAL
// ============================================================

bot.callbackQuery(
  /^admin_approve_withdrawal_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "withdrawals"
      );

    if (!admin) {
      return;
    }

    const withdrawalId =
      Number(
        ctx.match[1]
      );

    try {

      if (
        typeof db.approveWithdrawal !==
        "function"
      ) {

        await ctx.reply(
          "❌ Withdrawal approval function is unavailable."
        );

        return;

      }

      const result =
        await db.approveWithdrawal(
          withdrawalId,
          admin.id
        );

      const withdrawal =
        result &&
        result.withdrawal
          ? result.withdrawal
          : result;

      delete pendingAdminWithdrawal[
        getTelegramId(ctx)
      ];

      await safeEditMessage(
        ctx,
        "✅ *Withdrawal Approved*\n\n" +
        `💵 Amount: *${formatAmount(
          withdrawal &&
          withdrawal.amount
            ? withdrawal.amount
            : 0
        )} ETB*\n\n` +
        "The withdrawal has been approved successfully.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🏧 Pending Withdrawals",
                  callback_data:
                    "admin_pending"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Approve withdrawal error:",
        error
      );

      await ctx.reply(
        "❌ Unable to approve this withdrawal.\n\n" +
        (
          error &&
          error.message
            ? error.message
            : ""
        )
      );

    }

  }
);


// ============================================================
// ADMIN REJECT WITHDRAWAL
// ============================================================

bot.callbackQuery(
  /^admin_reject_withdrawal_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "withdrawals"
      );

    if (!admin) {
      return;
    }

    const withdrawalId =
      Number(
        ctx.match[1]
      );

    pendingAdminReject.set(
      getTelegramId(ctx),
      {
        withdrawalId
      }
    );

    await safeEditMessage(
      ctx,
      "❌ *Reject Withdrawal*\n\n" +
      "Please enter the reason for rejecting this withdrawal.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⬅️ Cancel",
                callback_data:
                  `admin_withdrawal_${withdrawalId}`
              }
            ]
          ]
        }
      }
    );

  }
);


// ============================================================
// ADMIN REJECTION TEXT
// ============================================================

async function handleAdminRejectText(
  ctx
) {

  const telegramId =
    getTelegramId(ctx);

  const state =
    pendingAdminReject.get(
      telegramId
    );

  if (!state) {
    return false;
  }

  const admin =
    await getCurrentAdmin(ctx);

  if (!admin) {

    pendingAdminReject.delete(
      telegramId
    );

    await ctx.reply(
      "🚫 You do not have administrator permission."
    );

    return true;

  }

  const reason =
    ctx.message.text.trim();

  if (
    !reason
  ) {

    await ctx.reply(
      "Please enter a rejection reason."
    );

    return true;

  }

  try {

    if (
      typeof db.rejectWithdrawal !==
      "function"
    ) {

      await ctx.reply(
        "❌ Withdrawal rejection function is unavailable."
      );

      return true;

    }

    const result =
      await db.rejectWithdrawal(
        state.withdrawalId,
        admin.id,
        reason
      );

    pendingAdminReject.delete(
      telegramId
    );

    delete pendingAdminWithdrawal[
      telegramId
    ];

    await ctx.reply(
      "❌ *Withdrawal Rejected*\n\n" +
      `📝 Reason: *${escapeMarkdown(
        reason
      )}*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🏧 Pending Withdrawals",
                callback_data:
                  "admin_pending"
              }
            ],
            [
              {
                text: "🏠 Admin Menu",
                callback_data:
                  "admin_menu"
              }
            ]
          ]
        }
      }
    );

    console.log(
      "Withdrawal rejected:",
      result
    );

    return true;

  } catch (error) {

    console.error(
      "Reject withdrawal error:",
      error
    );

    await ctx.reply(
      "❌ Unable to reject this withdrawal.\n\n" +
      (
        error &&
        error.message
          ? error.message
          : ""
      )
    );

    return true;

  }

}


bot.on(
  "message:text",
  async (ctx, next) => {

    const handled =
      await handleAdminRejectText(ctx);

    if (handled) {
      return;
    }

    return next();

  }
);


// ============================================================
// ADMIN — PAYMENT ACCOUNTS
// ============================================================

async function showAdminAccounts(
  ctx
) {

  const admin =
    await requireAdminPermission(
      ctx,
      "main"
    );

  if (!admin) {
    return;
  }

  try {

    const methods =
      await db.getPaymentMethods();

    if (
      !methods ||
      methods.length === 0
    ) {

      await safeEditMessage(
        ctx,
        "💳 *Payment Accounts*\n\n" +
        "No active payment methods found.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

      return;

    }

    const rows =
      [];

    methods.forEach(
      (method) => {

        rows.push(
          [
            {
              text:
                `💳 ${method.name || method.payment_method_name || "Payment Method"}`,
              callback_data:
                `admin_accounts_method_${method.id}`
            }
          ]
        );

      }
    );

    rows.push(
      [
        {
          text: "🏠 Admin Menu",
          callback_data:
            "admin_menu"
        }
      ]
    );

    await safeEditMessage(
      ctx,
      "💳 *Payment Accounts*\n\n" +
      "Select a payment method to manage its accounts.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard:
            rows
        }
      }
    );

  } catch (error) {

    console.error(
      "Admin accounts error:",
      error
    );

    await ctx.reply(
      "❌ Unable to load payment accounts."
    );

  }

}


bot.callbackQuery(
  "admin_accounts",
  async (ctx) => {

    await answerCallback(ctx);

    await showAdminAccounts(ctx);

  }
);


// ============================================================
// ADMIN PAYMENT METHOD ACCOUNTS
// ============================================================

bot.callbackQuery(
  /^admin_accounts_method_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    const methodId =
      Number(
        ctx.match[1]
      );

    try {

      const method =
        await db.getPaymentMethodById(
          methodId
        );

      if (!method) {

        await ctx.reply(
          "❌ Payment method not found."
        );

        return;

      }

      const types =
        await db.getPaymentMethodTypes(
          methodId
        );

      let text =
        `💳 *${escapeMarkdown(
          method.name ||
          method.payment_method_name ||
          "Payment Method"
        )} Accounts*\n\n`;

      const rows =
        [];

      if (
        types &&
        types.length
      ) {

        for (
          const type of types
        ) {

          let account = null;

          try {

            account =
              await db.getPaymentAccount(
                methodId,
                type.id,
                true
              );

          } catch (accountError) {

            console.error(
              "Get payment account error:",
              accountError
            );

          }

          text +=
            `📱 *${escapeMarkdown(
              type.name ||
              type.payment_type_name ||
              "Account"
            )}*\n`;

          if (account) {

            const active =
              account.is_active !== false &&
              account.is_removed !== true;

            text +=
              `• ${escapeMarkdown(
                account.account_name ||
                ""
              )}\n` +
              `• ${escapeMarkdown(
                account.account_number ||
                ""
              )}\n` +
              `• ${active ? "🟢 Active" : "🔴 Inactive"}\n\n`;

            rows.push(
              [
                {
                  text:
                    `⚙️ ${type.name || type.payment_type_name || "Account"}`,
                  callback_data:
                    `admin_account_manage_${account.id}`
                }
              ]
            );

          } else {

            text +=
              "• No active account\n\n";

            rows.push(
              [
                {
                  text:
                    `➕ Add ${type.name || type.payment_type_name || "Account"}`,
                  callback_data:
                    `admin_account_add_${methodId}_${type.id}`
                }
              ]
            );

          }

        }

      }

      rows.push(
        [
          {
            text: "⬅️ Payment Methods",
            callback_data:
              "admin_accounts"
          }
        ],
        [
          {
            text: "🏠 Admin Menu",
            callback_data:
              "admin_menu"
          }
        ]
      );

      await safeEditMessage(
        ctx,
        text,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard:
              rows
          }
        }
      );

    } catch (error) {

      console.error(
        "Admin payment method accounts error:",
        error
      );

      await ctx.reply(
        "❌ Unable to load payment accounts."
      );

    }

  }
);


// ============================================================
// ADMIN ADD PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  /^admin_account_add_(\d+)_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    const methodId =
      Number(
        ctx.match[1]
      );

    const typeId =
      Number(
        ctx.match[2]
      );

    try {

      const method =
        await db.getPaymentMethodById(
          methodId
        );

      const types =
        await db.getPaymentMethodTypes(
          methodId
        );

      const type =
        (types || []).find(
          item =>
            Number(item.id) ===
            typeId
        );

      if (!method || !type) {

        await ctx.reply(
          "❌ Payment type not found."
        );

        return;

      }

      pendingAdminAccount[
        getTelegramId(ctx)
      ] = {
        step: "account_name",
        paymentMethodId:
          methodId,
        paymentMethod:
          method.name ||
          method.payment_method_name ||
          "",
        paymentTypeId:
          typeId,
        paymentTypeName:
          type.name ||
          type.payment_type_name ||
          ""
      };

      await safeEditMessage(
        ctx,
        "➕ *Add Payment Account*\n\n" +
        `💳 Method: *${escapeMarkdown(
          method.name ||
          method.payment_method_name ||
          ""
        )}*\n` +
        `📱 Type: *${escapeMarkdown(
          type.name ||
          type.payment_type_name ||
          ""
        )}*\n\n` +
        "Enter the account holder name:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    `admin_accounts_method_${methodId}`
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Admin add account error:",
        error
      );

      await ctx.reply(
        "❌ Unable to start payment account creation."
      );

    }

  }
);


// ============================================================
// ADMIN PAYMENT ACCOUNT TEXT FLOW
// ============================================================

async function handleAdminAccountText(
  ctx
) {

  const telegramId =
    getTelegramId(ctx);

  const state =
    pendingAdminAccount[
      telegramId
    ];

  if (!state) {
    return false;
  }

  const admin =
    await getCurrentAdmin(ctx);

  if (!admin) {

    delete pendingAdminAccount[
      telegramId
    ];

    await ctx.reply(
      "🚫 You do not have administrator permission."
    );

    return true;

  }

  const text =
    ctx.message.text.trim();

  if (
    !text
  ) {

    await ctx.reply(
      "Please enter a valid value."
    );

    return true;

  }

  try {

    if (
      state.step === "account_name"
    ) {

      state.accountName =
        text;

      state.step =
        "account_number";

      await ctx.reply(
        "📱 Enter the payment account number:"
      );

      return true;

    }

    if (
      state.step === "account_number"
    ) {

      const accountNumber =
        normalizePaymentAccountNumber(
          text,
          state.paymentTypeName
        );

      if (!accountNumber) {

        await ctx.reply(
          "❌ Please enter a valid account number."
        );

        return true;

      }

      state.accountNumber =
        accountNumber;

      state.step =
        "confirm";

      await ctx.reply(
        "➕ *Confirm Payment Account*\n\n" +
        `💳 Method: *${escapeMarkdown(
          state.paymentMethod
        )}*\n` +
        `📱 Type: *${escapeMarkdown(
          state.paymentTypeName
        )}*\n` +
        `👤 Name: *${escapeMarkdown(
          state.accountName
        )}*\n` +
        `📞 Account: *${escapeMarkdown(
          state.accountNumber
        )}*\n\n` +
        "Add this account?",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Add Account",
                  callback_data:
                    "admin_account_confirm_add"
                },
                {
                  text: "❌ Cancel",
                  callback_data:
                    `admin_accounts_method_${state.paymentMethodId}`
                }
              ]
            ]
          }
        }
      );

      return true;

    }

    return true;

  } catch (error) {

    console.error(
      "Admin payment account text error:",
      error
    );

    await ctx.reply(
      "❌ Unable to process payment account information."
    );

    return true;

  }

}


bot.on(
  "message:text",
  async (ctx, next) => {

    const handled =
      await handleAdminAccountText(ctx);

    if (handled) {
      return;
    }

    return next();

  }
);


// ============================================================
// ADMIN CONFIRM PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  "admin_account_confirm_add",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    const telegramId =
      getTelegramId(ctx);

    const state =
      pendingAdminAccount[
        telegramId
      ];

    if (!state) {

      await ctx.reply(
        "❌ Payment account creation session expired."
      );

      return;

    }

    try {

      if (
        typeof db.createPaymentAccount !==
        "function"
      ) {

        await ctx.reply(
          "❌ Payment account creation function is unavailable."
        );

        return;

      }

      const account =
        await db.createPaymentAccount(
          state.paymentMethodId,
          state.paymentTypeId,
          state.accountName,
          state.accountNumber,
          admin.id
        );

      delete pendingAdminAccount[
        telegramId
      ];

      await safeEditMessage(
        ctx,
        "✅ *Payment Account Added*\n\n" +
        `💳 Method: *${escapeMarkdown(
          state.paymentMethod
        )}*\n` +
        `📱 Type: *${escapeMarkdown(
          state.paymentTypeName
        )}*\n` +
        `👤 Name: *${escapeMarkdown(
          state.accountName
        )}*\n` +
        `📞 Account: *${escapeMarkdown(
          state.accountNumber
        )}*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "💳 Payment Accounts",
                  callback_data:
                    "admin_accounts"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

      console.log(
        "Payment account created:",
        account
      );

    } catch (error) {

      console.error(
        "Create payment account error:",
        error
      );

      await ctx.reply(
        "❌ Unable to add the payment account.\n\n" +
        (
          error &&
          error.message
            ? error.message
            : ""
        )
      );

    }

  }
);


// ============================================================
// ADMIN PAYMENT ACCOUNT MANAGEMENT
// ============================================================

bot.callbackQuery(
  /^admin_account_manage_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    const accountId =
      Number(
        ctx.match[1]
      );

    try {

      if (
        typeof db.getPaymentAccountById !==
        "function"
      ) {

        await ctx.reply(
          "❌ Payment account lookup function is unavailable."
        );

        return;

      }

      const account =
        await db.getPaymentAccountById(
          accountId
        );

      if (!account) {

        await ctx.reply(
          "❌ Payment account not found."
        );

        return;

      }

      const active =
        account.is_active !== false &&
        account.is_removed !== true;

      await safeEditMessage(
        ctx,
        "💳 *Payment Account*\n\n" +
        `💳 Method: *${escapeMarkdown(
          account.payment_method_name ||
          account.method_name ||
          ""
        )}*\n` +
        `📱 Type: *${escapeMarkdown(
          account.payment_type_name ||
          account.type_name ||
          ""
        )}*\n` +
        `👤 Name: *${escapeMarkdown(
          account.account_name ||
          ""
        )}*\n` +
        `📞 Account: *${escapeMarkdown(
          account.account_number ||
          ""
        )}*\n` +
        `📌 Status: *${
          active
            ? "🟢 Active"
            : "🔴 Inactive"
        }*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    active
                      ? "🔴 Deactivate"
                      : "🟢 Activate",
                  callback_data:
                    `admin_account_toggle_${accountId}`
                }
              ],
              [
                {
                  text: "🗑️ Remove Account",
                  callback_data:
                    `admin_account_remove_${accountId}`
                }
              ],
              [
                {
                  text: "💳 Payment Accounts",
                  callback_data:
                    "admin_accounts"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Payment account management error:",
        error
      );

      await ctx.reply(
        "❌ Unable to load payment account."
      );

    }

  }
);


// ============================================================
// ADMIN TOGGLE PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  /^admin_account_toggle_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    const accountId =
      Number(
        ctx.match[1]
      );

    try {

      if (
        typeof db.togglePaymentAccount !==
        "function"
      ) {

        await ctx.reply(
          "❌ Payment account toggle function is unavailable."
        );

        return;

      }

      const account =
        await db.getPaymentAccountById(
          accountId
        );

      if (!account) {

        await ctx.reply(
          "❌ Payment account not found."
        );

        return;

      }

      const newStatus =
        account.is_active !== true;

      await db.togglePaymentAccount(
        accountId,
        newStatus
      );

      await safeEditMessage(
        ctx,
        newStatus
          ? "🟢 *Payment Account Activated*"
          : "🔴 *Payment Account Deactivated*",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "💳 Payment Accounts",
                  callback_data:
                    "admin_accounts"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Toggle payment account error:",
        error
      );

      await ctx.reply(
        "❌ Unable to change payment account status."
      );

    }

  }
);


// ============================================================
// ADMIN REMOVE PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  /^admin_account_remove_(\d+)$/,
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "main"
      );

    if (!admin) {
      return;
    }

    const accountId =
      Number(
        ctx.match[1]
      );

    try {

      if (
        typeof db.removePaymentAccount !==
        "function"
      ) {

        await ctx.reply(
          "❌ Payment account removal function is unavailable."
        );

        return;

      }

      await db.removePaymentAccount(
        accountId,
        admin.id
      );

      await safeEditMessage(
        ctx,
        "🗑️ *Payment Account Removed*\n\n" +
        "The payment account has been removed successfully.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "💳 Payment Accounts",
                  callback_data:
                    "admin_accounts"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Remove payment account error:",
        error
      );

      await ctx.reply(
        "❌ Unable to remove payment account."
      );

    }

  }
);


// ============================================================
// ADMIN STATISTICS MENU
// ============================================================

async function showAdminStatisticsMenu(
  ctx
) {

  const admin =
    await requireAdminPermission(
      ctx,
      "statistics"
    );

  if (!admin) {
    return;
  }

  await safeEditMessage(
    ctx,
    "📊 *Admin Statistics*\n\n" +
    "Select the statistics you want to view.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📊 Overall Statistics",
              callback_data:
                "admin_statistics"
            }
          ],
          [
            {
              text: "💰 Financial Statistics",
              callback_data:
                "admin_financial_statistics"
            }
          ],
          [
            {
              text: "🏠 Admin Menu",
              callback_data:
                "admin_menu"
            }
          ]
        ]
      }
    }
  );

}


bot.callbackQuery(
  "admin_statistics_menu",
  async (ctx) => {

    await answerCallback(ctx);

    await showAdminStatisticsMenu(ctx);

  }
);


// ============================================================
// ADMIN OVERALL STATISTICS
// ============================================================

bot.callbackQuery(
  "admin_statistics",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "statistics"
      );

    if (!admin) {
      return;
    }

    try {

      if (
        typeof db.getAdminStatistics !==
        "function"
      ) {

        await ctx.reply(
          "❌ Admin statistics function is unavailable."
        );

        return;

      }

      const stats =
        await db.getAdminStatistics();

      await safeEditMessage(
        ctx,
        "📊 *Overall Statistics*\n\n" +
        `👥 Total Users: *${Number(
          stats.totalUsers || 0
        )}*\n` +
        `🟢 Active Users: *${Number(
          stats.activeUsers || 0
        )}*\n` +
        `🚫 Blocked Users: *${Number(
          stats.blockedUsers || 0
        )}*\n` +
        `👑 Admins: *${Number(
          stats.totalAdmins || 0
        )}*\n\n` +
        `🎮 Total Games: *${Number(
          stats.totalGames || 0
        )}*\n` +
        `🏆 Total Wins: *${Number(
          stats.totalWins || 0
        )}*\n` +
        `💰 Total Winnings: *${formatAmount(
          stats.totalWinnings || 0
        )} ETB*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⬅️ Back",
                  callback_data:
                    "admin_statistics_menu"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Admin statistics error:",
        error
      );

      await ctx.reply(
        "❌ Unable to load admin statistics."
      );

    }

  }
);


// ============================================================
// ADMIN FINANCIAL STATISTICS
// ============================================================

bot.callbackQuery(
  "admin_financial_statistics",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "statistics"
      );

    if (!admin) {
      return;
    }

    try {

      if (
        typeof db.getAdminFinancialStatistics !==
        "function"
      ) {

        await ctx.reply(
          "❌ Admin financial statistics function is unavailable."
        );

        return;

      }

      const stats =
        await db.getAdminFinancialStatistics();

      await safeEditMessage(
        ctx,
        "💰 *Financial Statistics*\n\n" +
        `💎 Total Deposits: *${formatAmount(
          stats.totalDepositAmount || 0
        )} ETB*\n\n` +
        `🏧 Approved Withdrawals: *${formatAmount(
          stats.approvedWithdrawalAmount || 0
        )} ETB*\n` +
        `⏳ Pending Withdrawals: *${formatAmount(
          stats.pendingWithdrawalAmount || 0
        )} ETB*\n` +
        `❌ Rejected Withdrawals: *${formatAmount(
          stats.rejectedWithdrawalAmount || 0
        )} ETB*\n\n` +
        `🔄 Total Transfers: *${formatAmount(
          stats.totalTransferAmount || 0
        )} ETB*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⬅️ Back",
                  callback_data:
                    "admin_statistics_menu"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Admin financial statistics error:",
        error
      );

      await ctx.reply(
        "❌ Unable to load financial statistics."
      );

    }

  }
);


// ============================================================
// ADMIN — BROADCAST
// ============================================================

async function showBroadcastMenu(
  ctx
) {

  const admin =
    await requireAdminPermission(
      ctx,
      "broadcast"
    );

  if (!admin) {
    return;
  }

  try {

    let draft =
      null;

    if (
      typeof db.getBroadcastDraft ===
      "function"
    ) {

      draft =
        await db.getBroadcastDraft(
          admin.id
        );

    }

    const imageStatus =
      draft &&
      draft.image_url
        ? "🖼️ Image: Added"
        : "🖼️ Image: None";

    const messageStatus =
      draft &&
      draft.message
        ? "📝 Message: Added"
        : "📝 Message: None";

    await safeEditMessage(
      ctx,
      "📢 *Broadcast*\n\n" +
      `${imageStatus}\n` +
      `${messageStatus}\n\n` +
      "Create a broadcast to send a message to all active users.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🖼️ Add / Change Image",
                callback_data:
                  "broadcast_image"
              }
            ],
            [
              {
                text: "📝 Add / Change Message",
                callback_data:
                  "broadcast_message"
              }
            ],
            [
              {
                text: "👁️ Preview",
                callback_data:
                  "broadcast_preview"
              }
            ],
            [
              {
                text: "📤 Send Broadcast",
                callback_data:
                  "broadcast_send"
              }
            ],
            [
              {
                text: "🗑️ Clear Draft",
                callback_data:
                  "broadcast_clear"
              }
            ],
            [
              {
                text: "🏠 Admin Menu",
                callback_data:
                  "admin_menu"
              }
            ]
          ]
        }
      }
    );

  } catch (error) {

    console.error(
      "Broadcast menu error:",
      error
    );

    await ctx.reply(
      "❌ Unable to load broadcast menu."
    );

  }

}


bot.callbackQuery(
  "admin_broadcast",
  async (ctx) => {

    await answerCallback(ctx);

    await showBroadcastMenu(ctx);

  }
);


// ============================================================
// BROADCAST IMAGE
// ============================================================

const pendingBroadcastImage =
  new Map();


bot.callbackQuery(
  "broadcast_image",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    pendingBroadcastImage.set(
      getTelegramId(ctx),
      true
    );

    await safeEditMessage(
      ctx,
      "🖼️ *Broadcast Image*\n\n" +
      "Please send the image you want to use for the broadcast.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel",
                callback_data:
                  "admin_broadcast"
              }
            ]
          ]
        }
      }
    );

  }
);


// ============================================================
// RECEIVE BROADCAST PHOTO
// ============================================================

bot.on(
  "message:photo",
  async (ctx, next) => {

    const telegramId =
      getTelegramId(ctx);

    if (
      !pendingBroadcastImage.has(
        telegramId
      )
    ) {

      return next();

    }

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {

      pendingBroadcastImage.delete(
        telegramId
      );

      return next();

    }

    try {

      const photos =
        ctx.message.photo;

      const largest =
        photos[
          photos.length - 1
        ];

      if (
        !largest ||
        !largest.file_id
      ) {

        await ctx.reply(
          "❌ Unable to read the image."
        );

        return;

      }

      if (
        typeof db.createBroadcastDraft !==
        "function"
      ) {

        await ctx.reply(
          "❌ Broadcast draft function is unavailable."
        );

        return;

      }

      let draft =
        null;

      if (
        typeof db.getBroadcastDraft ===
        "function"
      ) {

        draft =
          await db.getBroadcastDraft(
            admin.id
          );

      }

      if (!draft) {

        draft =
          await db.createBroadcastDraft(
            admin.id
          );

      }

      if (
        typeof db.updateBroadcastImage ===
        "function"
      ) {

        await db.updateBroadcastImage(
          draft.id,
          largest.file_id
        );

      }

      pendingBroadcastImage.delete(
        telegramId
      );

      await ctx.reply(
        "✅ Broadcast image saved.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📢 Broadcast Menu",
                  callback_data:
                    "admin_broadcast"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Broadcast image error:",
        error
      );

      await ctx.reply(
        "❌ Unable to save broadcast image."
      );

    }

  }
);


// ============================================================
// BROADCAST MESSAGE STATE
// ============================================================

const pendingBroadcastMessage =
  new Map();


bot.callbackQuery(
  "broadcast_message",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    pendingBroadcastMessage.set(
      getTelegramId(ctx),
      true
    );

    await safeEditMessage(
      ctx,
      "📝 *Broadcast Message*\n\n" +
      "Please send the message you want to broadcast to all active users.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel",
                callback_data:
                  "admin_broadcast"
              }
            ]
          ]
        }
      }
    );

  }
);


// ============================================================
// RECEIVE BROADCAST MESSAGE
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const telegramId =
      getTelegramId(ctx);

    if (
      !pendingBroadcastMessage.has(
        telegramId
      )
    ) {

      return next();

    }

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {

      pendingBroadcastMessage.delete(
        telegramId
      );

      return next();

    }

    try {

      const message =
        ctx.message.text.trim();

      if (!message) {

        await ctx.reply(
          "❌ Broadcast message cannot be empty."
        );

        return;

      }

      let draft =
        null;

      if (
        typeof db.getBroadcastDraft ===
        "function"
      ) {

        draft =
          await db.getBroadcastDraft(
            admin.id
          );

      }

      if (!draft) {

        draft =
          await db.createBroadcastDraft(
            admin.id
          );

      }

      if (
        typeof db.updateBroadcastMessage ===
        "function"
      ) {

        await db.updateBroadcastMessage(
          draft.id,
          message
        );

      }

      pendingBroadcastMessage.delete(
        telegramId
      );

      await ctx.reply(
        "✅ Broadcast message saved.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📢 Broadcast Menu",
                  callback_data:
                    "admin_broadcast"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Broadcast message error:",
        error
      );

      await ctx.reply(
        "❌ Unable to save broadcast message."
      );

    }

  }
);


// ============================================================
// BROADCAST PREVIEW
// ============================================================

bot.callbackQuery(
  "broadcast_preview",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    try {

      const draft =
        await db.getBroadcastDraft(
          admin.id
        );

      if (!draft) {

        await ctx.reply(
          "❌ No broadcast draft exists."
        );

        return;

      }

      if (
        draft.image_url
      ) {

        await ctx.replyWithPhoto(
          draft.image_url,
          {
            caption:
              draft.message ||
              "No broadcast message has been added."
          }
        );

      } else {

        await ctx.reply(
          draft.message ||
          "No broadcast message has been added."
        );

      }

      await ctx.reply(
        "👁️ Preview complete.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📢 Broadcast Menu",
                  callback_data:
                    "admin_broadcast"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Broadcast preview error:",
        error
      );

      await ctx.reply(
        "❌ Unable to preview broadcast."
      );

    }

  }
);


// ============================================================
// BROADCAST CLEAR
// ============================================================

bot.callbackQuery(
  "broadcast_clear",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    try {

      const draft =
        await db.getBroadcastDraft(
          admin.id
        );

      if (
        draft &&
        typeof db.deleteBroadcastDraft ===
        "function"
      ) {

        await db.deleteBroadcastDraft(
          draft.id
        );

      }

      pendingBroadcastImage.delete(
        getTelegramId(ctx)
      );

      pendingBroadcastMessage.delete(
        getTelegramId(ctx)
      );

      await safeEditMessage(
        ctx,
        "🗑️ *Broadcast Draft Cleared*",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📢 Broadcast Menu",
                  callback_data:
                    "admin_broadcast"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Clear broadcast error:",
        error
      );

      await ctx.reply(
        "❌ Unable to clear broadcast draft."
      );

    }

  }
);


// ============================================================
// BROADCAST SEND CONFIRMATION
// ============================================================

bot.callbackQuery(
  "broadcast_send",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    try {

      const draft =
        await db.getBroadcastDraft(
          admin.id
        );

      if (!draft) {

        await ctx.reply(
          "❌ No broadcast draft exists."
        );

        return;

      }

      if (
        !draft.message
      ) {

        await ctx.reply(
          "❌ Please add a broadcast message first."
        );

        return;

      }

      await safeEditMessage(
        ctx,
        "📤 *Send Broadcast?*\n\n" +
        "This will send the broadcast to all active users.\n\n" +
        "Are you sure?",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Yes, Send",
                  callback_data:
                    "broadcast_confirm_send"
                }
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    "admin_broadcast"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Broadcast send preparation error:",
        error
      );

      await ctx.reply(
        "❌ Unable to prepare broadcast."
      );

    }

  }
);


// ============================================================
// CONFIRM BROADCAST
// ============================================================

bot.callbackQuery(
  "broadcast_confirm_send",
  async (ctx) => {

    await answerCallback(ctx);

    const admin =
      await requireAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    try {

      const draft =
        await db.getBroadcastDraft(
          admin.id
        );

      if (!draft || !draft.message) {

        await ctx.reply(
          "❌ Broadcast draft is incomplete."
        );

        return;

      }

      const users =
        await db.getAllActiveUsers();

      if (
        !users ||
        users.length === 0
      ) {

        await ctx.reply(
          "❌ There are no active users to broadcast to."
        );

        return;

      }

      let sent =
        0;

      let failed =
        0;

      for (
        const user of users
      ) {

        try {

          if (
            draft.image_url
          ) {

            await ctx.api.sendPhoto(
              user.telegram_id,
              draft.image_url,
              {
                caption:
                  draft.message
              }
            );

          } else {

            await ctx.api.sendMessage(
              user.telegram_id,
              draft.message
            );

          }

          sent++;

        } catch (sendError) {

          failed++;

          console.error(
            `Broadcast send error for ${user.telegram_id}:`,
            sendError
          );

        }

      }

      if (
        typeof db.deleteBroadcastDraft ===
        "function"
      ) {

        await db.deleteBroadcastDraft(
          draft.id
        );

      }

      await safeEditMessage(
        ctx,
        "📢 *Broadcast Complete*\n\n" +
        `✅ Sent: *${sent}*\n` +
        `❌ Failed: *${failed}*\n` +
        `👥 Total: *${users.length}*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📢 Broadcast Menu",
                  callback_data:
                    "admin_broadcast"
                }
              ],
              [
                {
                  text: "🏠 Admin Menu",
                  callback_data:
                    "admin_menu"
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "Broadcast execution error:",
        error
      );

      await ctx.reply(
        "❌ Broadcast failed.\n\n" +
        (
          error &&
          error.message
            ? error.message
            : ""
        )
      );

    }

  }
);


// ============================================================
// ADMIN CANCEL
// ============================================================

bot.callbackQuery(
  "admin_cancel",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      getTelegramId(ctx);

    pendingAdminUserSearch.delete(
      telegramId
    );

    pendingAdminRoleSearch.delete(
      telegramId
    );

    pendingAdminReject.delete(
      telegramId
    );

    pendingBroadcastImage.delete(
      telegramId
    );

    pendingBroadcastMessage.delete(
      telegramId
    );

    delete pendingAdminAccount[
      telegramId
    ];

    await showAdminMenu(ctx);

  }
);


// ============================================================
// FALLBACK TEXT COMMANDS
// ============================================================

bot.hears(
  "🎮 Play Bingo",
  async (ctx) => {

    const telegramId =
      getTelegramId(ctx);

    if (!telegramId) {
      return;
    }

    const user =
      await getCurrentUser(ctx);

    if (!user) {

      await ctx.reply(
        "Please /start to register first."
      );

      return;

    }

    await ctx.reply(
      "🎮 Tap the button below to open Sisters Bingo.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎮 Play Bingo",
                web_app: {
                  url:
                    `${GAME_URL}?tid=${telegramId}`
                }
              }
            ],
            [
              {
                text: "🏠 Home",
                callback_data:
                  "user_home"
              }
            ]
          ]
        }
      }
    );

  }
);


// ============================================================
// UNKNOWN TEXT HANDLER
// ============================================================

bot.on(
  "message:text",
  async (ctx) => {

    const text =
      ctx.message.text.trim();

    if (
      text.startsWith("/")
    ) {

      return;

    }

    await ctx.reply(
      "❓ I didn't understand that command.\n\n" +
      "Please use the buttons in the menu or send /start.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🏠 Home",
                callback_data:
                  "user_home"
              }
            ]
          ]
        }
      }
    );

  }
);


// ============================================================
// ERROR HANDLER
// ============================================================

bot.catch(
  (error) => {

    console.error(
      "Telegram bot error:",
      error
    );

  }
);


// ============================================================
// VERCEL WEBHOOK HANDLER
// ============================================================

const handler =
  webhookCallback(
    bot,
    "https"
  );


module.exports =
  handler;
