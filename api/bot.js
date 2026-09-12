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
  
  pendingAdminUserSearch.delete(telegramId);
  pendingAdminRoleSearch.delete(telegramId);
}

// ============================================================
// BLOCKED USER GUARD
// ============================================================
// Blocked users cannot use bot features.
// /start is allowed through so the user receives the
// blocked-account message from the /start handler.
bot.use(async (ctx, next) => {
  try {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      return next();
    }

    const text = ctx.message?.text?.trim() || "";

    // Allow /start so blocked users see the blocked message
    if (text.startsWith("/start")) {
      return next();
    }

    const user = await db.getUserByTelegramId(telegramId);

    if (user?.is_blocked === true) {

      // Callback buttons
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCallbackQuery({
            text: "🚫 Your account is blocked.",
            show_alert: true
          });
        } catch (err) {}

        return;
      }

      // Normal messages / commands
      return ctx.reply(
        "🚫 Your account has been blocked. Please contact support."
      );
    }

    return next();

  } catch (err) {

    console.error(
      "Blocked user guard error:",
      err
    );

    // Do not break the bot if the database check fails
    return next();
  }
});
// ============================================================
// ADMIN AUTHORIZATION
// ============================================================

/**
 * Returns the currently logged-in admin from the database.
 *
 * Admin is determined by:
 *
 * users.is_admin = TRUE
 * users.is_active = TRUE
 * users.is_banned = FALSE
 *
 * There is NO hard-coded ADMIN_ID.
 */
async function getCurrentAdmin(
  ctx
) {

  if (
    !ctx ||
    !ctx.from ||
    !ctx.from.id
  ) {

    return null;

  }


  try {

    const admin =
      await db.getAdminByTelegramId(
        ctx.from.id
      );


    return admin || null;

  } catch (err) {

    console.error(
      "Admin lookup error:",
      err
    );

    return null;

  }

}

async function requireAdminPermission(ctx, permission) {
    const admin = await getCurrentAdmin(ctx);

    if (!admin) {
        try {
            await ctx.answerCallbackQuery({
                text: "❌ Unauthorized",
                show_alert: true
            });
        } catch (err) {}

        return null;
    }

    const role = admin.admin_role;

    const allowed =
  role === "main" ||
  (role === "broadcast" &&
    permission === "broadcast") ||
  (role === "statistics" &&
    permission === "statistics") ||
  (role === "withdrawal" &&
    permission === "withdrawals");

    if (!allowed) {
        try {
            await ctx.answerCallbackQuery({
                text: "❌ You do not have permission for this.",
                show_alert: true
            });
        } catch (err) {}

        return null;
    }

    return admin;
}

/**
 * Requires the current Telegram user
 * to be an active, non-banned admin.
 *
 * Returns the admin database row when authorized.
 * Returns null when unauthorized.
 */
async function requireAdmin(
  ctx
) {

  const admin =
    await getCurrentAdmin(
      ctx
    );


  if (!admin) {

    try {

      await ctx.answerCallbackQuery({

        text:
          "Unauthorized",

        show_alert:
          true

      });

    } catch (err) {

      console.log(
        "Unauthorized callback response failed:",
        err.description ||
        err.message
      );

    }


    return null;

  }


  return admin;

}


// ============================================================
// CALLBACK HELPER
// ============================================================

async function answerCallback(
  ctx,
  text = undefined
) {

  try {

    if (text) {

      await ctx.answerCallbackQuery({

        text

      });

    } else {

      await ctx.answerCallbackQuery();

    }

  } catch (err) {

    console.log(
      "Callback answer failed:",
      err.description ||
      err.message
    );

  }

}


// ============================================================
// PHONE NORMALIZATION
// ============================================================

function normalizeEthiopianPhone(
  input
) {

  let phone =
    String(input)
      .trim()
      .replace(
        /[\s\-()]/g,
        ""
      );


  // 0912345678

  if (
    /^09\d{8}$/.test(phone)
  ) {

    return (
      "+251" +
      phone.substring(1)
    );

  }


  // 0712345678

  if (
    /^07\d{8}$/.test(phone)
  ) {

    return (
      "+251" +
      phone.substring(1)
    );

  }


  // 251912345678

  if (
    /^2519\d{8}$/.test(phone)
  ) {

    return "+" + phone;

  }


  // 251712345678

  if (
    /^2517\d{8}$/.test(phone)
  ) {

    return "+" + phone;

  }


  // +251912345678

  if (
    /^\+2519\d{8}$/.test(phone)
  ) {

    return phone;

  }


  // +251712345678

  if (
    /^\+2517\d{8}$/.test(phone)
  ) {

    return phone;

  }


  return null;

}

// ============================================================
// PAYMENT ACCOUNT NUMBER NORMALIZATION
// ============================================================
//
// IMPORTANT:
// Only Mobile / ሞባይል payment types are normalized.
//
// Bank and other payment types keep the account number
// exactly as entered, except for trimming surrounding spaces.
// ============================================================

function normalizePaymentAccountNumber(
  accountNumber,
  paymentTypeName,
  paymentTypeAmharicName
) {

  const raw =
    String(accountNumber || "").trim();

  if (!raw) {
    return null;
  }

  const typeName =
    String(paymentTypeName || "")
      .trim()
      .toLowerCase();

  const amharicTypeName =
    String(paymentTypeAmharicName || "")
      .trim();

  const isMobile =
    typeName === "mobile" ||
    amharicTypeName === "ሞባይል";

  // ----------------------------------------------------------
  // MOBILE ONLY
  // ----------------------------------------------------------

  if (isMobile) {

    return normalizeEthiopianPhone(
      raw
    );

  }

  // ----------------------------------------------------------
  // NON-MOBILE
  // ----------------------------------------------------------
  //
  // Do NOT modify bank/account numbers.
  //

  return raw;
}

// ============================================================
// HOME MENU
// ============================================================

async function showHome(
  ctx,
  user
) {
  const telegramId =    ctx.from.id;

  
const canPlay =
  user &&
  user.is_active === true &&
  user.is_blocked !== true;
  



const keyboard = [];

if (user && user.is_active === true && user.is_blocked !== true) {
  keyboard.push([
    {
      text: "🎮 Play",
      web_app: {
        url: `${GAME_URL}?tid=${telegramId}`
      }
    }
  ]);
}

keyboard.push(
  [
    {
      text: "💰 Balance",
      callback_data: "balance"
    },
    {
      text: "🔄 Transfer",
      callback_data: "transfer"
    }
  ],
  [
    {
      text: "💎 Deposit",
      callback_data: "deposit"
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
      text: "🆘 Support",
      callback_data: "support"
    }
  ],
  [
    {
      text: "🗑️ Delete",
      callback_data: "delete"
    }
  ]
);


  // ============================================================
// USER STATISTICS
// ============================================================

async function showUserStatistics(ctx) {

  const telegramId = ctx.from.id;

  const user =
    await db.getUserByTelegramId(telegramId);

  if (!user) {
    return ctx.reply(
      "Please /start to register first."
    );
  }

  try {

    const stats =
      await db.getUserStatistics(telegramId);

    if (!stats) {
      return ctx.reply(
        "❌ Could not load your statistics."
      );
    }

    const message =
      `📊 *YOUR STATISTICS*\n\n` +

      `💎 Total Deposits: *${stats.totalDeposits}*\n\n` +

      `🏧 *Withdrawals*\n` +
      `⏳ Pending Approval: *${stats.pendingWithdrawals}*\n` +
      `✅ Approved: *${stats.approvedWithdrawals}*\n` +
      `❌ Rejected: *${stats.rejectedWithdrawals}*\n\n` +

      `🔄 Total Transfers: *${stats.totalTransfers}*`;

    await ctx.reply(
      message,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 Refresh",
                callback_data: "statistics"
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

  } catch (err) {

    console.error(
      "User statistics error:",
      err
    );

    await ctx.reply(
      "❌ Unable to load statistics right now."
    );
  }
}


// ============================================================
// STATISTICS CALLBACK
// ============================================================

bot.callbackQuery(
  "statistics",
  async (ctx) => {

    await answerCallback(ctx);

    clearPendingState(
      ctx.from.id
    );

    await showUserStatistics(ctx);

  }
);
// ============================================================
// USER HOME BUTTON
// ============================================================

bot.callbackQuery("user_home", async (ctx) => {
  try {
    await answerCallback(ctx);

    clearPendingState(ctx.from.id);

    const user = await db.getUserByTelegramId(ctx.from.id);

    if (!user) {
      return await ctx.reply(
        "Please /start to register first."
      );
    }

    await showHome(ctx, user);

  } catch (err) {
    console.error("User home button error:", err);

    await ctx.reply(
      "❌ Unable to return to home."
    );
  }
});
  // ============================================================
// DELETE ACCOUNT
// ============================================================

bot.callbackQuery(
  "delete",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      ctx.from.id;

    clearPendingState(
      telegramId
    );

    pendingDelete[
      telegramId
    ] = true;

    await ctx.editMessageText(
      "⚠️ *አካውንትዎን ማጥፋት ይፈልጋሉ?*\n\n" +
      "ይህ አካውንትዎን ያቦዝነዋል።\n" +
      "የቀረው ቀሪ ሂሳብ፣ የገቢ እና የወጪ ታሪክ አይሰረዝም።\n\n" +
      "ከአሁን በሁዋላ ከእኛ ምንም አይነት ማስታወቂያም ሆነ መረጃ አይደርሶትም!\n\n" +
      "በኋላ /start በመጠቀም አካውንትዎን እንደገና ማንቃት ይችላሉ።\n\n" +
      "እርግጠኛ ነዎት?",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "አዎ",
                callback_data: "delete_confirm"
              },
              {
                text: "አይ",
                callback_data: "delete_cancel"
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

    const telegramId =
      ctx.from.id;

    delete pendingDelete[
      telegramId
    ];

    const user =
      await db.getUserByTelegramId(
        telegramId
      );

    if (!user) {
      return ctx.editMessageText(
        "❌ Account not found."
      );
    }

    await ctx.editMessageText(
      "✅ አካውንትዎን ማጥፋት ተሰርዟል።"
    );

    await showHome(
      ctx,
      user
    );

  }
);
  bot.callbackQuery(
  "delete_confirm",
  async (ctx) => {

    await answerCallback(ctx);

    const telegramId =
      ctx.from.id;

    delete pendingDelete[
      telegramId
    ];

    try {

      const result =
        await db.deactivateUser(
          telegramId
        );

      if (!result) {

        return await ctx.editMessageText(
          "❌ አካውንትዎ አልተገኘም።"
        );

      }

      clearPendingState(
        telegramId
      );

      await ctx.editMessageText(
        "✅ *አካውንትዎ ተቦዝኗል።*\n\n" +
        "የግል መረጃዎ፣ ቀሪ ሂሳብዎ እና የግብይት ታሪክዎ አልተሰረዙም።\n\n" +
        "እንደገና ለመጠቀም /start ይጫኑ።",
        {
          parse_mode: "Markdown"
        }
      );

    } catch (err) {

      console.error(
        "Delete account error:",
        err
      );

      await ctx.editMessageText(
        "❌ አካውንትዎን ማቦዘን አልተቻለም።\n\n" +
        "እባክዎ እንደገና ይሞክሩ።"
      );

    }

  }
);


  // ----------------------------------------------------------
  // ADMIN BUTTONS
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // Admin status comes from users.is_admin.
  // There is NO hard-coded ADMIN_ID.
  //
  // The `user` object comes from the database.
  // We also verify active/non-banned admin status here.
  // ----------------------------------------------------------
let admin = null;

try {
    admin = await getCurrentAdmin(ctx);
} catch (err) {
    console.error(
        "Home admin check error:",
        err
    );
}

// Main admin = everything
if (admin && admin.admin_role === "main") {
      keyboard.push([
        {
            text: "👤 Manage User",
            callback_data: "admin_manage_user"
        },
        {
            text: "👑 Manage Admins",
            callback_data: "admin_manage_admins"
          }
    ]);

    keyboard.push([
        {
            text: "⏳ Pending",
            callback_data: "admin_withdrawals"
        },
        {
            text: "📢 Broadcast",
            callback_data: "admin_broadcast"
        }
    ]);

    keyboard.push([
      {
        text:
          "💳 Accounts",
    
        callback_data:
          "admin_accounts"
      },
    
      {
        text:
          "📊 Statistics",
    
        callback_data:
          "admin_statistics_menu"
      }
    ]);
}

// Broadcast admin = broadcast only
else if (
    admin &&
    admin.admin_role === "broadcast"
) {

    keyboard.push([
        {
            text: "📢 Broadcast",
            callback_data: "admin_broadcast"
        }
    ]);
}

// Withdrawal admin = withdrawal only
else if (
    admin &&
    admin.admin_role === "withdrawal"
) {

    keyboard.push([
        {
            text: "⏳ Pending",
            callback_data: "admin_withdrawals"
        }
    ]);
}

  await ctx.reply(

    `Welcome back, *${user.name}!* 🎱\n\n` +    

    `👋 Welcome to Beteseb Bingo! Choose an Option below:`,

    {

      parse_mode:
        "Markdown",

      reply_markup: {

        inline_keyboard:
          keyboard

      }

    }

  );

}

// ============================================================
// ADMIN ROLE MANAGEMENT
// MAIN ADMIN ONLY
// ============================================================

bot.callbackQuery(
  "admin_manage_admins",
  async (ctx) => {
    try {
      await ctx.answerCallbackQuery();

      const admin =
        await db.getAdminByTelegramId(ctx.from.id);

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {
        return ctx.reply(
          "⛔ You are not authorized to manage admins."
        );
      }

      pendingAdminRoleSearch.set(
        ctx.from.id,
        {
          step: "waiting_phone"
        }
      );

      await ctx.editMessageText(
        `👑 *Manage Admins*\n\n` +
        `Send the user's phone number.\n\n` +
        `Example:\n` +
        `\`0912345678\`\n` +
        `or\n` +
        `\`+251912345678\``,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    "admin_manage_admins_cancel"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {
      console.error(
        "Admin role management error:",
        err
      );

      await ctx.reply(
        "❌ Something went wrong."
      );
    }
  }
);
// ============================================================
// ADMIN MANAGE USER
// ============================================================

bot.callbackQuery("admin_manage_user", async (ctx) => {

  try {

    await ctx.answerCallbackQuery();

    const admin =
      await db.getAdminByTelegramId(ctx.from.id);

    // Only main admin can manage users
    if (
      !admin ||
      admin.admin_role !== "main"
    ) {

      return ctx.reply(
        "⛔ You are not authorized to use this feature."
      );

    }

    pendingAdminUserSearch.set(
      ctx.from.id,
      {
        step: "waiting_phone"
      }
    );

    await ctx.editMessageText(

      `👤 *Manage User*\n\n` +
      `Send the user's phone number.\n\n` +
      `Example:\n` +
      `\`0912345678\`\n` +
      `or\n` +
      `\`+251912345678\``,

      {
        parse_mode: "Markdown",

        reply_markup: {

          inline_keyboard: [
            [
            {
              text: "🏠 Home",
              callback_data:
                "admin_home"
            }
          ],

            [
              {
                text: "❌ Cancel",
                callback_data:
                  "admin_manage_user_cancel"
              }
            ]

          ]

        }

      }

    );

  } catch (error) {

    console.error(
      "Admin manage user error:",
      error
    );

    await ctx.reply(
      "❌ Something went wrong."
    );

  }

});

bot.on("message:text", async (ctx, next) => {
  try {
    const telegramId = ctx.from.id;

    // ============================================================
    // MANAGE USER — WAITING FOR PHONE NUMBER
    // ============================================================
    const userSearchState =
      pendingAdminUserSearch.get(telegramId);
    

    if (
      userSearchState &&
      userSearchState.step === "waiting_phone"
    ) {
      const admin =
        await db.getAdminByTelegramId(telegramId);

      // Only main admin can manage users
      if (
        !admin ||
        admin.admin_role !== "main"
      ) {
        pendingAdminUserSearch.delete(telegramId);

        return await ctx.reply(
          "⛔ You are not authorized to manage users."
        );
      }

      const phone =
        ctx.message.text.trim();

      console.log(
        "Manage User phone search:",
        phone
      );

      // Search user
      const user =
        await db.getUserByPhoneForAdmin(phone);

      if (!user) {
        return await ctx.reply(
          `❌ *User not found*\n\n` +
          `📱 Phone: \`${phone}\`\n\n` +
          `Please send another phone number or press Cancel.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🏠 Home",
                    callback_data:
                      "admin_home"
                  }
                ],
                [
                  {
                    text: "❌ Cancel",
                    callback_data:
                      "admin_manage_user_cancel"
                  }
                ]
              ]
            }
          }
        );
      }

      // Prevent managing yourself
      if (
        String(user.telegram_id) ===
        String(telegramId)
      ) {
        return await ctx.reply(
          "⚠️ You cannot block or unblock your own admin account."
        );
      }

      // Search completed
      pendingAdminUserSearch.delete(telegramId);

      const blockStatus =
        user.is_blocked
          ? "🚫 Blocked"
          : "✅ Active";

      const activeStatus =
        user.is_active
          ? "🟢 Active"
          : "⚪ Inactive";

      const keyboard = [];

      // Block / unblock
      if (user.is_blocked) {
        keyboard.push([
          {
            text: "✅ Unblock User",
            callback_data:
              `admin_unblock_user_${user.id}`
          }
        ]);
      } else {
        keyboard.push([
          {
            text: "🚫 Block User",
            callback_data:
              `admin_block_user_${user.id}`
          }
        ]);
      }

      keyboard.push([
        {
          text: "👤 Manage Another User",
          callback_data:
            "admin_manage_user"
        }
      ]);

            keyboard.push([
        {
        text: "🏠 Home",
    callback_data:
      "admin_home"
        }
      ]);

      keyboard.push([
        {
          text: "❌ Close",
          callback_data:
            "admin_manage_user_cancel"
        }
      ]);

      await ctx.reply(
        `👤 *USER FOUND*\n\n` +
        `👤 Name: *${user.name || "Unknown"}*\n` +
        `📱 Phone: \`${user.phone || "Not available"}\`\n` +
        `💰 Balance: *${user.balance || 0} ETB*\n` +
        `📊 Account: ${activeStatus}\n` +
        `🔒 Status: ${blockStatus}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: keyboard
          }
        }
      );

      return;
    }

    // ============================================================
// USER FINANCIAL STATISTICS PHONE SEARCH
// ============================================================

const financialStatsState =
  pendingAdminRoleSearch.get(telegramId);

if (
  financialStatsState &&
  financialStatsState.step ===
    "financial_statistics_phone"
) {

  const admin =
    await db.getAdminByTelegramId(
      telegramId
    );

  if (
    !admin ||
    (
      admin.admin_role !== "main" &&
      admin.admin_role !== "statistics"
    )
  ) {

    pendingAdminRoleSearch.delete(
      telegramId
    );

    return await ctx.reply(
      "⛔ You are not authorized to view statistics."
    );

  }

  const phone =
    ctx.message.text.trim();

  const user =
    await db.getUserByPhoneForAdmin(
      phone
    );

  if (!user) {

    return await ctx.reply(
      "❌ User not found.\n\n" +
      "Please send a valid registered phone number."
    );

  }

  const stats =
    await db.getUserFinancialStatistics(
      user.id
    );

  pendingAdminRoleSearch.delete(
    telegramId
  );

  const message =
    `👤 *USER FINANCIAL STATISTICS*\n\n` +

    `👤 Name: *${user.name || "Unknown"}*\n` +
    `📱 Phone: \`${user.phone || phone}\`\n\n` +

    `💎 *Total Deposits*\n` +
    `*${stats.totalDepositAmount.toFixed(2)} ETB*\n\n` +

    `🏧 *Withdrawals*\n` +
    `⏳ Pending: *${stats.pendingWithdrawalAmount.toFixed(2)} ETB*\n` +
    `✅ Approved: *${stats.approvedWithdrawalAmount.toFixed(2)} ETB*\n` +
    `❌ Rejected: *${stats.rejectedWithdrawalAmount.toFixed(2)} ETB*`;

  return await ctx.reply(
    message,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [

          [
            {
              text: "👤 Search Another User",
              callback_data:
                "admin_user_financial_statistics"
            }
          ],

          [
            {
              text: "⬅️ Statistics",
              callback_data:
                "admin_statistics_menu"
            },
            {
              text: "🏠 Home",
              callback_data:
                "admin_home"
            }
          ]

        ]
      }
    }
  );
}
        // ============================================================
    // MANAGE ADMINS — WAITING FOR PHONE NUMBER
    // ============================================================

    const roleSearchState =
      pendingAdminRoleSearch.get(telegramId);

    if (
      roleSearchState &&
      roleSearchState.step === "waiting_phone"
    ) {

      const admin =
        await db.getAdminByTelegramId(
          telegramId
        );

      // Only main admin can manage admins
      if (
        !admin ||
        admin.admin_role !== "main"
      ) {

        pendingAdminRoleSearch.delete(
          telegramId
        );

        return await ctx.reply(
          "⛔ You are not authorized to manage admins."
        );

      }

      const phone =
        ctx.message.text.trim();

      console.log(
        "Manage Admins phone search:",
        phone
      );

      // Search user
      const user =
        await db.getUserByPhoneForAdmin(
          phone
        );

      if (!user) {

        return await ctx.reply(
          `❌ *User not found*\n\n` +
          `📱 Phone: \`${phone}\`\n\n` +
          `Please send another phone number or press Cancel.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🏠 Home",
                    callback_data:
                      "admin_home"
                  }
                ],
                [
                  {
                    text: "❌ Cancel",
                    callback_data:
                      "admin_manage_admins_cancel"
                  }
                ]
              ]
            }
          }
        );

      }

      // Do not allow changing your own admin role
      if (
        String(user.telegram_id) ===
        String(telegramId)
      ) {

        pendingAdminRoleSearch.delete(
          telegramId
        );

        return await ctx.reply(
          "⚠️ You cannot change your own admin role.",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "👑 Manage Another Admin",
                    callback_data:
                      "admin_manage_admins"
                  }
                ],
                [
                  {
                    text: "🏠 Home",
                    callback_data:
                      "admin_home"
                  }
                ]
              ]
            }
          }
        );

      }

      // Search completed
      pendingAdminRoleSearch.delete(
        telegramId
      );

      const keyboard = [];

      // Main Admin
      keyboard.push([
        {
          text: "👑 Main Admin",
          callback_data:
            `set_admin_main_${user.id}`
        }
      ]);

      // Statistics Admin
      keyboard.push([
        {
          text: "📊 Statistics Admin",
          callback_data:
            `set_admin_statistics_${user.id}`
        }
      ]);

      // Withdrawal Admin
      keyboard.push([
        {
          text: "💸 Withdrawal Admin",
          callback_data:
            `set_admin_withdrawal_${user.id}`
        }
      ]);

      // Broadcast Admin
      keyboard.push([
        {
          text: "📢 Broadcast Admin",
          callback_data:
            `set_admin_broadcast_${user.id}`
        }
      ]);

      // Remove Admin
      if (user.is_admin === true) {

        keyboard.push([
          {
            text: "🚫 Remove Admin Rights",
            callback_data:
              `remove_admin_${user.id}`
          }
        ]);

      }

      keyboard.push([
        {
          text: "👑 Manage Another Admin",
          callback_data:
            "admin_manage_admins"
        }
      ]);

      keyboard.push([
        {
          text: "🏠 Home",
          callback_data:
            "admin_home"
        }
      ]);

      const currentRole =
        user.is_admin
          ? (
              user.admin_role === "main"
                ? "👑 Main Admin"
                : user.admin_role === "statistics"
                ? "📊 Statistics Admin"
                : user.admin_role === "withdrawal"
                ? "💸 Withdrawal Admin"
                : user.admin_role === "broadcast"
                ? "📢 Broadcast Admin"
                : "Admin"
            )
          : "👤 Normal User";

      await ctx.reply(
        `👑 *MANAGE ADMIN*\n\n` +
        `👤 Name: *${user.name || "Unknown"}*\n` +
        `📱 Phone: \`${user.phone || phone}\`\n` +
        `🔐 Current Role: *${currentRole}*\n\n` +
        `Select the new admin role:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard:
              keyboard
          }
        }
      );

      return;
    }

    // ============================================================
    // NOT A MANAGE USER / MANAGE ADMINS MESSAGE
    // ============================================================

    return next();

    // ============================================================
    // NOT A MANAGE USER MESSAGE
    // ============================================================
    return next();

  } catch (error) {
    console.error(
      "Admin user phone search error:",
      error
    );

    pendingAdminUserSearch.delete(
      ctx.from.id
    );

    await ctx.reply(
      "❌ An error occurred while searching for the user."
    );
  }
});


    
bot.callbackQuery(
  /^admin_block_user_(\d+)$/,
  async (ctx) => {

    try {

      await ctx.answerCallbackQuery();

      const admin =
        await db.getAdminByTelegramId(
          ctx.from.id
        );

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {

        return ctx.reply(
          "⛔ You are not authorized."
        );

      }

      const userId =
        Number(ctx.match[1]);

      const updatedUser =
        await db.setUserBlocked(
          userId,
          true
        );

      if (!updatedUser) {

        return ctx.reply(
          "❌ User not found."
        );

      }

      await ctx.editMessageText(

        `🚫 *User Blocked Successfully*\n\n` +

        `👤 Name: *${updatedUser.name || "Unknown"}*\n` +

        `📱 Phone: \`${updatedUser.phone || "Not available"}\`\n\n` +

        `The user can no longer access the bot.`,

        {
          parse_mode: "Markdown",

          reply_markup: {

            inline_keyboard: [

              [
                {
                  text: "👤 Manage Another User",
                  callback_data:
                    "admin_manage_user"
                }
              ],

              [
                {
                  text: "❌ Close",
                  callback_data:
                    "admin_manage_user_cancel"
                }
              ]

            ]

          }

        }

      );

    } catch (error) {

      console.error(
        "Block user error:",
        error
      );

      await ctx.reply(
        "❌ Failed to block user."
      );

    }

  }
);

bot.callbackQuery(
  /^set_admin_(main|statistics|withdrawal|broadcast)_(\d+)$/,
  async (ctx) => {
    try {
      const admin =
        await db.getAdminByTelegramId(
          ctx.from.id
        );

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {
        return await ctx.answerCallbackQuery({
          text: "❌ Unauthorized",
          show_alert: true
        });
      }

      const role =
        ctx.match[1];

      const userId =
        Number(ctx.match[2]);

      // Never allow changing yourself
      if (
        String(userId) ===
        String(admin.id)
      ) {
        return await ctx.answerCallbackQuery({
          text: "⚠️ You cannot change your own role.",
          show_alert: true
        });
      }

      const updatedUser =
        await db.setUserAdminRole(
          userId,
          role
        );

      if (!updatedUser) {
        return await ctx.answerCallbackQuery({
          text: "❌ User not found.",
          show_alert: true
        });
      }

      await ctx.answerCallbackQuery({
        text: "✅ Admin role updated."
      });

      const roleNames = {
        main: "👑 Main Admin",
        statistics: "📊 Statistics Admin",
        withdrawal: "💸 Withdrawal Admin",
        broadcast: "📢 Broadcast Admin"
      };

      await ctx.editMessageText(
        `✅ *Admin Role Updated*\n\n` +
        `👤 Name: *${updatedUser.name || "Unknown"}*\n` +
        `📱 Phone: \`${updatedUser.phone || "Not available"}\`\n\n` +
        `🔐 New Role: *${roleNames[role]}*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "👑 Manage Another Admin",
                  callback_data:
                    "admin_manage_admins"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {
      console.error(
        "Set admin role error:",
        err
      );

      await ctx.reply(
        "❌ Failed to update admin role."
      );
    }
  }
);
bot.callbackQuery(
  /^remove_admin_(\d+)$/,
  async (ctx) => {
    try {
      const admin =
        await db.getAdminByTelegramId(
          ctx.from.id
        );

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {
        return await ctx.answerCallbackQuery({
          text: "❌ Unauthorized",
          show_alert: true
        });
      }

      const userId =
        Number(ctx.match[1]);

      if (
        String(userId) ===
        String(admin.id)
      ) {
        return await ctx.answerCallbackQuery({
          text: "⚠️ You cannot remove your own admin rights.",
          show_alert: true
        });
      }

      const updatedUser =
        await db.removeUserAdminRole(
          userId
        );

      if (!updatedUser) {
        return await ctx.answerCallbackQuery({
          text: "❌ User not found.",
          show_alert: true
        });
      }

      await ctx.answerCallbackQuery({
        text: "🚫 Admin rights removed."
      });

      await ctx.editMessageText(
        `🚫 *Admin Rights Removed*\n\n` +
        `👤 Name: *${updatedUser.name || "Unknown"}*\n` +
        `📱 Phone: \`${updatedUser.phone || "Not available"}\`\n\n` +
        `The user is now a normal user.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "👑 Manage Another Admin",
                  callback_data:
                    "admin_manage_admins"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {
      console.error(
        "Remove admin role error:",
        err
      );

      await ctx.reply(
        "❌ Failed to remove admin rights."
      );
    }
  }
);

bot.callbackQuery(
  "admin_manage_admins_cancel",
  async (ctx) => {
    await ctx.answerCallbackQuery();

    pendingAdminRoleSearch.delete(
      ctx.from.id
    );

    await ctx.editMessageText(
      "❌ Admin management cancelled."
    );
  }
);

bot.callbackQuery(
  /^admin_unblock_user_(\d+)$/,
  async (ctx) => {

    try {

      await ctx.answerCallbackQuery();

      const admin =
        await db.getAdminByTelegramId(
          ctx.from.id
        );

      if (
        !admin ||
        admin.admin_role !== "main"
      ) {

        return ctx.reply(
          "⛔ You are not authorized."
        );

      }

      const userId =
        Number(ctx.match[1]);

      const updatedUser =
        await db.setUserBlocked(
          userId,
          false
        );

      if (!updatedUser) {

        return ctx.reply(
          "❌ User not found."
        );

      }

      await ctx.editMessageText(

        `✅ *User Unblocked Successfully*\n\n` +

        `👤 Name: *${updatedUser.name || "Unknown"}*\n` +

        `📱 Phone: \`${updatedUser.phone || "Not available"}\`\n\n` +

        `The user can access the bot again.`,

        {
          parse_mode: "Markdown",

          reply_markup: {

            inline_keyboard: [

              [
                {
                  text: "👤 Manage Another User",
                  callback_data:
                    "admin_manage_user"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ],

              [
                {
                  text: "❌ Close",
                  callback_data:
                    "admin_manage_user_cancel"
                }
              ]

            ]

          }

        }

      );

    } catch (error) {

      console.error(
        "Unblock user error:",
        error
      );

      await ctx.reply(
        "❌ Failed to unblock user."
      );

    }

  }
);

bot.callbackQuery(
  "admin_manage_user_cancel",
  async (ctx) => {

    try {

      await ctx.answerCallbackQuery();

      pendingAdminUserSearch.delete(
        ctx.from.id
      );

      await ctx.editMessageText(
        "❌ User management cancelled."
      );

    } catch (error) {

      console.error(
        "Admin manage user cancel error:",
        error
      );

    }

  }
);

// ============================================================
// ADMIN STATISTICS MENU
// ============================================================

bot.callbackQuery(
  "admin_statistics_menu",
  async (ctx) => {

    try {

      await answerCallback(ctx);

      const admin =
        await requireAdminPermission(
          ctx,
          "statistics"
        );

      if (!admin) {
        return;
      }

      await ctx.editMessageText(
        "📊 *STATISTICS*\n\n" +
        "Choose the type of statistics you want to view:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [

              [
                {
                  text: "📊 General Statistics",
                  callback_data: "admin_statistics"
                }
              ],

              [
                {
                  text: "💰 Financial Statistics",
                  callback_data: "admin_financial_statistics"
                }
              ],

              [
                {
                  text: "👤 User Financial Statistics",
                  callback_data: "admin_user_financial_statistics"
                }
              ],

              [
                {
                  text: "🏠 Home",
                  callback_data: "admin_home"
                }
              ]

            ]
          }
        }
      );

    } catch (err) {

      console.error(
        "Admin statistics menu error:",
        err
      );

      await ctx.reply(
        "❌ Could not open statistics."
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

    try {

      await answerCallback(ctx);

      const admin =
        await requireAdminPermission(
          ctx,
          "statistics"
        );

      if (!admin) {
        return;
      }

      const stats =
        await db.getAdminFinancialStatistics();

      const message =
        `💰 *FINANCIAL STATISTICS*\n\n` +

        `💎 *Total Deposits*\n` +
        `*${stats.totalDepositAmount.toFixed(2)} ETB*\n\n` +

        `🏧 *Withdrawals*\n` +
        `⏳ Pending: *${stats.pendingWithdrawalAmount.toFixed(2)} ETB*\n` +
        `✅ Approved: *${stats.approvedWithdrawalAmount.toFixed(2)} ETB*\n` +
        `❌ Rejected: *${stats.rejectedWithdrawalAmount.toFixed(2)} ETB*`;

      await ctx.editMessageText(
        message,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [

              [
                {
                  text: "🔄 Refresh",
                  callback_data:
                    "admin_financial_statistics"
                }
              ],

              [
                {
                  text: "⬅️ Statistics",
                  callback_data:
                    "admin_statistics_menu"
                },
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ]

            ]
          }
        }
      );

    } catch (err) {

      console.error(
        "Admin financial statistics error:",
        err
      );

      await ctx.reply(
        "❌ Could not load financial statistics."
      );

    }

  }
);
// ============================================================
// ADMIN USER FINANCIAL STATISTICS
// ============================================================

bot.callbackQuery(
  "admin_user_financial_statistics",
  async (ctx) => {

    try {

      await answerCallback(ctx);

      const admin =
        await requireAdminPermission(
          ctx,
          "statistics"
        );

      if (!admin) {
        return;
      }

      clearPendingState(ctx.from.id);

      pendingAdminRoleSearch.set(
        ctx.from.id,
        {
          step: "financial_statistics_phone"
        }
      );

      await ctx.editMessageText(
        "👤 *USER FINANCIAL STATISTICS*\n\n" +
        "Please send the user's phone number.\n\n" +
        "Example:\n" +
        "`0912345678`\n" +
        "or\n" +
        "`+251912345678`",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⬅️ Statistics",
                  callback_data:
                    "admin_statistics_menu"
                }
              ],
              [
                {
                  text: "🏠 Home",
                  callback_data:
                    "admin_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {

      console.error(
        "Admin user financial statistics search error:",
        err
      );

      await ctx.reply(
        "❌ Something went wrong."
      );

    }

  }
);
// ============================================================
// ADMIN STATISTICS
// ============================================================

bot.callbackQuery(
  "admin_statistics",
  async (ctx) => {

    try {

      await answerCallback(ctx);

      // ------------------------------------------
      // Verify admin
      // ------------------------------------------

      const admin =
  await requireAdminPermission(
    ctx,
    "statistics"
  );

if (!admin) {
  return;
}


      // ------------------------------------------
      // Get statistics
      // ------------------------------------------

      const stats =
        await db.getAdminStatistics();


      // ------------------------------------------
      // Display statistics
      // ------------------------------------------

      const message =
        `📊 *SISTERS BINGO STATISTICS*\n\n` +

        `💸 *Withdrawals*\n` +
        `⏳ Pending: *${stats.pendingWithdrawals}*\n` +
        `✅ Approved: *${stats.approvedWithdrawals}*\n` +
        `❌ Rejected: *${stats.rejectedWithdrawals}*\n\n` +

        `🔄 *Transfers*\n` +
        `Total Transfers: *${stats.totalTransfers}*\n\n` +

        `👥 *Users*\n` +
        `🟢 Active Users: *${stats.activeUsers}*\n` +
        `⚪ Inactive Users: *${stats.inactiveUsers}*\n` +
        `🔴 Blocked Users: *${stats.blockedUsers}*\n\n` +

        `👑 Administrators: *${stats.administrators}*`;


      await ctx.reply(
        message,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔄 Refresh",
                  callback_data: "admin_statistics"
                }
              ],
              [
                {
                   text: "⬅️ Statistics",
                   callback_data:
                   "admin_statistics_menu"
                },
                {
                  text: "🏠 Home",
                  callback_data: "admin_home"
                }
              ]
            ]
          }
        }
      );


    } catch (err) {

      console.error(
        "Admin statistics error:",
        err
      );

      await ctx.reply(
        "❌ Could not load statistics."
      );

    }

  }
);
// ============================================================
// ADMIN — PAYMENT ACCOUNT MANAGEMENT
// ============================================================
//
// Flow:
//
// Accounts
//    ├── Add Account
//    │      └── Payment Method
//    │             └── Account Name
//    │                    └── Account Number
//    │                           └── Initial Balance
//    │                                  └── Save
//    │
//    └── Manage Accounts
//           └── Activate / Deactivate
//
// Account-number normalization:
// ONLY Mobile / ሞባይል is normalized.
// ============================================================


// ============================================================
// SHOW PAYMENT ACCOUNTS MENU
// ============================================================

async function showAdminAccounts(ctx) {

  const admin =
    await requireAdmin(ctx);

  if (!admin) {
    return;
  }

  try {

    const accounts =
      await db.getAllPaymentAccountsForAdmin();

    let message =
      "💳 *PAYMENT ACCOUNTS*\n\n";

    if (
      !accounts ||
      accounts.length === 0
    ) {

      message +=
        "No payment accounts have been created yet.\n\n";

    } else {

      accounts.forEach(
        (account, index) => {

          const methodName =
            account.pm_amharic_name ||
            account.pm_name ||
            "Payment Method";

          const typeName =
            account.pt_amharic_name ||
            account.pt_name ||
            "";

          const status =
            account.is_active
              ? "🟢 Active"
              : "🔴 Inactive";

          message +=
            `${index + 1}. ${account.pm_emoji || "💳"} *${account.account_name}*\n` +
            `💳 Method: *${methodName}*\n`;

          if (typeName) {

            message +=
              `📂 Type: *${typeName}*\n`;

          }

          message +=
            `📱 Account: \`${account.account_number}\`\n` +
            `💰 Balance: *${account.balance} ETB*\n` +
            `📌 Status: ${status}\n\n`;

        }
      );

    }


    const keyboard = [];


    // ----------------------------------------------------------
    // EXISTING ACCOUNT TOGGLE BUTTONS
    // ----------------------------------------------------------

    if (
      accounts &&
      accounts.length > 0
    ) {

      for (
        const account of accounts
      ) {

        keyboard.push([
          {
            text:
              account.is_active
                ? `🔴 Deactivate ${account.account_name}`
                : `🟢 Activate ${account.account_name}`,

            callback_data:
              `admin_account_toggle_${account.id}_${account.is_active ? "0" : "1"}`
          }
        ]);

      }

    }


    // ----------------------------------------------------------
    // MAIN BUTTONS
    // ----------------------------------------------------------

    keyboard.push([
      {
        text:
          "➕ Add Account",

        callback_data:
          "admin_account_add"
      }
    ]);

    keyboard.push([
      {
        text:
          "🔄 Refresh",

        callback_data:
          "admin_accounts"
      },

      {
        text:
          "🏠 Home",

        callback_data:
          "admin_home"
      }
    ]);


    const options = {

      parse_mode:
        "Markdown",

      reply_markup: {
        inline_keyboard:
          keyboard
      }

    };


    // ----------------------------------------------------------
    // EDIT EXISTING MESSAGE WHEN CALLED FROM BUTTON
    // ----------------------------------------------------------

    if (
      ctx.callbackQuery
    ) {

      try {

        await ctx.editMessageText(
          message,
          options
        );

      } catch (err) {

        // Message may already contain the same text
        // or may not be editable.

        await ctx.reply(
          message,
          options
        );

      }

    } else {

      await ctx.reply(
        message,
        options
      );

    }

  } catch (err) {

    console.error(
      "Admin accounts screen error:",
      err
    );

    await ctx.reply(
      "❌ Could not load payment accounts."
    );

  }

}


// ============================================================
// ADMIN ACCOUNTS BUTTON
// ============================================================

bot.callbackQuery(
  "admin_accounts",
  async (ctx) => {

    const admin =
      await requireAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    // Do not leave an unfinished account creation flow.
    delete pendingAdminAccount[
      admin.telegram_id
    ];

    await showAdminAccounts(
      ctx
    );

  }
);


// ============================================================
// ADD ACCOUNT — SELECT PAYMENT METHOD
// ============================================================

bot.callbackQuery(
  "admin_account_add",
  async (ctx) => {

    const admin =
      await requireAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    try {

      const paymentMethods =
        await db.getPaymentMethods();

      if (
        !paymentMethods ||
        paymentMethods.length === 0
      ) {

        return ctx.reply(
          "❌ No active payment methods are available."
        );

      }


      const keyboard =
        paymentMethods.map(
          (pm) => [

            {
              text:
                `${pm.emoji || "💳"} ${pm.amharic_name || pm.name}`,

              callback_data:
                `admin_account_method_${pm.id}`
            }

          ]
        );


      keyboard.push([
        {
          text:
            "↩️ Back",

          callback_data:
            "admin_accounts"
        }
      ]);


      await ctx.editMessageText(
        "➕ *ADD PAYMENT ACCOUNT*\n\n" +
        "First select the *payment method*:",
        {
          parse_mode:
            "Markdown",

          reply_markup: {
            inline_keyboard:
              keyboard
          }
        }
      );

    } catch (err) {

      console.error(
        "Admin add account method error:",
        err
      );

      await ctx.reply(
        "❌ Could not load payment methods."
      );

    }

  }
);


// ============================================================
// ADD ACCOUNT — PAYMENT METHOD SELECTED
// ============================================================

bot.callbackQuery(
  /^admin_account_method_(\d+)$/,
  async (ctx) => {

    const admin =
      await requireAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const paymentMethodId =
      Number(
        ctx.match[1]
      );

    try {

      const method =
        await db.getPaymentMethodById(
          paymentMethodId
        );

      if (!method) {

        return ctx.reply(
          "❌ Payment method not found."
        );

      }


      pendingAdminAccount[
        admin.telegram_id
      ] = {

        step:
          "account_name",

        paymentMethodId:
          paymentMethodId,

        paymentMethod:
          method,

        paymentTypeName:
          method.type_name,

        paymentTypeAmharicName:
          method.am_type_name

      };


      await ctx.editMessageText(

        "➕ *ADD PAYMENT ACCOUNT*\n\n" +

        `💳 Payment Method: *${method.amharic_name || method.name}*\n` +

        `📂 Payment Type: *${method.am_type_name || method.type_name || "-"}*\n\n` +

        "Please enter the *account name*.\n\n" +

        "Example:\n" +
        "`Sisters Bingo Telebirr`",

        {

          parse_mode:
            "Markdown",

          reply_markup: {

            inline_keyboard: [

              [

                {

                  text:
                    "❌ Cancel",

                  callback_data:
                    "admin_account_cancel"

                }

              ]

            ]

          }

        }

      );

    } catch (err) {

      console.error(
        "Admin account method selection error:",
        err
      );

      await ctx.reply(
        "❌ Could not select the payment method."
      );

    }

  }
);


// ============================================================
// ADD ACCOUNT — CANCEL
// ============================================================

bot.callbackQuery(
  "admin_account_cancel",
  async (ctx) => {

    const admin =
      await requireAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    delete pendingAdminAccount[
      admin.telegram_id
    ];

    await showAdminAccounts(
      ctx
    );

  }
);


// ============================================================
// TOGGLE ACCOUNT ACTIVE / INACTIVE
// ============================================================

bot.callbackQuery(
  /^admin_account_toggle_(\d+)_(0|1)$/,
  async (ctx) => {

    const admin =
      await requireAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(
      ctx,
      "Updating account..."
    );

    const accountId =
      Number(
        ctx.match[1]
      );

    const isActive =
      ctx.match[2] === "1";


    try {

      const account =
        await db.setPaymentAccountActive(
          accountId,
          isActive
        );

      if (!account) {

        return ctx.reply(
          "❌ Payment account not found."
        );

      }


      await showAdminAccounts(
        ctx
      );

    } catch (err) {

      console.error(
        "Payment account toggle error:",
        err
      );

      await ctx.reply(
        "❌ Could not change the account status."
      );

    }

  }
);


// ============================================================
// ADD ACCOUNT — TEXT INPUT
// ============================================================
//
// IMPORTANT:
// This handler MUST appear BEFORE the existing
// BROADCAST TEXT handler.
//
// Your current broadcast text handler starts around line 4589.
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {

      return next();

    }


    const telegramId =
      admin.telegram_id;

    const pending =
      pendingAdminAccount[
        telegramId
      ];


    // No account creation in progress.
    if (!pending) {

      return next();

    }


    const text =
      String(
        ctx.message.text || ""
      ).trim();


    // ----------------------------------------------------------
    // CANCEL
    // ----------------------------------------------------------

    if (
      text === "/cancel"
    ) {

      delete pendingAdminAccount[
        telegramId
      ];

      return ctx.reply(
        "❌ Payment account creation cancelled."
      );

    }


    // ==========================================================
    // STEP 1 — ACCOUNT NAME
    // ==========================================================

    if (
      pending.step ===
      "account_name"
    ) {

      if (!text) {

        return ctx.reply(
          "❌ Account name cannot be empty.\n\n" +
          "Please enter the account name:"
        );

      }


      if (
        text.length > 100
      ) {

        return ctx.reply(
          "❌ Account name is too long.\n\n" +
          "Please enter a name with 100 characters or fewer:"
        );

      }


      pending.accountName =
        text.substring(
          0,
          100
        );


      pending.step =
        "account_number";


      const isMobile =
        String(
          pending.paymentTypeName || ""
        )
          .trim()
          .toLowerCase() ===
          "mobile" ||

        String(
          pending.paymentTypeAmharicName || ""
        ).trim() ===
          "ሞባይል";


      if (isMobile) {

        return ctx.reply(

          "📱 Please enter the *mobile account number*.\n\n" +

          "Examples:\n" +
          "`0912345678`\n" +
          "`+251912345678`\n" +
          "`251912345678`\n\n" +

          "The number will be normalized to `+251...`.",

          {
            parse_mode:
              "Markdown"
          }

        );

      }


      return ctx.reply(

        "💳 Please enter the *account number*.\n\n" +

        "The account number will be saved as entered.",

        {
          parse_mode:
            "Markdown"
        }

      );

    }


    // ==========================================================
    // STEP 2 — ACCOUNT NUMBER
    // ==========================================================

    if (
      pending.step ===
      "account_number"
    ) {

      if (!text) {

        return ctx.reply(
          "❌ Account number cannot be empty.\n\n" +
          "Please enter the account number:"
        );

      }


      const normalizedAccountNumber =
        normalizePaymentAccountNumber(

          text,

          pending.paymentTypeName,

          pending.paymentTypeAmharicName

        );


      const isMobile =
        String(
          pending.paymentTypeName || ""
        )
          .trim()
          .toLowerCase() ===
          "mobile" ||

        String(
          pending.paymentTypeAmharicName || ""
        ).trim() ===
          "ሞባይል";


      // Mobile numbers MUST be valid Ethiopian numbers.
      if (
        isMobile &&
        !normalizedAccountNumber
      ) {

        return ctx.reply(

          "❌ Invalid Ethiopian mobile number.\n\n" +

          "Please enter a valid number such as:\n" +
          "`0912345678`\n" +
          "`+251912345678`\n" +
          "`251912345678`",

          {
            parse_mode:
              "Markdown"
          }

        );

      }


      if (
        !normalizedAccountNumber
      ) {

        return ctx.reply(
          "❌ Invalid account number.\n\n" +
          "Please enter the account number again."
        );

      }


      pending.accountNumber =
        normalizedAccountNumber;


      pending.step =
        "initial_balance";


      return ctx.reply(

        "💰 Please enter the *initial balance* in ETB.\n\n" +

        "Example:\n" +
        "`0`\n" +
        "`5000`\n" +
        "`12500.50`",

        {
          parse_mode:
            "Markdown"
        }

      );

    }


    // ==========================================================
    // STEP 3 — INITIAL BALANCE
    // ==========================================================

    if (
      pending.step ===
      "initial_balance"
    ) {

      const initialBalance =
        Number(
          text.replace(
            /,/g,
            ""
          )
        );


      if (
        !Number.isFinite(
          initialBalance
        ) ||
        initialBalance < 0
      ) {

        return ctx.reply(

          "❌ Invalid balance.\n\n" +

          "Please enter a number greater than or equal to 0.\n\n" +

          "Example:\n" +
          "`0`\n" +
          "`5000`\n" +
          "`12500.50`",

          {
            parse_mode:
              "Markdown"
          }

        );

      }


      try {

        const result =
          await db.createPaymentAccount(

            pending.paymentMethodId,

            pending.accountName,

            pending.accountNumber,

            initialBalance

          );


        if (
          !result ||
          result.success !== true
        ) {

          return ctx.reply(

            `❌ ${result?.message || "Could not create payment account."}`

          );

        }


        delete pendingAdminAccount[
          telegramId
        ];


        const account =
          result.account;


        await ctx.reply(

          "✅ *PAYMENT ACCOUNT CREATED*\n\n" +

          `💳 Method: *${account.pm_amharic_name || account.pm_name}*\n` +

          `📂 Type: *${account.pt_amharic_name || account.pt_name || "-"}*\n` +

          `👤 Name: *${account.account_name}*\n` +

          `📱 Account: \`${account.account_number}\`\n` +

          `💰 Initial Balance: *${account.balance} ETB*\n` +

          "📌 Status: 🟢 *Active*",

          {

            parse_mode:
              "Markdown",

            reply_markup: {

              inline_keyboard: [

                [

                  {

                    text:
                      "💳 Accounts",

                    callback_data:
                      "admin_accounts"

                  }

                ],

                [

                  {

                    text:
                      "🏠 Home",

                    callback_data:
                      "admin_home"

                  }

                ]

              ]

            }

          }

        );

      } catch (err) {

        console.error(
          "Create payment account error:",
          err
        );

        await ctx.reply(

          "❌ Could not create the payment account.\n\n" +
          "Please try again."

        );

      }

      return;

    }


    return next();

  }
);

// ============================================================
// /START
// ============================================================

bot.command(
  "start",
  async (ctx) => {

    const telegramId =
      ctx.from.id;

    const firstName =
      ctx.from.first_name ||
      "Player";


    clearPendingState(
      telegramId
    );

    delete pendingPhone[
      telegramId
    ];

    delete pendingAdminReject[
      telegramId
    ];


    try {

      const existing =
  await db.getUserByTelegramIdIncludingInactive(
    telegramId
  );

if (existing) {

  // Banned users should remain blocked
  if (existing.is_blocked === true) {

   return ctx.reply(
    "🚫 Your account has been blocked. Please contact support."
  );

  }

  // Reactivate previously deleted account
  if (existing.is_active === false) {

    const reactivated =
      await db.reactivateUserByTelegramId(
        telegramId
      );

    if (!reactivated) {

      return await ctx.reply(
        "❌ Could not reactivate your account."
      );

    }

    await ctx.reply(
      "✅ *Welcome back!*\n\n" +
      "Your Sisters Bingo account has been reactivated. 🎱",
      {
        parse_mode: "Markdown"
      }
    );

    return await showHome(
      ctx,
      reactivated
    );
  }

  return await showHome(
    ctx,
    existing
  );
}


      // ------------------------------------------------------
      // New user
      // ------------------------------------------------------

      pendingPhone[
        telegramId
      ] = {

        name:
          firstName,

        step:
          "ask_name"

      };


      await ctx.reply(

        `👋 Welcome to *Sisters Bingo!*\n\n` +

        `Let's get you registered.\n` +

        `What should we call you?`,

        {

          parse_mode:
            "Markdown"

        }

      );

    } catch (err) {

      console.error(
        "Start error:",
        err
      );

      await ctx.reply(
        "❌ Something went wrong. Please try again."
      );

    }

  }
);


// ============================================================
// REGISTRATION TEXT
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const telegramId =
      ctx.from.id;

    const text =
      ctx.message.text;


    const pending =
      pendingPhone[
        telegramId
      ];


    if (!pending) {

      return next();

    }


    if (
      pending.step === "ask_name" &&
      text &&
      !text.startsWith("/")
    ) {

      pending.name =
        text
          .trim()
          .substring(
            0,
            30
          );


      pending.step =
        "ask_phone";


      await ctx.reply(

        `Nice to meet you, *${pending.name}!*\n\n` +

        `Please share your phone number so we can verify your account:`,

        {

          parse_mode:
            "Markdown",

          reply_markup: {

            keyboard: [

              [

                {

                  text:
                    "📱 Share My Phone Number",

                  request_contact:
                    true

                }

              ]

            ],

            resize_keyboard:
              true,

            one_time_keyboard:
              true

          }

        }

      );


      return;

    }


    return next();

  }
);


// ============================================================
// REGISTRATION CONTACT
// ============================================================

bot.on(
  "message:contact",
  async (ctx) => {

    const telegramId =
      ctx.from.id;


    const pending =
      pendingPhone[
        telegramId
      ];


    if (
      !pending ||
      pending.step !== "ask_phone"
    ) {

      return;

    }


    const contact =
      ctx.message.contact;


    const phone =
      contact.phone_number;


    const name =
      pending.name;


    if (
      contact.user_id &&
      contact.user_id !== telegramId
    ) {

      return ctx.reply(
        "❌ Please use the button to share your own phone number."
      );

    }


    try {

      const result =
        await db.registerUser(
          telegramId,
          name,
          phone
        );


      const user =
        result.user;


      delete pendingPhone[
        telegramId
      ];


      await ctx.reply(

        `✅ *Registered successfully!*\n\n` +

        `Name: *${user.name}*\n` +

        `Phone: ${phone}\n` +

        `Starting balance: *${user.balance} ETB*\n\n` +

        `You're all set! 🎱`,

        {

          parse_mode:
            "Markdown"

        }

      );


      await showHome(
        ctx,
        user
      );


    } catch (err) {

      console.error(
        "Registration error:",
        err
      );

      await ctx.reply(
        "❌ Registration failed. Please try /start again."
      );

    }

  }
);


// ============================================================
// BALANCE
// ============================================================

async function showBalance(
  ctx
) {

  const user =
    await db.getUserByTelegramId(
      ctx.from.id
    );


  if (!user) {

    return ctx.reply(
      "Please /start to register first."
    );

  }


  await ctx.reply(

    `💰 Your balance: *${user.balance} ETB*`,

    {

      parse_mode:
        "Markdown"

    }

  );

}


bot.command(
  "balance",
  showBalance
);

bot.hears(
  "balance",
  showBalance
);

bot.hears(
  "💰 Balance",
  showBalance
);


bot.callbackQuery(
  "balance",
  async (ctx) => {

    await answerCallback(
      ctx
    );

    clearPendingState(
      ctx.from.id
    );

    await showBalance(
      ctx
    );

  }
);


// ============================================================
// TRANSFER
// ============================================================

async function showTransfer(
  ctx
) {

  const telegramId =
    ctx.from.id;


  const user =
    await db.getUserByTelegramId(
      telegramId
    );


  if (!user) {

    return ctx.reply(
      "Please /start to register first."
    );

  }


  if (
    Number(user.balance) <= 10
  ) {

    return ctx.reply(
      "❌ ያሎት ሂሳብ ለሌላ ተጫዋች ለማስተላለፍ በቂ አይደለም።"
    );

  }


  delete pendingTransfer[
    telegramId
  ];


  pendingTransfer[
    telegramId
  ] = {

    step:
      "phone"

  };


  await ctx.reply(

    "🔄 *ብር ማስተላለፍ*\n\n" +

    "ማስተላለፍ የሚፈልጉትን ተጫዋች ስልክ ቁጥር ያስገቡ።\n\n" +

    "ምሳሌ፦ `0912345678`",

    {

      parse_mode:
        "Markdown"

    }

  );

}


bot.command(
  "transfer",
  showTransfer
);

bot.hears(
  "transfer",
  showTransfer
);

bot.hears(
  "🔄 Transfer",
  showTransfer
);


bot.callbackQuery(
  "transfer",
  async (ctx) => {

    await answerCallback(
      ctx
    );

    clearPendingState(
      ctx.from.id
    );

    await showTransfer(
      ctx
    );

  }
);


// ============================================================
// TRANSFER PHONE
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const telegramId =
      ctx.from.id;

    const text =
      ctx.message.text.trim();


    const transfer =
      pendingTransfer[
        telegramId
      ];


    if (!transfer) {

      return next();

    }


    if (
      transfer.step !== "phone"
    ) {

      return next();

    }


    if (
      text.startsWith("/")
    ) {

      return next();

    }


    try {

      const phone =
        normalizeEthiopianPhone(
          text
        );


      if (!phone) {

        return ctx.reply(

          "❌ እባክዎ ትክክለኛ የስልክ ቁጥር ያስገቡ።\n\n" +

          "ምሳሌ፦ `0912345678`",

          {

            parse_mode:
              "Markdown"

          }

        );

      }


      const sender =
        await db.getUserByTelegramId(
          telegramId
        );


      if (!sender) {

        delete pendingTransfer[
          telegramId
        ];

        return ctx.reply(
          "❌ አካውንትዎ አልተገኘም። /start ብለው እንደገና ይጀምሩ።"
        );

      }


      const recipient =
        await db.getUserByPhone(
          phone
        );


      if (!recipient) {

        return ctx.reply(
          "❌ ይህ ስልክ ቁጥር በሲስተማችን ውስጥ አልተመዘገበም።"
        );

      }


      if (
        Number(recipient.telegram_id) ===
        Number(sender.telegram_id)
      ) {

        return ctx.reply(
          "❌ ወደራስዎ ሂሳብ ብር ማስተላለፍ አይችሉም።"
        );

      }


      pendingTransfer[
        telegramId
      ] = {

        step:
          "amount",

        recipient

      };


      await ctx.reply(

        "✅ *ተጫዋቹ ተረጋግጧል።*\n\n" +

        `👤 ተቀባይ፦ *${recipient.name}*\n` +

        `📱 ስልክ፦ ${phone}\n\n` +

        "💰 ማስተላለፍ የሚፈልጉትን የብር መጠን ያስገቡ።",

        {

          parse_mode:
            "Markdown"

        }

      );

    } catch (err) {

      console.error(
        "Transfer phone error:",
        err
      );

      await ctx.reply(
        "❌ የተጫዋቹን ስልክ ማረጋገጥ አልተቻለም።"
      );

    }

  }
);


// ============================================================
// TRANSFER AMOUNT
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const telegramId =
      ctx.from.id;

    const text =
      ctx.message.text.trim();


    const transfer =
      pendingTransfer[
        telegramId
      ];


    if (!transfer) {

      return next();

    }


    if (
      transfer.step !== "amount"
    ) {

      return next();

    }


    if (
      text.startsWith("/")
    ) {

      return next();

    }


    try {

      const amount =
        Number(text);


      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return ctx.reply(
          "❌ እባክዎ ትክክለኛ የብር መጠን ያስገቡ።"
        );

      }


      if (
        !Number.isInteger(amount)
      ) {

        return ctx.reply(
          "❌ የሚያስተላልፉት የብር መጠን ሙሉ ቁጥር መሆን አለበት።"
        );

      }


      if (
        amount < 10
      ) {

        return ctx.reply(
          "❌ ቢያንስ 10 ብር ማስተላለፍ ይችላሉ።"
        );

      }


      const sender =
        await db.getUserByTelegramId(
          telegramId
        );


      if (!sender) {

        delete pendingTransfer[
          telegramId
        ];

        return ctx.reply(
          "❌ አካውንትዎ አልተገኘም።"
        );

      }


      const balance =
        Number(sender.balance);


      if (
        amount > balance - 10
      ) {

        return ctx.reply(

          `❌ በቂ ሂሳብ የሎትም።\n\n` +

          `💰 ያለዎት ሂሳብ፦ ${balance} ETB\n` +

          `💸 የፈለጉት፦ ${amount} ETB`

        );

      }


      const recipient =
        transfer.recipient;


      const result =
        await db.transferBalance(
          sender.telegram_id,
          recipient.telegram_id,
          amount
        );


      if (
        !result.success
      ) {

        return ctx.reply(
          `❌ ${result.message || "ማስተላለፉ አልተሳካም።"}`
        );

      }


      delete pendingTransfer[
        telegramId
      ];


      await ctx.reply(

        "✅ *ማስተላለፉ ተሳክቷል!*\n\n" +

        `👤 ተቀባይ፦ *${recipient.name}*\n` +

        `💸 የተላከው፦ *${amount} ETB*\n\n` +

        `💰 አዲሱ ቀሪ ሂሳብ፦ *${result.senderAfter} ETB*`,

        {

          parse_mode:
            "Markdown"

        }

      );


      try {

        await bot.api.sendMessage(

          recipient.telegram_id,

          "💰 *ብር ደርሶዎታል!*\n\n" +

          `👤 ከ፦ *${sender.name}*\n` +

          `💵 የደረሰዎት፦ *${amount} ETB*\n\n` +

          `💰 አዲሱ ቀሪ ሂሳብ፦ *${result.recipientAfter} ETB*`,

          {

            parse_mode:
              "Markdown"

          }

        );

      } catch (err) {

        console.error(
          "Recipient notification error:",
          err
        );

      }

    } catch (err) {

      console.error(
        "Transfer amount error:",
        err
      );

      await ctx.reply(
        "❌ ማስተላለፉን ማከናወን አልተቻለም።"
      );

    }

  }
);


// ============================================================
// DEPOSIT
// ============================================================

async function showDeposit(
  ctx
) {

  const user =
    await db.getUserByTelegramId(
      ctx.from.id
    );


  if (!user) {

    return ctx.reply(
      "Please /start to register first."
    );

  }


  const paymentmethods =
    await db.getPaymentMethods();


  const paymentmethodtypes =
    await db.getPaymentMethodTypes();


  if (
    !paymentmethodtypes ||
    paymentmethodtypes.length === 0 ||
    !paymentmethods ||
    paymentmethods.length === 0
  ) {

    return ctx.reply(
      "ይቅርታ! ለጊዜው የክፍያ መንገድ አልተዘጋጀም።"
    );

  }


  let mes =
    "❇️ ብር ማስገባት የሚችሉት ቀጥሎ ";


  const some =
    paymentmethods.length <= 1
      ? "በተቀመጠው "
      : "በተቀመጡት ";


  const meslast =
    paymentmethods.length <= 1
      ? "አማራጭ"
      : "አማራጮች";


  mes += some;


  if (
    paymentmethodtypes.length === 1
  ) {

    mes +=
      paymentmethodtypes[0]
        .amharic_name;

  } else {

    const typeNames =
      paymentmethodtypes.map(
        type =>
          `የ${type.amharic_name}`
      );


    const last =
      typeNames.pop();


    mes +=
      typeNames.join(", ") +
      " እና " +
      last;

  }


  mes +=
    ` ክፍያ ${meslast} ብቻ ነው።\n\n`;


  mes +=
    "🚫 ከዚህ ዉጭ የላከ አናስተናግድም 🚫\n\n";


  const buttons =
    paymentmethods.map(
      pm => [

        {

          text:
            `${pm.emoji} ${pm.amharic_name}`,

          callback_data:
            `payment_${pm.id}`

        }

      ]
    );


  buttons.push([

    {

      text:
        "❌ ሰርዝ",

      callback_data:
        "canceldeposit"

    }

  ]);


  await ctx.reply(
    mes,
    {

      parse_mode:
        "Markdown",

      reply_markup: {

        inline_keyboard:
          buttons

      }

    }
  );

}


bot.command(
  "deposit",
  showDeposit
);

bot.hears(
  "deposit",
  showDeposit
);


bot.callbackQuery(
  "deposit",
  async (ctx) => {

    await answerCallback(
      ctx
    );

    clearPendingState(
      ctx.from.id
    );

    await showDeposit(
      ctx
    );

  }
);


// ============================================================
// PAYMENT METHOD
// ============================================================

bot.callbackQuery(
  /^payment_(\d+)$/,
  async (ctx) => {

    await answerCallback(
      ctx
    );


    const paymentMethodId =
      Number(
        ctx.match[1]
      );


    try {

      const paymentMethod =
        await db.getPaymentMethodById(
          paymentMethodId
        );


      if (!paymentMethod) {

        return ctx.reply(
          "❌ የክፍያ መንገዱ አልተገኘም።"
        );

      }


      if (
        paymentMethod.name
          .toLowerCase()
          .includes("telebirr")
      ) {

        pendingDeposit[
          ctx.from.id
        ] = true;


        const paymentaccount =
          await db.getPaymentAccount(
            paymentMethod.id
          );


        if (!paymentaccount) {

          return ctx.reply(
            "❌ የቴሌብር አካውንት አማራጭ አልተገኘም።"
          );

        }


        await ctx.editMessageText(

          "1. ከታች ባለው የ" +

          paymentMethod.amharic_name +

          " አካውንት ብር ያስገቡ\n\n" +

          "📞 *" +

          paymentMethod.name +

          ":* `" +

          paymentaccount.account_number +

          "`\n\n" +

          "2. የከፈሉበትን አጭር የጹሁፍ መልዕክት (SMS) " +

          "copy በማድረግ እዚህ ላይ Paste አድርገው " +

          "ያስገቡና ይላኩት👇👇👇",

          {

            parse_mode:
              "Markdown"

          }

        );
        setTimeout(async () => {
        try {
          await ctx.deleteMessage();
        } catch (err) {
          console.error("Could not delete message:", err);
        }
      }, 5000);


        return;

      }


      await ctx.editMessageText(

        `${paymentMethod.emoji || "💳"} ` +

        `${paymentMethod.amharic_name}\n\n` +

        `ይህ የክፍያ መንገድ በቅርቡ ይጀምራል။`

      );

    } catch (err) {

      console.error(
        "Payment method error:",
        err
      );

      await ctx.reply(
        "❌ የክፍያ መንገዱን ማስኬድ አልተቻለም።"
      );

    }

  }
);


// ============================================================
// DEPOSIT SMS
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const telegramId =
      ctx.from.id;

    const text =
      ctx.message.text;


    if (
      !pendingDeposit[
        telegramId
      ]
    ) {

      return next();

    }


    try {

      await ctx.reply(
        "✅⏳ የክፍያ መልዕክትዎ ደርሶናል። ክፍያዎ እየተረጋገጠ ነው። እባክዎ ትንሽ ይጠብቁ።"
      );


      const result =
        await processDeposit(
          text
        );


      if (
        typeof result === "object" &&
        result !== null
      ) {

        const receipt =
          result.receipt;


        if (!receipt) {

          return ctx.reply(
            "❌ የክፍያ ደረሰኝ መረጃ አልተገኘም።"
          );

        }


        const result2 =
          await db.approveDeposit(
            receipt,
            telegramId
          );


        if (
          result2 > 0
        ) {

          clearPendingState(
            telegramId
          );


          return ctx.reply(

            "✅ *የገቢ ጥያቄዎ ተሳክቷል!*\n\n" +

            `💰 ${result2} ብር ወደ ሂሳብዎ ተጨምሯል።`,

            {

              parse_mode:
                "Markdown"

            }

          );

        }


        return ctx.reply(
          "❌ የገቢ ጥያቄዎ አልተሳካም።"
        );

      }


      return ctx.reply(

        "🚫 ጥያቄው አልተሳካም። " +

        "እባክዎ ትክክለኛውን SMS ይላኩ።"

      );

    } catch (err) {

      console.error(
        "Deposit processing error:",
        err
      );

      await ctx.reply(
        "❌ የክፍያውን ማረጋገጥ አልተቻለም።"
      );

    }

  }
);


// ============================================================
// CANCEL DEPOSIT
// ============================================================

bot.callbackQuery(
  "canceldeposit",
  async (ctx) => {

    await answerCallback(
      ctx
    );


    clearPendingState(
      ctx.from.id
    );


    try {

      await ctx.editMessageText(
        "የገቢ ጥያቄዎ ተሰርዟል። ❌"
      );

    } catch {

      await ctx.reply(
        "የገቢ ጥያቄዎ ተሰርዟል። ❌"
      );

    }

  }
);


// ============================================================
// WITHDRAWAL
// ============================================================

async function showWithdrawal(
  ctx
) {

  const telegramId =
    ctx.from.id;


  const user =
    await db.getUserByTelegramId(
      telegramId
    );


  if (!user) {

    return ctx.reply(
      "Please /start to register first."
    );

  }


  const balance =
    Number(user.balance);


  if (
    balance < 10
  ) {

    return ctx.reply(

      "❌ በቂ ቀሪ ሂሳብ የሎትም።\n\n" +

      `💰 ያለዎት ሂሳብ፦ ${balance} ETB\n\n` +

      "ዝቅተኛው የመውጫ መጠን 10 ETB ነው።"

    );

  }


  const paymentMethods =
    await db.getPaymentMethods();


  if (
    !paymentMethods ||
    paymentMethods.length === 0
  ) {

    return ctx.reply(
      "❌ ለጊዜው የመውጫ የክፍያ መንገድ አልተዘጋጀም።"
    );

  }


  pendingWithdrawal[
    telegramId
  ] = {

    step:
      "payment_method"

  };


  const buttons =
    paymentMethods.map(
      pm => [

        {

          text:
            `${pm.emoji || "💳"} ${pm.amharic_name}`,

          callback_data:
            `withdraw_method_${pm.id}`

        }

      ]
    );


  buttons.push([

    {

      text:
        "❌ ሰርዝ",

      callback_data:
        "cancelwithdrawal"

    }

  ]);


  await ctx.reply(

    "🏧 *ብር ማውጣት*\n\n" +

    "እባክዎ ብርዎን ለመቀበል የሚፈልጉትን የክፍያ መንገድ ይምረጡ።",

    {

      parse_mode:
        "Markdown",

      reply_markup: {

        inline_keyboard:
          buttons

      }

    }

  );

}


bot.command(
  "withdraw",
  showWithdrawal
);

bot.hears(
  "withdraw",
  showWithdrawal
);

bot.hears(
  "🏧 Withdraw",
  showWithdrawal
);


bot.callbackQuery(
  "withdraw",
  async (ctx) => {

    await answerCallback(
      ctx
    );

    clearPendingState(
      ctx.from.id
    );

    await showWithdrawal(
      ctx
    );

  }
);


// ============================================================
// WITHDRAWAL PAYMENT METHOD
// ============================================================

bot.callbackQuery(
  /^withdraw_method_(\d+)$/,
  async (ctx) => {

    await answerCallback(
      ctx
    );


    const telegramId =
      ctx.from.id;


    const methodId =
      Number(
        ctx.match[1]
      );


    const pending =
      pendingWithdrawal[
        telegramId
      ];


    if (!pending) {

      return ctx.reply(
        "❌ የመውጫ ጥያቄው ጊዜው አልፎበታል። /start ይጫኑ።"
      );

    }


    try {

      const paymentMethod =
        await db.getPaymentMethodById(
          methodId
        );


      if (!paymentMethod) {

        return ctx.reply(
          "❌ የክፍያ መንገዱ አልተገኘም።"
        );

      }


      pendingWithdrawal[
        telegramId
      ] = {

        step:
          "account",

        paymentMethodId:
          methodId,

        paymentMethod

      };


      await ctx.editMessageText(

        "🏧 *የመውጫ አካውንት*\n\n" +

        `💳 የክፍያ መንገድ፦ *${paymentMethod.amharic_name}*\n\n` +

        "📱 ብር የሚቀበሉበትን የአካውንት ቁጥር ያስገቡ።\n\n" +

        "ምሳሌ፦ `0912345678`",

        {

          parse_mode:
            "Markdown"

        }

      );

    } catch (err) {

      console.error(
        "Withdrawal method error:",
        err
      );

      await ctx.reply(
        "❌ የክፍያ መንገዱን ማስኬድ አልተቻለም።"
      );

    }

  }
);


// ============================================================
// WITHDRAWAL ACCOUNT
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const telegramId =
      ctx.from.id;


    const text =
      ctx.message.text.trim();


    const withdrawal =
      pendingWithdrawal[
        telegramId
      ];


    if (!withdrawal) {

      return next();

    }


    if (
      withdrawal.step !==
      "account"
    ) {

      return next();

    }


    if (
      text.startsWith("/")
    ) {

      return next();

    }


    const accountNumber =
      text.replace(
        /[\s\-()]/g,
        ""
      );


    if (
      !accountNumber
    ) {

      return ctx.reply(
        "❌ እባክዎ ትክክለኛ የአካውንት ቁጥር ያስገቡ።"
      );

    }


    if (
      accountNumber.length > 20
    ) {

      return ctx.reply(
        "❌ የአካውንት ቁጥሩ ከ20 ፊደል/ቁጥር መብለጥ አይችልም።"
      );

    }


    pendingWithdrawal[
      telegramId
    ] = {

      ...withdrawal,

      step:
        "amount",

      accountNumber

    };


    await ctx.reply(

      "✅ *የአካውንት ቁጥር ተቀብለናል።*\n\n" +

      `📱 አካውንት፦ *${accountNumber}*\n\n` +

      "💰 አሁን ማውጣት የሚፈልጉትን የብር መጠን ያስገቡ።\n\n" +

      "ምሳሌ፦ `100`",

      {

        parse_mode:
          "Markdown"

      }

    );

  }
);


// ============================================================
// WITHDRAWAL AMOUNT
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const telegramId =
      ctx.from.id;


    const text =
      ctx.message.text.trim();


    const withdrawal =
      pendingWithdrawal[
        telegramId
      ];


    if (!withdrawal) {

      return next();

    }


    if (
      withdrawal.step !==
      "amount"
    ) {

      return next();

    }


    if (
      text.startsWith("/")
    ) {

      return next();

    }


    try {

      const amount =
        Number(text);


      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return ctx.reply(
          "❌ እባክዎ ትክክለኛ የብር መጠን ያስገቡ።\n\nምሳሌ፦ `100`"
        );

      }


      if (
        !Number.isInteger(amount)
      ) {

        return ctx.reply(
          "❌ የመውጫ መጠኑ ሙሉ ቁጥር መሆን አለበት።"
        );

      }


      if (
        amount < 10
      ) {

        return ctx.reply(
          "❌ ቢያንስ 10 ETB ማውጣት ይችላሉ።"
        );

      }


      const user =
        await db.getUserByTelegramId(
          telegramId
        );


      if (!user) {

        delete pendingWithdrawal[
          telegramId
        ];

        return ctx.reply(
          "❌ አካውንትዎ አልተገኘም።"
        );

      }


      const balance =
        Number(user.balance);


      if (
        amount > balance
      ) {

        return ctx.reply(

          `❌ በቂ ሂሳብ የሎትም።\n\n` +

          `💰 ያለዎት ሂሳብ፦ ${balance} ETB\n` +

          `💸 ለማውጣት የፈለጉት፦ ${amount} ETB`

        );

      }


      const result =
        await db.createWithdrawal(

          telegramId,

          withdrawal.paymentMethodId,

          withdrawal.accountNumber,

          amount

        );


      if (
        !result.success
      ) {

        return ctx.reply(
          `❌ ${result.message}`
        );

      }


      delete pendingWithdrawal[
        telegramId
      ];


      await ctx.reply(

        "✅ *የመውጫ ጥያቄዎ ተቀብለናል!*\n\n" +

        `💳 የክፍያ መንገድ፦ *${withdrawal.paymentMethod.amharic_name}*\n` +

        `📱 አካውንት፦ *${withdrawal.accountNumber}*\n` +

        `💰 መጠን፦ *${amount} ETB*\n\n` +

        "⏳ ጥያቄዎ በአስተዳዳሪ እየተገመገመ ነው።",

        {

          parse_mode:
            "Markdown"

        }

      );

    } catch (err) {

      console.error(
        "Withdrawal amount error:",
        err
      );

      await ctx.reply(
        "❌ የመውጫ ጥያቄውን ማስኬድ አልተቻለም።"
      );

    }

  }
);


// ============================================================
// CANCEL WITHDRAWAL
// ============================================================

bot.callbackQuery(
  "cancelwithdrawal",
  async (ctx) => {

    await answerCallback(
      ctx
    );


    delete pendingWithdrawal[
      ctx.from.id
    ];


    try {

      await ctx.editMessageText(
        "❌ የመውጫ ጥያቄዎ ተሰርዟል።"
      );

    } catch {

      await ctx.reply(
        "❌ የመውጫ ጥያቄዎ ተሰርዟል።"
      );

    }

  }
);


// ============================================================
// ADMIN — PENDING WITHDRAWALS
// PAYMENT METHOD → PAYMENT ACCOUNT → PENDING LIST
// ============================================================

async function showAdminPaymentMethods(ctx) {

  const admin = await requireAdmin(ctx);

  if (!admin) {
    return;
  }

  const paymentMethods =
    await db.getPaymentMethods();

  if (
    !paymentMethods ||
    paymentMethods.length === 0
  ) {

    return ctx.reply(
      "❌ No active payment methods are available."
    );

  }

  const keyboard =
    paymentMethods.map(pm => [

      {
        text:
          `${pm.emoji || "💳"} ${pm.amharic_name || pm.name}`,

        callback_data:
          `admin_pending_method_${pm.id}`
      }

    ]);

  keyboard.push([

    {
      text:
        "🏠 Home",

      callback_data:
        "admin_home"
    }

  ]);

  await ctx.reply(

    "👑 *PENDING WITHDRAWALS*\n\n" +

    "First select the payment method you will use to process the withdrawals:",

    {

      parse_mode:
        "Markdown",

      reply_markup: {

        inline_keyboard:
          keyboard

      }

    }

  );

}


// ============================================================
// ADMIN PENDING BUTTON
// ============================================================

bot.callbackQuery(
  "admin_withdrawals",
  async (ctx) => {

    const admin = await requireAdminPermission(
    ctx,
    "withdrawals"
);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    // Clear previous payment account selection
    delete pendingAdminWithdrawal[
      admin.telegram_id
    ];

    try {

      await showAdminPaymentMethods(ctx);

    } catch (err) {

      console.error(
        "Admin payment method selection error:",
        err
      );

      await ctx.reply(
        "❌ Could not load payment methods."
      );

    }

  }
);


// ============================================================
// ADMIN — SELECT PAYMENT METHOD
// ============================================================

bot.callbackQuery(
  /^admin_pending_method_(\d+)$/,
  async (ctx) => {

    const admin =
      await requireAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const paymentMethodId =
      Number(ctx.match[1]);

    try {

      const paymentMethod =
        await db.getPaymentMethodById(
          paymentMethodId
        );

      if (!paymentMethod) {

        return ctx.reply(
          "❌ Payment method not found."
        );

      }

      const accounts =
        await db.getPaymentAccountsByMethod(
          paymentMethodId
        );

      if (
        !accounts ||
        accounts.length === 0
      ) {

        return ctx.reply(

          "❌ No active payment accounts are available for " +
          `${paymentMethod.amharic_name || paymentMethod.name}.`

        );

      }

      const keyboard =
        accounts.map(account => [

          {
            text:
              `${account.account_number} — ` +
              `${account.account_name || ""}`,

            callback_data:
              `admin_pending_account_${account.id}`
          }

        ]);

      keyboard.push([

        {
          text:
            "⬅️ Back",

          callback_data:
            "admin_withdrawals"
        }

      ]);

      await ctx.editMessageText(

        "👑 *SELECT PAYMENT ACCOUNT*\n\n" +

        `💳 Payment method: *${
          paymentMethod.amharic_name ||
          paymentMethod.name
        }*\n\n` +

        "Select the account that will be used to pay the approved withdrawals:",

        {

          parse_mode:
            "Markdown",

          reply_markup: {

            inline_keyboard:
              keyboard

          }

        }

      );

    } catch (err) {

      console.error(
        "Admin payment account selection error:",
        err
      );

      await ctx.reply(
        "❌ Could not load payment accounts."
      );

    }

  }
);


// ============================================================
// ADMIN — SELECT PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  /^admin_pending_account_(\d+)$/,
  async (ctx) => {

    const admin =
      await requireAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const paymentAccountId =
      Number(ctx.match[1]);

    try {

      const account =
        await db.getPaymentAccountById(
          paymentAccountId
        );

      if (!account) {

        return ctx.reply(
          "❌ Payment account not found."
        );

      }

      /*
       * Store the selected account for this admin.
       *
       * This remains selected while the admin
       * approves multiple withdrawal requests.
       */

      pendingAdminWithdrawal[
        admin.telegram_id
      ] = {

        paymentMethodId:
          account.payment_method_id,

        paymentAccountId:
          account.id,

        paymentAccount:
          account

      };

      await showPendingWithdrawals(
        ctx,
        true
      );

    } catch (err) {

      console.error(
        "Admin payment account selection error:",
        err
      );

      await ctx.reply(
        "❌ Could not select the payment account."
      );

    }

  }
);


// ============================================================
// SHOW MAXIMUM 5 PENDING WITHDRAWALS
// ============================================================

async function showPendingWithdrawals(
  ctx,
  editMessage = false
) {

  const admin =
    await requireAdmin(ctx);

  if (!admin) {
    return;
  }

  const adminState =
    pendingAdminWithdrawal[
      admin.telegram_id
    ];

  if (!adminState) {

    return showAdminPaymentMethods(ctx);

  }

  const withdrawals =
    await db.getPendingWithdrawals(
      5
    );

  const account =
    adminState.paymentAccount;

  let message =

    "👑 *PENDING WITHDRAWALS*\n\n" +

    "━━━━━━━━━━━━━━━━━━━━\n" +

    `💳 Method: *${
      account.pm_amharic_name ||
      account.pm_name ||
      "Unknown"
    }*\n` +

    `📱 Payment Account: \`${account.account_number}\`\n` +

    `💰 Available: *${account.balance} ETB*\n` +

    "━━━━━━━━━━━━━━━━━━━━\n\n";

  if (
    !withdrawals ||
    withdrawals.length === 0
  ) {

    message +=
      "✅ There are no pending withdrawals.";

  } else {

    withdrawals.forEach(
      (w, index) => {

        const created =
          w.created_at
            ? new Date(
                w.created_at
              ).toLocaleString(
                "en-GB"
              )
            : "";

        message +=

          `${index + 1}. 🆔 *#${w.id}*\n` +

          `👤 ${w.name || "Unknown"}\n` +

          `💳 ${
            w.payment_method_amharic ||
            w.payment_method ||
            "Unknown"
          }\n` +

          `📱 Recipient: \`${w.account_number}\`\n` +

          `💰 *${w.amount} ETB*\n` +

          `${created
            ? `📅 ${created}\n`
            : ""}` +

          "\n";

      }
    );

  }

  const keyboard = [];

  for (
    const w of withdrawals
  ) {

    keyboard.push([

      {
        text:
          `✅ Approve #${w.id}`,

        callback_data:
          `approve_withdrawal_${w.id}`
      },

      {
        text:
          `❌ Reject #${w.id}`,

        callback_data:
          `reject_withdrawal_${w.id}`
      }

    ]);

  }

  keyboard.push([

    {
      text:
        "💳 Change Account",

      callback_data:
        "admin_withdrawals"
    },

    {
      text:
        "🔄 Refresh",

      callback_data:
        "admin_pending_refresh"
    }

  ]);

  keyboard.push([

    {
      text:
        "🏠 Home",

      callback_data:
        "admin_home"
    }

  ]);

  const options = {

    parse_mode:
      "Markdown",

    reply_markup: {

      inline_keyboard:
        keyboard

    }

  };

  if (editMessage) {

    try {

      await ctx.editMessageText(
        message,
        options
      );

      return;

    } catch (err) {

      // If the message cannot be edited,
      // send a new message instead.

      console.log(
        "Pending message edit failed:",
        err.description ||
        err.message
      );

    }

  }

  await ctx.reply(
    message,
    options
  );

}


// ============================================================
// ADMIN — REFRESH PENDING LIST
// ============================================================

bot.callbackQuery(
  "admin_pending_refresh",
  async (ctx) => {

    const admin =
      await requireAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    await showPendingWithdrawals(
      ctx,
      true
    );

  }
);

// ============================================================
// ADMIN PENDING BUTTON
// ============================================================

bot.callbackQuery(
  "admin_withdrawals",
  async (ctx) => {

    const admin =
      await requireAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    await answerCallback(
      ctx
    );


    try {

      const withdrawals =
        await db.getPendingWithdrawals(
          20
        );


      let message =
        "👑 *PENDING WITHDRAWALS*\n\n";


      if (
        !withdrawals ||
        withdrawals.length === 0
      ) {

        message +=
          "There are no pending withdrawals.";

      } else {

        withdrawals.forEach(
          (w, index) => {

            const created =
              w.created_at
                ? new Date(
                    w.created_at
                  ).toLocaleString(
                    "en-GB"
                  )
                : "";


            message +=

              `${index + 1}. 🆔 *#${w.id}*\n` +

              `👤 ${w.name || "Unknown"}\n` +

              `💳 ${w.payment_method_amharic || w.payment_method || "Unknown"}\n` +

              `📱 \`${w.account_number}\`\n` +

              `💰 *${w.amount} ETB*\n` +

              `${created ? `📅 ${created}\n` : ""}` +

              "\n";

          }
        );

      }


      const keyboard = [];


      for (
        const w of withdrawals
      ) {

        keyboard.push([

          {

            text:
              `✅ Approve #${w.id}`,

            callback_data:
              `approve_withdrawal_${w.id}`

          },

          {

            text:
              `❌ Reject #${w.id}`,

            callback_data:
              `reject_withdrawal_${w.id}`

          }

        ]);

      }


      keyboard.push([

        {

          text:
            "🔄 Refresh",

          callback_data:
            "admin_withdrawals"

        },

        {

          text:
            "🏠 Home",

          callback_data:
            "admin_home"

        }

      ]);


      await ctx.editMessageText(

        message,

        {

          parse_mode:
            "Markdown",

          reply_markup: {

            inline_keyboard:
              keyboard

          }

        }

      );

    } catch (err) {

      console.error(
        "Admin withdrawal list error:",
        err
      );

      await ctx.reply(
        "❌ Could not load pending withdrawals."
      );

    }

  }
);


// ============================================================
// ADMIN HOME BUTTON
// ============================================================

bot.callbackQuery(
  "admin_home",
  async (ctx) => {
  await answerCallback(ctx);

  const telegramId = ctx.from.id;

  // Forget everything the admin was in the middle of doing
  clearPendingState(telegramId);


    const admin =
      await requireAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    try {

      /*
       * Use the currently logged-in admin's
       * Telegram ID.
       *
       * There is no hard-coded ADMIN_ID.
       */
      const user =
        await db.getUserByTelegramId(
          admin.telegram_id
        );


      if (!user) {

        return ctx.reply(
          "❌ Admin account was not found."
        );

      }

      await showHome(
        ctx,
        user
      );

    } catch (err) {

      console.error(
        "Admin home error:",
        err
      );

    }

  }
);


// ============================================================
// ADMIN APPROVE WITHDRAWAL
// ============================================================

bot.callbackQuery(
  /^approve_withdrawal_(\d+)$/,
  async (ctx) => {

    const admin =
      await requireAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    await answerCallback(
      ctx,
      "Approving..."
    );


    const withdrawalId =
      Number(
        ctx.match[1]
      );


    try {

      /*
       * IMPORTANT:
       *
       * Pass the CURRENT ADMIN'S Telegram ID.
       *
       * db.approveWithdrawal() should then:
       *
       * 1. Verify the Telegram ID belongs to an
       *    active, non-banned admin.
       *
       * 2. Store the actual users.id in
       *    withdrawals.approved_by_id.
       *
       * 3. Approve the withdrawal.
       *
       * 4. Deduct the user's balance only once.
       */

      const adminState =
  pendingAdminWithdrawal[
    admin.telegram_id
  ];

if (!adminState) {

  return ctx.reply(

    "❌ Please select a payment account first.\n\n" +
    "Press ⏳ Pending and select the payment account."

  );

}

const result =
  await db.approveWithdrawal(

    withdrawalId,

    admin.telegram_id,

    adminState.paymentAccountId

  );


      if (
        !result ||
        !result.success
      ) {

        return ctx.reply(
          `❌ ${result?.message || "Withdrawal approval failed."}`
        );

      }

pendingAdminWithdrawal[admin.telegram_id]
await ctx.reply(

  "✅ *WITHDRAWAL APPROVED*\n\n" +

  `🆔 #${withdrawalId}\n` +

  `👤 User: *${result.user_name}*\n` +

  `💰 Amount: *${result.amount} ETB*\n` +

  `📱 Recipient: \`${result.withdrawal.account_number}\`\n\n` +

  `💳 Paid from: \`${result.payment_account_number}\`\n` +

  `💰 Account balance after: *${result.payment_account_balance_after} ETB*\n\n` +

  `👑 Approved by: *${admin.name || admin.telegram_id}*`,

  {
    parse_mode:
      "Markdown"
  }

);
      


      // ------------------------------------------------------
      // Notify user
      // ------------------------------------------------------

      try {

        await bot.api.sendMessage(

          result.telegram_id,

          "✅ *የመውጫ ጥያቄዎ ጸድቋል!*\n\n" +

          `💰 መጠን፦ *${result.amount} ETB*\n` +

          `📱 አካውንት፦ \`${result.withdrawal.account_number}\`\n\n` +

          `💰 አዲሱ ቀሪ ሂሳብ፦ *${result.balance_after} ETB*`,

          {

            parse_mode:
              "Markdown"

          }

        );

      } catch (notifyError) {

        console.error(
          "Approval notification error:",
          notifyError
        );

      }


      // ------------------------------------------------------
      // Refresh pending list
      // ------------------------------------------------------

      await showPendingWithdrawals(
        ctx
      );

    } catch (err) {

      console.error(
        "Approve withdrawal error:",
        err
      );

      await ctx.reply(
        "❌ Withdrawal approval failed."
      );

    }

  }
);


// ============================================================
// ADMIN REJECT — ASK REASON
// ============================================================

bot.callbackQuery(
  /^reject_withdrawal_(\d+)$/,
  async (ctx) => {

    const admin =
      await requireAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    await answerCallback(
      ctx
    );


    const telegramId =
      admin.telegram_id;


    const withdrawalId =
      Number(
        ctx.match[1]
      );


    try {

      /*
       * Make sure the withdrawal actually exists
       * and is still pending before asking for a reason.
       */

      const withdrawals =
        await db.getPendingWithdrawals(
          100
        );


      const withdrawal =
        withdrawals.find(
          w =>
            Number(w.id) ===
            withdrawalId
        );


      if (!withdrawal) {

        return ctx.reply(
          "❌ This withdrawal is no longer pending."
        );

      }


      /*
       * Store rejection state under the
       * CURRENT ADMIN'S Telegram ID.
       *
       * This allows multiple admins to use the
       * bot independently.
       */

      pendingAdminReject[
        telegramId
      ] = {

        withdrawalId,

        withdrawal

      };


      await ctx.reply(

        "❌ *REJECT WITHDRAWAL*\n\n" +

        `🆔 Withdrawal: *#${withdrawalId}*\n` +

        `👤 User: *${withdrawal.name || "Unknown"}*\n` +

        `💰 Amount: *${withdrawal.amount} ETB*\n` +

        `📱 Account: \`${withdrawal.account_number}\`\n\n` +

        "📝 Please type the reason for rejection.\n\n" +

        "Example:\n" +

        "`የተላከው የአካውንት ቁጥር ትክክል አይደለም።`\n\n" +

        "❌ Send /cancel to cancel.",

        {

          parse_mode:
            "Markdown"

        }

      );

    } catch (err) {

      console.error(
        "Reject preparation error:",
        err
      );

      await ctx.reply(
        "❌ Could not prepare the withdrawal rejection."
      );

    }

  }
);


// ============================================================
// ADMIN REJECTION REASON
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const telegramId =
      ctx.from.id;


    /*
     * Check whether this Telegram user is
     * currently an authorized admin.
     *
     * No hard-coded ADMIN_ID.
     */

    const admin =
      await getCurrentAdmin(
        ctx
      );


    if (!admin) {

      return next();

    }


    const pending =
      pendingAdminReject[
        telegramId
      ];


    if (!pending) {

      return next();

    }


    const text =
      ctx.message.text.trim();


    // --------------------------------------------------------
    // Cancel rejection
    // --------------------------------------------------------

    if (
      text === "/cancel"
    ) {

      delete pendingAdminReject[
        telegramId
      ];


      return ctx.reply(
        "❌ Withdrawal rejection cancelled."
      );

    }


    // --------------------------------------------------------
    // Validate reason
    // --------------------------------------------------------

    if (!text) {

      return ctx.reply(
        "❌ Please enter a rejection reason."
      );

    }


    if (
      text.length < 2
    ) {

      return ctx.reply(
        "❌ Please provide a valid rejection reason."
      );

    }


    const withdrawalId =
      pending.withdrawalId;


    const reason =
      text.substring(
        0,
        500
      );


    /*
     * Clear state BEFORE database operation
     * so another message cannot accidentally
     * trigger the same rejection.
     */

    delete pendingAdminReject[
      telegramId
    ];


    try {

      /*
       * Pass the CURRENT ADMIN'S Telegram ID.
       *
       * db.rejectWithdrawal() should verify
       * that this Telegram ID is an active admin.
       */

      const result =
        await db.rejectWithdrawal(
          withdrawalId,
          admin.telegram_id,
          reason
        );


      if (
        !result ||
        !result.success
      ) {

        return ctx.reply(
          `❌ ${result?.message || "Withdrawal rejection failed."}`
        );

      }


      // ------------------------------------------------------
      // Tell admin
      // ------------------------------------------------------

      await ctx.reply(

        "❌ *WITHDRAWAL REJECTED*\n\n" +

        `🆔 #${withdrawalId}\n` +

        `👤 User: *${result.user_name || pending.withdrawal.name || "Unknown"}*\n` +

        `💰 Amount: *${result.amount || pending.withdrawal.amount} ETB*\n\n` +

        `📝 Reason:\n${reason}\n\n` +

        `👑 Rejected by: ${admin.name || admin.telegram_id}`,

        {

          parse_mode:
            "Markdown"

        }

      );


      // ------------------------------------------------------
      // Notify user
      // ------------------------------------------------------

      if (
        result.telegram_id
      ) {

        try {

          await bot.api.sendMessage(

            result.telegram_id,

            "❌ *የመውጫ ጥያቄዎ ውድቅ ተደርጓል።*\n\n" +

            `💰 መጠን፦ *${result.amount || pending.withdrawal.amount} ETB*\n\n` +

            "📝 *የውድቅ ምክንያት፦*\n" +

            `${reason}\n\n` +

            "💰 ምንም ብር ከሂሳብዎ አልተቀነሰም።",

            {

              parse_mode:
                "Markdown"

            }

          );

        } catch (notifyError) {

          console.error(
            "Rejection notification error:",
            notifyError
          );

        }

      }


      // ------------------------------------------------------
      // Show refreshed pending withdrawals
      // ------------------------------------------------------

      await showPendingWithdrawals(
        ctx
      );

    } catch (err) {

      console.error(
        "Reject withdrawal error:",
        err
      );

      await ctx.reply(
        "❌ Withdrawal rejection failed."
      );

    }

  }
);


// ============================================================
// SUPPORT
// ============================================================

async function showSupport(
  ctx
) {

  const user =
    await db.getUserByTelegramId(
      ctx.from.id
    );


  if (!user) {

    return ctx.reply(
      "Please /start to register first."
    );

  }


  await ctx.reply(

    "🆘 ድጋፍ ይፈልጋሉ?\n\n" +

    "👇 ለማንኛውም ጥያቄ ወይም አስተያየት 👇\n\n" +

    "👤 @sistersbingosupport"

  );

}


bot.command(
  "support",
  showSupport
);

bot.hears(
  "support",
  showSupport
);


bot.callbackQuery(
  "support",
  async (ctx) => {

    await answerCallback(
      ctx
    );

    clearPendingState(
      ctx.from.id
    );

    await showSupport(
      ctx
    );

  }
);

// ============================================================
// LEADERBOARD
// ============================================================

async function showLeaderboard(
  ctx
) {

  const rows =
    await db.getLeaderboard(
      10
    );


  const medals = [
    "🥇",
    "🥈",
    "🥉"
  ];


  const text =
    rows
      .map(
        (r, i) => {

          const position =
            medals[i] ||
            `${i + 1}.`;


          return (

            `${position} ` +

            `*${r.name}* — ` +

            `${r.total_winnings} ETB ` +

            `(${r.total_wins} wins)`

          );

        }
      )
      .join("\n");


  await ctx.reply(

    `🏆 *Leaderboard*\n\n` +

    `${text || "No games yet!"}`,

    {

      parse_mode:
        "Markdown"

    }

  );

}


bot.command(
  "leaderboard",
  showLeaderboard
);

bot.hears(
  "📊 Leaderboard",
  showLeaderboard
);


// ============================================================
// PLAY
// ============================================================

async function showPlay(
  ctx
) {

  const user =
    await db.getUserByTelegramId(
      ctx.from.id
    );


  if (!user) {

    return ctx.reply(
      "Please /start to register first."
    );

  }


  await ctx.reply(

    `Ready to play, *${user.name}*? 🎱\n` +

    `Balance: *${user.balance} ETB*`,

    {

      parse_mode:
        "Markdown",

      reply_markup: {

        inline_keyboard: [

          [

            {

              text:
                "🎮 Open Sisters Bingo",

              web_app: {

                url:
                  `${GAME_URL}?tid=${ctx.from.id}`

              }

            }

          ]

        ]

      }

    }

  );

}


bot.command(
  "play",
  showPlay
);

bot.hears(
  "🎮 Play",
  showPlay
);


// ============================================================
// ADMIN BROADCAST
// ============================================================

bot.callbackQuery(
  "admin_broadcast",
  async (ctx) => {

    const admin = await requireAdminPermission(
    ctx,
    "broadcast"
);



    if (!admin) {

      return;

    }


    await answerCallback(
      ctx
    );


    /*
     * Store the broadcast draft against
     * the CURRENT ADMIN'S Telegram ID.
     *
     * This means multiple admins can have
     * independent broadcast drafts.
     */

    await db.createBroadcastDraft(
      admin.telegram_id
    );


    await ctx.reply(

      "📢 *Broadcast mode started!*\n\n" +

      "Please send the image you want to broadcast.\n\n" +

      "❌ Send /cancel to cancel.",

      {

        parse_mode:
          "Markdown"

      }

    );

  }
);


// ============================================================
// BROADCAST IMAGE
// ============================================================

bot.on(
  "message:photo",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    const adminTelegramId =
      admin.telegram_id;


    const draft =
      await db.getBroadcastDraft(
        adminTelegramId
      );


    if (!draft) {

      return;

    }


    if (
      draft.status !==
      "waiting_image"
    ) {

      return;

    }


    const photo =
      ctx.message.photo[
        ctx.message.photo.length - 1
      ];


    const fileId =
      photo.file_id;


    await db.updateBroadcastImage(
      adminTelegramId,
      fileId
    );


    await ctx.reply(

      "✅ Image received!\n\n" +

      "Now send the message/caption you want to broadcast.\n\n" +

      "❌ Send /cancel to cancel."

    );

  }
);


// ============================================================
// BROADCAST TEXT
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    const admin =
      await getCurrentAdmin(
        ctx
      );


    if (!admin) {

      return next();

    }


    const adminTelegramId =
      admin.telegram_id;


    /*
     * Do not intercept rejection reason here.
     * The rejection handler above handles it first.
     */

    if (
      pendingAdminReject[
        adminTelegramId
      ]
    ) {

      return next();

    }


    const text =
      ctx.message.text.trim();


    if (
      text === "/cancel"
    ) {

      const draft =
        await db.getBroadcastDraft(
          adminTelegramId
        );


      if (!draft) {

        return next();

      }


      await db.deleteBroadcastDraft(
        adminTelegramId
      );


      return ctx.reply(
        "❌ Broadcast cancelled."
      );

    }


    const draft =
      await db.getBroadcastDraft(
        adminTelegramId
      );


    if (!draft) {

      return next();

    }


    if (
      draft.status !==
      "waiting_message"
    ) {

      return next();

    }


    await db.updateBroadcastMessage(
      adminTelegramId,
      text
    );


    const users =
      await db.getAllActiveUsers();


    /*
     * Preview is sent only to the CURRENT admin.
     */

    await bot.api.sendPhoto(

      adminTelegramId,

      draft.image_url,

      {

        caption:
          text,

        reply_markup: {

          inline_keyboard: [

            [

              {

                text:
                  "🎮 Play Now",

                web_app: {

                  url:
                    `${GAME_URL}?tid=${adminTelegramId}`

                }

              }

            ]

          ]

        }

      }

    );


    await ctx.reply(

      `📢 *BROADCAST PREVIEW*\n\n` +

      `👥 Recipients: ${users.length}\n\n` +

      `Are you sure you want to send this to everyone?`,

      {

        parse_mode:
          "Markdown",

        reply_markup: {

          inline_keyboard: [

            [

              {

                text:
                  "✅ SEND TO ALL",

                callback_data:
                  "broadcast_confirm"

              },

              {

                text:
                  "❌ CANCEL",

                callback_data:
                  "broadcast_cancel"

              }

            ]

          ]

        }

      }

    );

  }
);


// ============================================================
// BROADCAST CONFIRM
// ============================================================

bot.callbackQuery(
  "broadcast_confirm",
  async (ctx) => {

    const admin =
      await requireAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    await answerCallback(
      ctx
    );


    const adminTelegramId =
      admin.telegram_id;


    const draft =
      await db.getBroadcastDraft(
        adminTelegramId
      );


    if (!draft) {

      return ctx.editMessageText(
        "❌ Broadcast draft not found."
      );

    }


    if (
      !draft.image_url ||
      !draft.message
    ) {

      return ctx.editMessageText(
        "❌ Broadcast information is incomplete."
      );

    }


    const users =
      await db.getAllActiveUsers();


    let sent = 0;

    let failed = 0;


    await ctx.editMessageText(

      `📢 Broadcasting...\n\n` +

      `👥 Users: ${users.length}\n\n` +

      `⏳ Please wait...`

    );


    for (
      const user of users
    ) {

      try {

        await bot.api.sendPhoto(

          user.telegram_id,

          draft.image_url,

          {

            caption:
              draft.message,

            reply_markup: {

              inline_keyboard: [

                [

                  {

                    text:
                      "🎮 Play Now",

                    web_app: {

                      url:
                        `${GAME_URL}?tid=${user.telegram_id}`

                    }

                  }

                ]

              ]

            }

          }

        );


        sent++;


        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              40
            )
        );

      } catch (err) {

        failed++;


        console.error(

          `❌ Failed to send to ${user.telegram_id}:`,

          err.description ||
          err.message

        );

      }

    }


    await db.deleteBroadcastDraft(
      adminTelegramId
    );


    await ctx.reply(

      `📢 *Broadcast completed!*\n\n` +

      `👥 Total: ${users.length}\n` +

      `✅ Sent: ${sent}\n` +

      `❌ Failed: ${failed}`,

      {

        parse_mode:
          "Markdown"

      }

    );

  }
);


// ============================================================
// BROADCAST CANCEL
// ============================================================

bot.callbackQuery(
  "broadcast_cancel",
  async (ctx) => {

    const admin =
      await requireAdmin(
        ctx
      );


    if (!admin) {

      return;

    }


    await answerCallback(
      ctx
    );


    await db.deleteBroadcastDraft(
      admin.telegram_id
    );


    await ctx.editMessageText(
      "❌ Broadcast cancelled."
    );

  }
);


// ============================================================
// ERROR HANDLER
// ============================================================

bot.catch(
  (err) => {

    console.error(
      "Telegram bot error:",
      err.error
    );

  }
);


// ============================================================
// VERCEL WEBHOOK
// ============================================================

module.exports =
  webhookCallback(
    bot,
    "http"
  );
