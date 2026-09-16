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
const { Bot, webhookCallback,session } = require("grammy");
const db = require("../db");
const {  processDeposit } = require("../deposit");
// ============================================================
// CONFIG
// ============================================================
const BOT_TOKEN =  process.env.BOT_TOKEN;
const GAME_URL = process.env.GAME_URL || "https://sisters-bingo.vercel.app";
if (!BOT_TOKEN) 
{
  throw new Error("BOT_TOKEN environment variable is missing");
}
const bot = new Bot(BOT_TOKEN);
// ============================================================
// STATE
// ============================================================
const pendingPhone = {};
const pendingDeposit = {};

const pendingWithdrawal = {};
const pendingAdminWithdrawal  = {};
const pendingAdminAccount = {};
const pendingDelete = {};
const pendingAdminReject = {};
const pendingAdminAccountEdit = {};
const pendingAdminAccountDelete = {};
const pendingAdminUserSearch = new Map();
const pendingAdminRoleSearch = new Map();
const pendingBroadcastRecipient = new Map();

// ============================================================
// CLEAR USER STATE
// ============================================================
function clearPendingState(telegramId) 
{
  delete pendingPhone[telegramId];
  delete pendingDelete[telegramId];
  delete pendingDeposit[telegramId];  
  delete pendingWithdrawal[telegramId];  
  delete pendingAdminReject[telegramId];
  delete pendingAdminAccount[telegramId];
  delete pendingAdminWithdrawal[telegramId];  
  delete pendingAdminAccountEdit[telegramId];
  delete pendingAdminAccountDelete[telegramId];
 
  pendingAdminUserSearch.delete(telegramId);
  pendingAdminRoleSearch.delete(telegramId);
  pendingBroadcastRecipient.delete(telegramId);  
    try {
    db.clearBotUserState(
      telegramId
    );
  } catch (err) {
    console.error(
      "Failed to clear persistent bot state:",
      err
    );
  }
}

// ============================================================
// BLOCKED USER GUARD
// ============================================================
// Blocked users cannot use bot features.
// /start is allowed through so the user receives the
// blocked-account message from the /start handler.
bot.use(session({  initial: () => (
  {
    paymentMethod: null,
    paymentType: null
  })}));

bot.use(async (ctx, next) => {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId)
    {
      return next();
    }
    const text = ctx.message?.text?.trim() || "";
    // Allow /start so blocked users see the blocked message
    if (text.startsWith("/start"))
    {
      return next();
    }
    const user = await db.getUserByTelegramId(telegramId);
    if (user?.is_blocked === true) 
    {
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
      return ctx.reply("🚫 Your account has been blocked. Please contact support.");
    }
    return next();
  } catch (err) 
  {
    console.error("Blocked user guard error:", err);
    // Do not break the bot if the database check fails
    return next();
  }
});

async function cleanupExpiredAdminWithdrawalUI(
  telegramId
) {
  const state =
    pendingAdminWithdrawal[
      telegramId
    ];

  if (!state) {
    return;
  }

  if (
    !state.claimedWithdrawals ||
    !state.claimedWithdrawals.length
  ) {
    return;
  }

  if (
    state.claimExpiresAt &&
    Date.now() <
      state.claimExpiresAt
  ) {
    return;
  }

  /*
   * Local lease expired.
   */
  state.claimedWithdrawals = [];

  state.claimExpiresAt = null;

  if (state.cleanupTimer) {
    clearTimeout(
      state.cleanupTimer
    );

    state.cleanupTimer = null;
  }

  if (state.claimMessageId) {

    try {

      await bot.api.deleteMessage(
        telegramId,
        state.claimMessageId
      );

    } catch (err) {

      try {

        await bot.api.editMessageText(
          telegramId,
          state.claimMessageId,
          "⏱ *Withdrawal claim expired.*\n\n" +
          "The withdrawals were released for other admins.",
          {
            parse_mode: "Markdown"
          }
        );

      } catch (editError) {

        console.error(
          "Expired withdrawal UI cleanup failed:",
          editError
        );

      }
    }

    state.claimMessageId = null;
  }
}

function scheduleWithdrawalClaimCleanup(
  adminTelegramId
) {
  const state =
    pendingAdminWithdrawal[
      adminTelegramId
    ];

  if (!state) {
    return;
  }

  /*
   * Don't create multiple timers for the same admin.
   */
  if (state.cleanupTimer) {
    clearTimeout(
      state.cleanupTimer
    );
  }

  const expiresAt =
    state.claimExpiresAt;

  if (!expiresAt) {
    return;
  }

  const delay =
    Math.max(
      expiresAt - Date.now(),
      1000
    );

  state.cleanupTimer =
    setTimeout(
      async () => {

        try {

          const currentState =
            pendingAdminWithdrawal[
              adminTelegramId
            ];

          if (!currentState) {
            return;
          }

          /*
           * Clear the local state.
           */
          currentState.claimedWithdrawals =
            [];

          currentState.claimExpiresAt =
            null;

          currentState.cleanupTimer =
            null;

          /*
           * IMPORTANT:
           *
           * We do NOT modify the database here.
           *
           * The DB lease already expired.
           *
           * Another admin can claim these withdrawals.
           */

          /*
           * Delete the Telegram message.
           */
          if (
            currentState.claimMessageId
          ) {

            try {

              await bot.api.deleteMessage(
                adminTelegramId,
                currentState.claimMessageId
              );

            } catch (telegramError) {

              console.error(
                "Could not delete expired withdrawal message:",
                telegramError
              );

              /*
               * If Telegram won't let us delete it,
               * try editing it instead.
               */
              try {

                await bot.api.editMessageText(
                  adminTelegramId,
                  currentState.claimMessageId,
                  "⏱ *Withdrawal claim expired.*\n\n" +
                  "These withdrawals have been released and can be claimed by another admin.",
                  {
                    parse_mode: "Markdown"
                  }
                );

              } catch (editError) {

                console.error(
                  "Could not edit expired withdrawal message:",
                  editError
                );

              }
            }
          }

          currentState.claimMessageId =
            null;

        } catch (err) {

          console.error(
            "Withdrawal claim cleanup error:",
            err
          );

        }

      },
      delay
    );
}
// ============================================================
// BROADCAST SELECTION TEXT
// ============================================================

function getBroadcastSelectionText(
  draft
) {
  return (
    "📢 *Create Broadcast*\n\n" +

    `🖼 Image: ${
      draft.include_image
        ? "✅"
        : "❌"
    }\n` +

    `📝 Text: ${
      draft.include_text
        ? "✅"
        : "❌"
    }\n` +

    `🎮 Play Button: ${
      draft.include_button
        ? "✅"
        : "❌"
    }\n\n` +

    "Select the components you want."
  );
}


// ============================================================
// BROADCAST SELECTION KEYBOARD
// ============================================================

function getBroadcastSelectionKeyboard(
  draft
) {
  return {
    inline_keyboard: [

      [
        {
          text:
            draft.include_image
              ? "✅ 🖼 Image"
              : "🖼 Image",

          callback_data:
            "broadcast_toggle_image"
        },

        {
          text:
            draft.include_text
              ? "✅ 📝 Text"
              : "📝 Text",

          callback_data:
            "broadcast_toggle_text"
        }
      ],

      [
        {
          text:
            draft.include_button
              ? "✅ 🎮 Play Button"
              : "🎮 Play Button",

          callback_data:
            "broadcast_toggle_button"
        }
      ],

      [
        {
          text: "➡️ Continue",
          callback_data:
            "broadcast_continue"
        }
      ],

      [
        {
          text: "❌ Cancel",
          callback_data:
            "broadcast_cancel"
        }
      ]

    ]
  };
}
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
async function getCurrentAdmin(ctx)
{
  if (!ctx || !ctx.from || !ctx.from.id) 
  {
    return null;
  }
  try 
  {
    const admin = await db.getAdminByTelegramId(ctx.from.id);
    return admin || null;
  } 
  catch (err) 
  {
    console.error("Admin lookup error:", err);
    return null;
  }
}

async function getCurrentAdminPermission(ctx, permission) 
{
    const admin = await getCurrentAdmin(ctx);
    if (!admin) 
    {
        try {
              await ctx.answerCallbackQuery({text: "❌ Unauthorized", show_alert: true});
            } 
        catch (err) 
        {          
        }
        return null;
    }
    const role = admin.admin_role;
    const allowed =  role === "main" ||   (role === "broadcast" &&  permission === "broadcast") || (role === "statistics" && permission === "statistics") || (role === "withdrawal" &&    permission === "withdrawals");
    if (!allowed) 
    {
        try {
                await ctx.answerCallbackQuery({text: "❌ You do not have permission for this.", show_alert: true});
            } 
        catch (err) 
        {          
        }
        return null;
    }
    return admin;
}
// ============================================================
// BROADCAST HELPERS
// ============================================================

function getBroadcastKeyboard(
  draft,
  telegramId
) {
  if (
    !draft ||
    draft.include_button !== true ||
    !draft.button_title
  ) {
    return undefined;
  }

  return {
    inline_keyboard: [
      [
        {
          text: draft.button_title,
          web_app: {
            url: `${GAME_URL}?tid=${telegramId}`
          }
        }
      ]
    ]
  };
}


// ------------------------------------------------------------
// Determine whether the draft is complete
// ------------------------------------------------------------

function isBroadcastDraftComplete(draft) {
  if (!draft) {
    return false;
  }

  // At least image OR text must exist.
  if (
    draft.include_image !== true &&
    draft.include_text !== true
  ) {
    return false;
  }

  if (
    draft.include_image === true &&
    !draft.image_url
  ) {
    return false;
  }

  if (
    draft.include_text === true &&
    !draft.message
  ) {
    return false;
  }

  if (
    draft.include_button === true &&
    !draft.button_title
  ) {
    return false;
  }

  return true;
}


// ------------------------------------------------------------
// Find the next thing the admin must provide
// ------------------------------------------------------------

function getNextBroadcastStep(draft) {
  if (
    draft.include_image === true &&
    !draft.image_url
  ) {
    return "image";
  }

  if (
    draft.include_text === true &&
    !draft.message
  ) {
    return "text";
  }

  if (
    draft.include_button === true &&
    !draft.button_title
  ) {
    return "button";
  }

  return "complete";
}


// ------------------------------------------------------------
// Ask admin for the next broadcast component
// ------------------------------------------------------------

async function continueBroadcastBuilder(
  ctx,
  adminTelegramId
) {
  const draft =
    await db.getBroadcastDraft(
      adminTelegramId
    );

  if (!draft) {
    return;
  }

  const nextStep =
    getNextBroadcastStep(draft);

  // ----------------------------------------------------------
  // IMAGE
  // ----------------------------------------------------------

  if (nextStep === "image") {
    await db.updateBroadcastStatus(
      adminTelegramId,
      "waiting_image"
    );

    return ctx.reply(
      "🖼 *Send the image*\n\n" +
      "This image will be included in the broadcast.\n\n" +
      "❌ Send /cancel to cancel.",
      {
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // TEXT
  // ----------------------------------------------------------

  if (nextStep === "text") {
    await db.updateBroadcastStatus(
      adminTelegramId,
      "waiting_message"
    );

    return ctx.reply(
      "📝 *Send the broadcast message*\n\n" +
      "❌ Send /cancel to cancel.",
      {
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // BUTTON
  // ----------------------------------------------------------

  if (nextStep === "button") {
    await db.updateBroadcastStatus(
      adminTelegramId,
      "waiting_button_title"
    );

    return ctx.reply(
      "🎮 *Send the Play button title*\n\n" +
      "Example:\n" +
      "`🎮 Play Now`\n\n" +
      "You can use any title you want.\n\n" +
      "❌ Send /cancel to cancel.",
      {
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // COMPLETE
  // ----------------------------------------------------------

  if (nextStep === "complete") {
    await showBroadcastPreview(
      ctx,
      adminTelegramId
    );
  }
}


// ------------------------------------------------------------
// SHOW BROADCAST PREVIEW TO ADMIN
// ------------------------------------------------------------

async function showBroadcastPreview(
  ctx,
  adminTelegramId
) {
  const draft =
    await db.getBroadcastDraft(
      adminTelegramId
    );

  if (!draft) {
    return ctx.reply(
      "❌ Broadcast draft not found."
    );
  }

  if (
    !isBroadcastDraftComplete(draft)
  ) {
    return ctx.reply(
      "❌ Broadcast information is incomplete."
    );
  }

  const users =
    await db.getAllActiveUsers();

  const replyMarkup =
    getBroadcastKeyboard(
      draft,
      adminTelegramId
    );

  // ----------------------------------------------------------
  // SEND THE ACTUAL PREVIEW TO THE ADMIN
  // ----------------------------------------------------------

  if (
    draft.include_image === true
  ) {
    await bot.api.sendPhoto(
      adminTelegramId,
      draft.image_url,
      {
        caption:
          draft.include_text === true
            ? draft.message
            : undefined,

        reply_markup:
          replyMarkup
      }
    );
  } else {
    await bot.api.sendMessage(
      adminTelegramId,
      draft.message,
      {
        reply_markup:
          replyMarkup
      }
    );
  }

  // ----------------------------------------------------------
  // CONFIRMATION MESSAGE
  // ----------------------------------------------------------

  await ctx.reply(
    `📢 *BROADCAST PREVIEW*\n\n` +
    `👥 Recipients: ${users.length}\n\n` +
    `🖼 Image: ${ draft.include_image ? "Yes" : "No"  }\n` +
    `📝 Text: ${  draft.include_text ? "Yes" : "No"  }\n` +
    `🎮 Play Button: ${ draft.include_button ? `Yes — "${draft.button_title}"` : "No" }\n\n` +
    `The message above is the exact content that will be broadcast.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ SEND TO ALL",
              callback_data: "broadcast_confirm"
            }
          ],
          [
            {
              text: "👤 SEND TO SPECIFIC PERSON",
              callback_data: "broadcast_specific"
            }
          ],
          [
            {
              text: "❌ CANCEL",
              callback_data:
                "broadcast_cancel"
            }
          ]
        ]
      }
    }
  );

  await db.updateBroadcastStatus(
    adminTelegramId,
    "preview"
  );
}
// ============================================================
// CALLBACK HELPER
// ============================================================
async function answerCallback(ctx, text = undefined) 
{
  try 
  {
    if (text) 
    {
      await ctx.answerCallbackQuery({text });
    } 
    else 
    {
      await ctx.answerCallbackQuery();
    }
  } 
  catch (err) 
  {
    console.log("Callback answer failed:", err.description || err.message);
  }
}

// ============================================================
// PHONE NORMALIZATION
// ============================================================

function normalizeEthiopianPhone(input) {
  let phone = String(input)
    .trim()
    .replace(/[\s\-()]/g, "");

  // 0912345678
  if (/^09\d{8}$/.test(phone)) {
    return "251" + phone.substring(1);
  }

  // 0712345678
  if (/^07\d{8}$/.test(phone)) {
    return "251" + phone.substring(1);
  }

  // 251912345678
  if (/^251[97]\d{8}$/.test(phone)) {
    return phone;
  }

  // +251912345678
  if (/^\+251[97]\d{8}$/.test(phone)) {
    return phone.substring(1);
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

function normalizePaymentAccountNumber(accountNumber, paymentTypeName, paymentTypeAmharicName)
{
  const raw = String(accountNumber || "").trim();
  
  if (!raw) 
  {
    return null;
  }
  
  const typeName = String(paymentTypeName || "").trim().toLowerCase();
  const amharicTypeName = String(paymentTypeAmharicName || "").trim();
  const isMobile = typeName === "mobile" || amharicTypeName === "ሞባይል";

  // ----------------------------------------------------------
  // MOBILE ONLY
  // ----------------------------------------------------------

  if (isMobile) 
  {
    return normalizeEthiopianPhone(raw);
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

async function showHome(ctx, user) 
{
  const telegramId = ctx.from.id;  
  const canPlay = user && user.is_active === true && user.is_blocked !== true;
  const keyboard = [];
  if (user && user.is_active === true && user.is_blocked !== true) 
  {
     keyboard.push([{ text: "🎮 Play", web_app: { url: `${GAME_URL}?tid=${telegramId}`}}]);
  }
  keyboard.push([{ text: "💰 Balance", callback_data: "user_balance"}, { text: "📊 Statistics", callback_data: "user_statistics"},],
                [{ text: "💎 Deposit", callback_data: "user_deposit"}, { text: "🏧 Withdraw", callback_data: "user_withdraw"}],
                [{ text: "🆘 Support", callback_data: "user_support"}, { text: "🗑️ Delete", callback_data: "user_delete"}]);
  
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
      `❌ Rejected: *${stats.rejectedWithdrawals}*`;

      

    await ctx.editMessageText(
      message,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 Refresh",
                callback_data: "user_statistics"
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
  "user_statistics",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

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
  "user_delete",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

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
                callback_data: "user_confirm_delete"
              },
              {
                text: "አይ",
                callback_data: "user_cancel_delete"
              }
            ]
          ]
        }
      }
    );

  }
);
  bot.callbackQuery(
  "user_cancel_delete",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);
    
  const user = await db.getUserByTelegramId(ctx.from.id);

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
  "user_confirm_delete",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    try {

      const result =
        await db.deactivateUser(ctx.from.id);


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
        await getCurrentAdminPermission(
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
        await getCurrentAdminPermission(
          ctx,
          "statistics"
        );

      if (!admin) {
        return;
      }

      const stats =
        await db.getAdminFinancialStatistics();

      let message =
        "💰 *FINANCIAL STATISTICS*\n\n";

      // ========================================================
      // PAYMENT ACCOUNTS
      // ========================================================

      message +=
        "💳 *PAYMENT ACCOUNTS*\n\n";

      if (
        !stats.accounts ||
        stats.accounts.length === 0
      ) {
        message +=
          "No payment accounts found.\n\n";
      } else {
        stats.accounts.forEach(
          (account, index) => {
            message +=
              `${index + 1}. ` +
              `${account.paymentMethodEmoji} ` +
              `*${account.accountName}*\n`;

            message +=
              `📱 Account: \`${account.accountNumber}\`\n`;

            message +=
              `💳 Method: *${account.paymentMethodName}*\n`;

            message +=
              `💰 Balance: *${account.balance.toFixed(2)} ETB*\n\n`;

            message +=
              `💎 Deposits: *${account.depositCount}*\n`;

            message +=
              `   💰 Amount: *${account.depositAmount.toFixed(2)} ETB*\n`;

            message +=
              `🏧 Withdrawals: *${account.withdrawalCount}*\n`;

            message +=
              `   💰 Amount: *${account.withdrawalAmount.toFixed(2)} ETB*\n\n`;

            message +=
              "────────────────────\n\n";
          }
        );
      }

      // ========================================================
      // OVERALL TOTALS
      // ========================================================

      message +=
        "📊 *OVERALL TOTALS*\n\n";

      message +=
        `💎 Total Deposits: *${stats.totalDepositCount}*\n`;

      message +=
        `💰 Deposit Amount: *${stats.totalDepositAmount.toFixed(2)} ETB*\n\n`;

      message +=
        `🏧 Total Withdrawals: *${stats.totalWithdrawalCount}*\n`;

      message +=
        `💰 Withdrawal Amount: *${stats.totalWithdrawalAmount.toFixed(2)} ETB*`;

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

      try {
        await ctx.editMessageText(
          "❌ Could not load financial statistics.",
          {
            reply_markup: {
              inline_keyboard: [
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
      } catch (editError) {
        console.error(
          "Could not display financial statistics error:",
          editError
        );
      }
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
        await getCurrentAdminPermission(
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
  await getCurrentAdminPermission(
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

        `👥 *Users*\n` +
        `🟢 Active Users: *${stats.activeUsers}*\n` +
        `⚪ Inactive Users: *${stats.inactiveUsers}*\n` +
        `🔴 Blocked Users: *${stats.blockedUsers}*\n\n` +

        `👑 Main Admin: *${stats.mainAdmin}*\n` +
        `📊 Statistics Admin: *${stats.statisticsAdmin}*\n` +
        `💸 Withdrawal Admin: *${stats.withdrawalAdmin}*\n` +
        `📢 Broadcast Admin: *${stats.broadcastAdmin}*`;


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

// ============================================================
// SHOW PAYMENT ACCOUNTS MENU
// ============================================================

async function showAdminAccounts(ctx) {
  const admin = await getCurrentAdmin(ctx);

  if (!admin) {
    return;
  }

  try {
    const accounts =
      await db.getAllPaymentAccountsForAdmin();

    let message =
      "💳 *PAYMENT ACCOUNTS*\n\n";

    if (!accounts || accounts.length === 0) {
      message +=
        "No payment accounts have been created yet.\n\n";
    } else {
      accounts.forEach((account, index) => {
        const methodName =
          account.pm_amharic_name ||
          account.pm_name ||
          "Payment Method";

        const typeName =
          account.pt_amharic_name ||
          account.pt_name ||
          "";

        const activeStatus =
          account.is_active
            ? "🟢 Active"
            : "🔴 Inactive";

        const removedStatus =
          account.is_removed
            ? "🗑️ Removed"
            : "✅ Not removed";

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
          `📌 Status: ${activeStatus}\n` +
          `🗑️ Removed: ${removedStatus}\n\n`;
      });
    }

    const keyboard = [];

    // ----------------------------------------------------------
    // ACCOUNT ACTION BUTTONS
    // ----------------------------------------------------------

    if (accounts && accounts.length > 0) {
      for (const account of accounts) {

        // Edit
        keyboard.push([
          {
            text:
              `✏️ Edit ${account.account_name}`,
            callback_data:
              `admin_account_edit_${account.id}`
          }
        ]);

        // Activate / Deactivate
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

        // Delete / Undelete
        keyboard.push([
          {
            text:
              account.is_removed
                ? `♻️ Undelete ${account.account_name}`
                : `🗑️ Delete ${account.account_name}`,

            callback_data:
              `admin_account_remove_${account.id}_${account.is_removed ? "0" : "1"}`
          }
        ]);
      }
    }

    // ----------------------------------------------------------
    // MAIN BUTTONS
    // ----------------------------------------------------------

    keyboard.push([
      {
        text: "➕ Add Account",
        callback_data: "admin_account_add"
      }
    ]);

    keyboard.push([
      {
        text: "🔄 Refresh",
        callback_data: "admin_accounts"
      },
      {
        text: "🏠 Home",
        callback_data: "admin_home"
      }
    ]);

    const options = {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: keyboard
      }
    };

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(
          message,
          options
        );
      } catch (err) {
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
      await getCurrentAdmin(ctx);

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
      await getCurrentAdmin(ctx);

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
      await getCurrentAdmin(ctx);

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
      await getCurrentAdmin(ctx);

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
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(
      ctx,
      "Updating account..."
    );

    const accountId =
      Number(ctx.match[1]);

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
          "❌ Payment account not found or it is deleted."
        );
      }

      await showAdminAccounts(ctx);

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
// DELETE / UNDELETE PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  /^admin_account_remove_(\d+)_(0|1)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    const accountId =
      Number(ctx.match[1]);

    const shouldRemove =
      ctx.match[2] === "1";

    await answerCallback(
      ctx,
      shouldRemove
        ? "Deleting account..."
        : "Restoring account..."
    );

    try {

      const account =
        await db.setPaymentAccountRemoved(
          accountId,
          shouldRemove
        );

      if (!account) {
        return ctx.reply(
          "❌ Payment account not found."
        );
      }

      await showAdminAccounts(ctx);

    } catch (err) {

      console.error(
        "Payment account delete/undelete error:",
        err
      );

      await ctx.reply(
        "❌ Could not change the deleted status."
      );
    }
  }
);

// ============================================================
// EDIT PAYMENT ACCOUNT
// ============================================================

bot.callbackQuery(
  /^admin_account_edit_(\d+)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const accountId =
      Number(ctx.match[1]);

    try {

      const account =
        await db.getPaymentAccountByIdForAdmin(
          accountId
        );

      if (!account) {
        return ctx.reply(
          "❌ Payment account not found."
        );
      }

      pendingAdminAccountEdit[
        admin.telegram_id
      ] = {
        step: "account_name",
        accountId,

        originalName:
          account.account_name,

        originalAccountNumber:
          account.account_number,

        originalBalance:
          Number(account.balance),

        accountName:
          account.account_name,

        accountNumber:
          account.account_number,

        balance:
          Number(account.balance),

        paymentTypeName:
          account.pt_name,

        paymentTypeAmharicName:
          account.pt_amharic_name
      };

      await ctx.editMessageText(
        "✏️ *EDIT PAYMENT ACCOUNT*\n\n" +

        `👤 Current name: *${account.account_name}*\n\n` +

        "Enter the new account name.\n" +
        "Or press *Keep Current* to leave it unchanged.",

        {
          parse_mode: "Markdown",

          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Keep Current",
                  callback_data:
                    `admin_account_edit_keep_name_${accountId}`
                }
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    "admin_account_edit_cancel"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {

      console.error(
        "Edit payment account start error:",
        err
      );

      await ctx.reply(
        "❌ Could not load the payment account."
      );
    }
  }
);
// ============================================================
// EDIT ACCOUNT — CANCEL
// ============================================================

bot.callbackQuery(
  "admin_account_edit_cancel",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    delete pendingAdminAccountEdit[
      admin.telegram_id
    ];

    await showAdminAccounts(ctx);
  }
);

// ============================================================
// EDIT ACCOUNT — CONFIRMATION SCREEN
// ============================================================

async function showAdminAccountEditConfirmation(
  ctx,
  pending
) {

  await ctx.editMessageText(

    "✏️ *CONFIRM ACCOUNT CHANGES*\n\n" +

    `👤 Name:\n*${pending.accountName}*\n\n` +

    `📱 Account Number:\n\`${pending.accountNumber}\`\n\n` +

    `💰 Balance:\n*${pending.balance} ETB*\n\n` +

    "Are these changes correct?",

    {
      parse_mode: "Markdown",

      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Save Changes",
              callback_data:
                `admin_account_edit_save_${pending.accountId}`
            }
          ],
          [
            {
              text: "❌ Cancel",
              callback_data:
                "admin_account_edit_cancel"
            }
          ]
        ]
      }
    }
  );
}
// ============================================================
// EDIT ACCOUNT — SAVE
// ============================================================

bot.callbackQuery(
  /^admin_account_edit_save_(\d+)$/,
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(
      ctx,
      "Saving changes..."
    );

    const accountId =
      Number(ctx.match[1]);

    const pending =
      pendingAdminAccountEdit[
        admin.telegram_id
      ];

    if (!pending) {
      return ctx.reply(
        "❌ The edit session has expired. Please try again."
      );
    }

    if (
      Number(pending.accountId) !==
      accountId
    ) {
      return ctx.reply(
        "❌ Invalid edit session."
      );
    }

    try {

      const result =
        await db.updatePaymentAccount(
          accountId,
          pending.accountName,
          pending.accountNumber,
          pending.balance
        );

      if (!result) {
        return ctx.reply(
          "❌ Payment account not found or could not be updated."
        );
      }

      delete pendingAdminAccountEdit[
        admin.telegram_id
      ];

      await ctx.editMessageText(
        "✅ *PAYMENT ACCOUNT UPDATED*\n\n" +

        `👤 Name: *${result.account_name}*\n` +
        `📱 Account: \`${result.account_number}\`\n` +
        `💰 Balance: *${result.balance} ETB*\n\n` +

        "The account has been updated successfully.",

        {
          parse_mode: "Markdown",

          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "💳 Accounts",
                  callback_data:
                    "admin_accounts"
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
        "Update payment account error:",
        err
      );

      await ctx.reply(
        `❌ ${err.message || "Could not update the payment account."}`
      );
    }
  }
);
// ============================================================
// EDIT ACCOUNT — TEXT INPUT
// ============================================================


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

bot.hears("balance", showBalance);
bot.hears("💰 Balance", showBalance);
bot.hears("deposit", showDeposit);
bot.hears("withdraw", showWithdrawal);
bot.hears("🏧 Withdraw", showWithdrawal);
bot.hears("support", showSupport);
bot.hears("📊 Leaderboard", showLeaderboard);
bot.hears("🎮 Play", showPlay);

bot.callbackQuery(
  "user_balance",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    await showBalance(ctx);
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
        "user_cancel_deposit"

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




bot.callbackQuery(
  "user_deposit",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);
  await showDeposit(ctx);
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
            "❌ የ" + paymentMethod.amharic_Name + " አካውንት አማራጭ አልተገኘም።"
          );

        }

        const paymentType = await db.getPaymentMethodTypesById(paymentMethod.type_id);
        if (!paymentType) {

          return ctx.reply(
            "❌ የክፍያ አማራጭ አልተገኘም።"
          );
        }
        ctx.session.paymentMethod = { id: paymentMethod.id , name: paymentMethod.name, amharicName: paymentMethod.amharic_name};
        ctx.session.paymentType = { id: paymentType.id, name: paymentType.name, amharicName: paymentType.amharic_name};


        await ctx.editMessageText(

          "1. ከታች ባለው የ" +

          paymentMethod.amharic_name +

          " አካውንት እስከ 200.00 ብር ድረስ ብቻ ያስገቡ\n\n" +

          paymentMethod.emoji + " *" + paymentMethod.name +  ":* `" + paymentaccount.account_number + "`\n\n" +

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
      }, 60000);


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
// CANCEL DEPOSIT
// ============================================================

bot.callbackQuery(
  "user_cancel_deposit",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);
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
    balance < 50
  ) {

    return ctx.reply(

      "❌ በቂ ቀሪ ሂሳብ የሎትም።\n\n" +

      `💰 ያለዎት ሂሳብ፦ ${balance} ETB\n\n` +

      "ዝቅተኛው የወጪ መጠን 50 ETB ነው።"

    );

  }


  const paymentMethods =
    await db.getPaymentMethods();


  if (
    !paymentMethods ||
    paymentMethods.length === 0
  ) {

    return ctx.reply(
      "❌ ለጊዜው የወጪ የክፍያ መንገድ አልተዘጋጀም።"
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
            `user_withdraw_method_${pm.id}`

        }

      ]
    );


  buttons.push([

    {

      text:
        "❌ ሰርዝ",

      callback_data:
        "user_cancel_withdrawal"

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




bot.callbackQuery(
  "user_withdraw",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    await showWithdrawal(ctx);
  }
);


// ============================================================
// WITHDRAWAL PAYMENT METHOD
// ============================================================

bot.callbackQuery(
  /^user_withdraw_method_(\d+)$/,
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
        "❌ የወጪ ጥያቄው ጊዜው አልፎበታል። /start ይጫኑ።"
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


     await db.setBotUserState(telegramId,"withdrawal", { step: "account", paymentMethodId: methodId ,paymentMethod: paymentMethod});


      await ctx.editMessageText(

        "🏧 *የወጪ አካውንት*\n\n" +

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
// CANCEL WITHDRAWAL
// ============================================================

bot.callbackQuery(
  "user_cancel_withdrawal",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

    try {

      await ctx.editMessageText(
        "❌ የወጪ ጥያቄዎ ተሰርዟል።"
      );

    } catch {

      await ctx.reply(
        "❌ የወጪ ጥያቄዎ ተሰርዟል።"
      );

    }

  }
);


// ============================================================
// ADMIN — PENDING WITHDRAWALS
// PAYMENT METHOD → PAYMENT ACCOUNT → PENDING LIST
// ============================================================

async function showAdminPaymentMethods(ctx) {

  const admin = await getCurrentAdmin(ctx);

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
    await cleanupExpiredAdminWithdrawalUI(ctx.from.id);
    const admin = await getCurrentAdminPermission(
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
      await getCurrentAdmin(ctx);

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
              `${account.balance || ""}`,

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
      await getCurrentAdmin(ctx);

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

        paymentMethodId: account.payment_method_id,
        paymentAccountId: account.id,
        paymentAccount: account,
        claimMessageId: null,
        claimedWithdrawals: [],
        claimExpiresAt: null
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
  editMessage = false,
  claimNew = true
) {
  const admin = await getCurrentAdmin(ctx);

  if (!admin) {
    return;
  }

  const adminState =
    pendingAdminWithdrawal[admin.telegram_id];

  if (!adminState) {
    return showAdminPaymentMethods(ctx);
  }

  try {
    /*
     * ----------------------------------------------------------
     * CLAIM NEW WITHDRAWALS
     * ----------------------------------------------------------
     *
     * This is NOT getPendingWithdrawals().
     *
     * It atomically changes:
     *
     * pending -> processing
     *
     * and assigns the rows to this admin.
     */
    let withdrawals;

if (claimNew) {
  const claimResult =
    await db.claimPendingWithdrawals(
      admin.telegram_id,
      adminState.paymentMethodId,
      1
    );

  if (!claimResult || !claimResult.success) {
    return ctx.reply(
      `❌ ${
        claimResult?.message ||
        "Could not claim withdrawals."
      }`
    );
  }

  withdrawals =
    claimResult.withdrawals || [];

  adminState.claimedWithdrawals =
    withdrawals;

  adminState.claimExpiresAt =
    Date.now() + (5 * 60 * 1000);

} else {
  // Display withdrawals already claimed by this admin.
  withdrawals =
    adminState.claimedWithdrawals || [];
}

    let message =
      "👑 *WITHDRAWALS ASSIGNED TO YOU*\n\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      `💳 Method: *${
        adminState.paymentAccount.pm_amharic_name ||
        adminState.paymentAccount.pm_name ||
        "Unknown"
      }*\n` +
      `📱 Payment Account: \`${adminState.paymentAccount.account_number}\`\n` +
      `📱 Account Name: \`${adminState.paymentAccount.account_name}\`\n` +
      `💵Account Balance: \`${adminState.paymentAccount.balance} ETB\`\n` +
      `⏱ Claim expires in: *5 minutes*\n` +
      "━━━━━━━━━━━━━━━━━━━━\n\n";

    if (!withdrawals.length) {
      message +=
        "There are no withdrawals available right now.";

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: "🔄 Refresh",
              callback_data:
                "admin_refresh_withdrawals"
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
      };

      if (editMessage) {
        try {
          await ctx.editMessageText(
            message,
            {
              parse_mode: "Markdown",
              reply_markup: keyboard
            }
          );
        } catch (err) {
          await ctx.reply(
            message,
            {
              parse_mode: "Markdown",
              reply_markup: keyboard
            }
          );
        }
      } else {
        await ctx.reply(
          message,
          {
            parse_mode: "Markdown",
            reply_markup: keyboard
          }
        );
      }

      return;
    }

    /*
     * ----------------------------------------------------------
     * DISPLAY CLAIMED WITHDRAWALS
     * ----------------------------------------------------------
     */
    withdrawals.forEach(
      (withdrawal, index) => {

        message +=
          `*${index + 1}. Withdrawal #${withdrawal.id}*\n` +
          `👤 User: *${withdrawal.name || "Unknown"}*\n` +
          `💰 Amount: *${withdrawal.amount} ETB*\n` +
          `📱 Account: \`${withdrawal.account_number}\`\n\n`;

      }
    );

    /*
     * Buttons.
     */
    const keyboard = [];

    withdrawals.forEach(
      (withdrawal) => {

        keyboard.push([
          {
            text:
              `✅ #${withdrawal.id}`,
            callback_data:
              `approve_withdrawal_${withdrawal.id}`
          },
          {
            text:
              `❌ #${withdrawal.id}`,
            callback_data:
              `reject_withdrawal_${withdrawal.id}`
          }
        ]);

      }
    );

    keyboard.push([
      {
        text: "🔄 Refresh",
        callback_data:
          "admin_refresh_withdrawals"
      }
    ]);

    keyboard.push([
      {
        text: "🏠 Home",
        callback_data:
          "admin_home"
      }
    ]);

    const options = {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: keyboard
      }
    };

    /*
     * ----------------------------------------------------------
     * SEND / EDIT TELEGRAM MESSAGE
     * ----------------------------------------------------------
     */
    let sentMessage;

    if (editMessage) {

      try {

        await ctx.editMessageText(
          message,
          options
        );

        /*
         * The callback message remains the same Telegram message.
         */
        adminState.claimMessageId =
          ctx.callbackQuery?.message?.message_id;

      } catch (err) {

        sentMessage =
          await ctx.reply(
            message,
            options
          );

        adminState.claimMessageId =
          sentMessage.message_id;

      }

    } else {

      sentMessage =
        await ctx.reply(
          message,
          options
        );

      adminState.claimMessageId =
        sentMessage.message_id;
    }

    /*
     * Schedule local cleanup if this server instance remains alive.
     *
     * DATABASE lease is still authoritative.
     */
    scheduleWithdrawalClaimCleanup(
      admin.telegram_id
    );

  } catch (err) {

    console.error(
      "showPendingWithdrawals error:",
      err
    );

    await ctx.reply(
      "❌ Could not load withdrawals."
    );
  }
}

// ============================================================
// ADMIN — REFRESH PENDING LIST
// ============================================================

bot.callbackQuery("admin_refresh_withdrawals", async (ctx) => {
  try {
    await ctx.answerCallbackQuery();

    const adminTelegramId = ctx.from.id;

    // Get the admin's current withdrawal state
    const adminState =
      pendingAdminWithdrawal[adminTelegramId];

    if (!adminState?.paymentMethodId) {
      await ctx.reply(
        "❌ Please select a payment method first."
      );
      return;
    }

    // Claim a NEW batch of available withdrawals.
    // This should only claim pending/expired withdrawals.
    const claimResult =
      await db.claimPendingWithdrawals(
        adminTelegramId,
        adminState.paymentMethodId,
        1
      );

    if (!claimResult?.success) {
      await ctx.reply(
        `❌ ${
          claimResult?.message ||
          "Failed to refresh withdrawals."
        }`
      );
      return;
    }

    const withdrawals =
      claimResult.withdrawals || [];

    // Replace the admin's current displayed claim list
    adminState.claimedWithdrawals = withdrawals;

    // New 5-minute claim lease
    if (withdrawals.length > 0) {
      adminState.claimExpiresAt =
        Date.now() + 5 * 60 * 1000;
    } else {
      adminState.claimExpiresAt = null;
    }

    // Update the existing Telegram message
    if (withdrawals.length === 0) {
      await ctx.editMessageText(
        "📭 *No pending withdrawals available right now.*\n\n" +
        "Tap 🔄 Refresh to check again.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔄 Refresh",
                  callback_data:
                    "admin_refresh_withdrawals",
                },
              ],
            ],
          },
        }
      );

      return;
    }

    let message =
      "💸 *Pending Withdrawals*\n\n";

    withdrawals.forEach((withdrawal, index) => {
      message +=
        `*${index + 1}. Withdrawal #${withdrawal.id}*\n` +
        `👤 User: *${withdrawal.name || "Unknown"}*\n` +
        `💰 Amount: *${withdrawal.amount} ETB*\n` +
        `📱 Account: \`${withdrawal.account_number}\`\n\n`;
    });

    const buttons = [];

    withdrawals.forEach((withdrawal) => {
      buttons.push([
        {
          text: `✅ Approve #${withdrawal.id}`,
          callback_data:
            `approve_withdrawal_${withdrawal.id}`,
        },
        {
          text: `❌ Reject #${withdrawal.id}`,
          callback_data:
            `reject_withdrawal_${withdrawal.id}`,
        },
      ]);
    });

    buttons.push([
      {
        text: "🔄 Refresh",
        callback_data:
          "admin_refresh_withdrawals",
      },
    ]);

    await ctx.editMessageText(
      message,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: buttons,
        },
      }
    );

    // Save message ID for expiry cleanup
    adminState.claimMessageId =
      ctx.callbackQuery.message.message_id;

  } catch (error) {
    console.error(
      "admin_refresh_withdrawals error:",
      error
    );

    try {
      await ctx.answerCallbackQuery({
        text: "❌ Failed to refresh withdrawals.",
        show_alert: true,
      });
    } catch (_) {}
  }
});

// ============================================================
// ADMIN PENDING BUTTON
// ============================================================

bot.callbackQuery(
  "admin_withdrawals",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(
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
bot.callbackQuery("admin_home", async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);
  const admin = await getCurrentAdmin(ctx);
    if (!admin) 
    {
          return ctx.editMessageText("❌ Unauthorized.");
    }
    try 
    {
      const user = await db.getUserByTelegramId(admin.telegram_id);
      if (!user) 
      {
        return ctx.reply("❌ Admin account was not found.");
      }
      await showHome(ctx, user);
    } catch (err) 
    {
      console.error("Admin home error:", err);
    }
  }
);


// ============================================================
// ADMIN APPROVE WITHDRAWAL
// ============================================================

bot.callbackQuery(
  /^approve_withdrawal_(\d+)$/,
  async (ctx) => {
await cleanupExpiredAdminWithdrawalUI(
  ctx.from.id
);
     const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(
      ctx,
      "Approving..."
    );

    await cleanupExpiredAdminWithdrawalUI(
      admin.telegram_id
    );

    const withdrawalId =
      Number(ctx.match[1]);

    try {

      const adminState =
        pendingAdminWithdrawal[
          admin.telegram_id
        ];

      if (!adminState) {
        return ctx.reply(
          "⏱ Your withdrawal claim has expired. Please press Pending again."
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

        /*
         * If the lease expired, remove the stale
         * Telegram UI.
         */
        if (
          result?.message?.toLowerCase()
            .includes("expired")
        ) {

          await cleanupExpiredAdminWithdrawalUI(
            admin.telegram_id
          );

        }

        return ctx.reply(
          `❌ ${
            result?.message ||
            "Withdrawal approval failed."
          }`
        );
      }

      /*
       * Remove this withdrawal from the local
       * claimed list.
       */
     adminState.claimedWithdrawals =
  (adminState.claimedWithdrawals || []).filter(
    w => Number(w.id) !== Number(withdrawalId)
  );

      /*
       * Send approval notification to user.
       *
       * Keep your existing notification code here.
       */

      /*
       * Refresh the admin's remaining claims.
       */


 pendingAdminWithdrawal[admin.telegram_id];
await ctx.reply(

  "✅ *WITHDRAWAL APPROVED*\n\n" +

  `🆔 #${withdrawalId}\n` +

  `👤 User: *${result.user_name}*\n` +

  `💰 Amount: *${result.amount} ETB*\n` +

  `📱 Recipient: \`${result.withdrawal.account_number}\`\n\n` +

  `💳 Paid from: \`${result.payment_account_number}\`\n` +

  `💰 Account balance after: *${result.payment_account_balance_after} ETB*\n` +

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

          "✅ *የወጪ ጥያቄዎ ጸድቋል!*\n\n" +

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
        ctx,
        true,
        false
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
      await getCurrentAdmin(
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




bot.callbackQuery(
  "user_support",
  async (ctx) => {
  await answerCallback(ctx);
  clearPendingState(ctx.from.id);

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

// ============================================================
// ADMIN BROADCAST
// ============================================================

bot.callbackQuery(
  "admin_broadcast",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const adminTelegramId =
      admin.telegram_id;

    await db.createBroadcastDraft(
      adminTelegramId
    );

    await ctx.reply(
      "📢 *Create Broadcast*\n\n" +
      "Choose what you want to include.\n\n" +
      "You can choose:\n" +
      "• Image\n" +
      "• Text\n" +
      "• Play button\n\n" +
      "Select at least Image or Text.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🖼 Image",
                callback_data:
                  "broadcast_toggle_image"
              },
              {
                text: "📝 Text",
                callback_data:
                  "broadcast_toggle_text"
              }
            ],
            [
              {
                text: "🎮 Play Button",
                callback_data:
                  "broadcast_toggle_button"
              }
            ],
            [
              {
                text: "➡️ Continue",
                callback_data:
                  "broadcast_continue"
              }
            ],
            [
              {
                text: "❌ Cancel",
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
// BROADCAST TOGGLE IMAGE
// ============================================================

bot.callbackQuery(
  "broadcast_toggle_image",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const draft =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    if (!draft) {
      return;
    }

    const newValue =
      draft.include_image !== true;

    await db.updateBroadcastOptions(
      admin.telegram_id,
      newValue,
      draft.include_text === true,
      draft.include_button === true
    );

    const updated =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    await ctx.editMessageText(
      getBroadcastSelectionText(
        updated
      ),
      {
        parse_mode: "Markdown",
        reply_markup:
          getBroadcastSelectionKeyboard(
            updated
          )
      }
    );
  }
);


// ============================================================
// BROADCAST TOGGLE TEXT
// ============================================================

bot.callbackQuery(
  "broadcast_toggle_text",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const draft =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    if (!draft) {
      return;
    }

    const newValue =
      draft.include_text !== true;

    await db.updateBroadcastOptions(
      admin.telegram_id,
      draft.include_image === true,
      newValue,
      draft.include_button === true
    );

    const updated =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    await ctx.editMessageText(
      getBroadcastSelectionText(
        updated
      ),
      {
        parse_mode: "Markdown",
        reply_markup:
          getBroadcastSelectionKeyboard(
            updated
          )
      }
    );
  }
);


// ============================================================
// BROADCAST TOGGLE BUTTON
// ============================================================

bot.callbackQuery(
  "broadcast_toggle_button",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const draft =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    if (!draft) {
      return;
    }

    const newValue =
      draft.include_button !== true;

    await db.updateBroadcastOptions(
      admin.telegram_id,
      draft.include_image === true,
      draft.include_text === true,
      newValue
    );

    const updated =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    await ctx.editMessageText(
      getBroadcastSelectionText(
        updated
      ),
      {
        parse_mode: "Markdown",
        reply_markup:
          getBroadcastSelectionKeyboard(
            updated
          )
      }
    );
  }
);


// ============================================================
// BROADCAST CONTINUE
// ============================================================

bot.callbackQuery(
  "broadcast_continue",
  async (ctx) => {

    const admin =
      await getCurrentAdminPermission(
        ctx,
        "broadcast"
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const draft =
      await db.getBroadcastDraft(
        admin.telegram_id
      );

    if (!draft) {
      return;
    }

    // At least image or text is required.
    if (
      draft.include_image !== true &&
      draft.include_text !== true
    ) {
      return ctx.reply(
        "❌ Please select at least 🖼 Image or 📝 Text."
      );
    }

    await ctx.editMessageText(
      "✅ Content selected.\n\n" +
      "Let's build your broadcast..."
    );

    await continueBroadcastBuilder(
      ctx,
      admin.telegram_id
    );
  }
);

// ============================================================
// BROADCAST IMAGE
// ============================================================

// ============================================================
// BROADCAST IMAGE
// ============================================================

bot.on(
  "message:photo",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

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
      "✅ Image received."
    );

    await continueBroadcastBuilder(
      ctx,
      adminTelegramId
    );
  }
);

// ============================================================
// ALL TEXT INPUT — SINGLE HANDLER
// ============================================================
//
// IMPORTANT:
// There must be ONLY ONE bot.on("message:text") in this file.
//
// Every text-input flow is routed from here according to the
// user's current pending state.
//
// Priority:
//
// 1. Payment account edit
// 2. Payment account creation
// 3. Admin rejection reason
// 4. Admin user search
// 5. Admin role/statistics search
// 6. Registration
// 7. Deposit SMS
// 8. Withdrawal account
// 9. Withdrawal amount
// 10. Broadcast
//
// If no state belongs to the message, next() is called.
// ============================================================

bot.on(
  "message:text",
  async (ctx, next) => {

    try {

      const telegramId =
        ctx.from.id;

      const text =
        String(
          ctx.message.text || ""
        ).trim();
// ========================================================
      // 8. WITHDRAWAL — ACCOUNT NUMBER
      // ========================================================

      const withdrawalState =
  await db.getBotUserState(
    telegramId
  );
      const withdrawal =
  withdrawalState &&
  withdrawalState.stateType === "withdrawal"
    ? withdrawalState.stateData
    : null;

      if (
        withdrawal &&
        withdrawal.step ===
          "account"
      ) {

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
          accountNumber.length >
          30
        ) {

          return ctx.reply(
            "❌ የአካውንት ቁጥሩ ከ30 ፊደል/ቁጥር መብለጥ አይችልም።"
          );

        }
        

await db.setBotUserState(
  telegramId,
  "withdrawal",
  {
    ...withdrawal,
    step: "amount",
    accountNumber
  }
);

        return ctx.reply(

          "✅ *የአካውንት ቁጥር ተቀብለናል።*\n\n" +

          `📱 አካውንት፦ *${normalizeEthiopianPhone(accountNumber)}*\n\n` +

          "💰 አሁን ማውጣት የሚፈልጉትን የብር መጠን ያስገቡ።\n\n" +

          "ምሳሌ፦ `100`",

          {
            parse_mode:
              "Markdown"
          }

        );

      }


      // ========================================================
      // 9. WITHDRAWAL — AMOUNT
      // ========================================================

      if (
        withdrawal &&
        withdrawal.step ===
          "amount"
      ) {

        if (
          text.startsWith("/")
        ) {

          return next();

        }

        try {

          const amount =
            Number(text);

          if (
            !Number.isFinite(
              amount
            ) ||
            amount <= 0
          ) {

            return ctx.reply(
              "❌ እባክዎ ትክክለኛ የብር መጠን ያስገቡ።"
            );

          }

          if (
            amount < 50
          ) {

            return ctx.reply(
              "❌ ዝቅተኛው የወጪ መጠን 50 ETB ነው።"
            );

          }

          const user =
            await db.getUserByTelegramId(
              telegramId
            );

          if (!user) {

            clearPendingState(
  ctx.from.id
);

            return ctx.reply(
              "❌ አካውንትዎ አልተገኘም።"
            );

          }

          const userBalance =
            Number(
              user.balance
            );

          if (
            amount >
            userBalance
          ) {

            return ctx.reply(

              "❌ በቂ ቀሪ ሂሳብ የሎትም።\n\n" +

              `💰 ያለዎት ቀሪ ሂሳብ፦ ${userBalance} ETB\n` +

              `💸 የጠየቁት፦ ${amount} ETB`

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

          await db.clearBotUserState(telegramId);

          return ctx.reply(

            "✅ *የወጪ ጥያቄዎ ተቀብለናል!*\n\n" +

            `💳 የክፍያ መንገድ፦ *${
              withdrawal.paymentMethod.amharic_name
            }*\n` +

            `📱 አካውንት፦ *${
              withdrawal.accountNumber
            }*\n` +

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

          return ctx.reply(
            "❌ የወጪ ጥያቄውን ማስኬድ አልተቻለም።"
          );

        }

      }
      // ========================================================
      // COMMANDS
      // ========================================================

      // Do not consume commands inside text-input flows unless
      // that particular flow explicitly supports /cancel.
      //
      // /start, /balance, etc. should continue through the
      // normal command middleware.
      //
      // /cancel is handled below for pending flows.

      // ========================================================
      // 1. PAYMENT ACCOUNT EDIT
      // ========================================================

      const edit =
        pendingAdminAccountEdit[
          telegramId
        ];

      if (edit) {

        const admin =
          await getCurrentAdmin(ctx);

        if (!admin) {

          delete pendingAdminAccountEdit[
            telegramId
          ];

          return ctx.reply(
            "❌ You are not authorized to edit payment accounts."
          );
        }

        // ------------------------------------------------------
        // CANCEL EDIT
        // ------------------------------------------------------

        if (
          text === "/cancel"
        ) {

          delete pendingAdminAccountEdit[
            telegramId
          ];

          return ctx.reply(
            "❌ Payment account editing cancelled."
          );
        }

        // ------------------------------------------------------
        // EDIT — ACCOUNT NAME
        // ------------------------------------------------------

        if (
          edit.step ===
          "account_name"
        ) {

          if (!text) {

            return ctx.reply(
              "❌ Account name cannot be empty."
            );

          }

          if (
            text.length > 100
          ) {

            return ctx.reply(
              "❌ Account name cannot exceed 100 characters."
            );

          }

          edit.accountName =
            text.substring(
              0,
              100
            );

          edit.step =
            "account_number";

          const isMobile =
            String(
              edit.paymentTypeName || ""
            )
              .trim()
              .toLowerCase() ===
              "mobile" ||

            String(
              edit.paymentTypeAmharicName || ""
            ).trim() === "ሞባይል";

          return ctx.reply(

            "✏️ *ACCOUNT NAME UPDATED*\n\n" +

            `👤 Name: *${edit.accountName}*\n\n` +

            `📱 Current account number: \`${edit.accountNumber}\`\n\n` +

            (
              isMobile
                ? "Enter the new *mobile account number*."
                : "Enter the new *account number*."
            ),

            {
              parse_mode:
                "Markdown",

              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "✅ Keep Current",

                      callback_data:
                        `admin_account_edit_keep_number_${edit.accountId}`
                    }
                  ],
                  [
                    {
                      text:
                        "❌ Cancel",

                      callback_data:
                        "admin_account_edit_cancel"
                    }
                  ]
                ]
              }

            }

          );
        }

        // ------------------------------------------------------
        // EDIT — ACCOUNT NUMBER
        // ------------------------------------------------------

        if (
          edit.step ===
          "account_number"
        ) {

          if (!text) {

            return ctx.reply(
              "❌ Account number cannot be empty."
            );

          }

          const normalizedAccountNumber =
            normalizePaymentAccountNumber(
              text,
              edit.paymentTypeName,
              edit.paymentTypeAmharicName
            );

          if (
            !normalizedAccountNumber
          ) {

            return ctx.reply(
              "❌ Invalid account number.\n\n" +
              "Please enter a valid account number."
            );

          }

          if (
            normalizedAccountNumber.length >
            100
          ) {

            return ctx.reply(
              "❌ Account number cannot exceed 100 characters."
            );

          }

          edit.accountNumber =
            normalizedAccountNumber;

          edit.step =
            "balance";

          return ctx.reply(

            "✏️ *ACCOUNT NUMBER UPDATED*\n\n" +

            `👤 Name: *${edit.accountName}*\n` +

            `📱 Account: \`${edit.accountNumber}\`\n\n` +

            `💰 Current balance: *${edit.balance} ETB*\n\n` +

            "Enter the new balance in ETB.",

            {
              parse_mode:
                "Markdown",

              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "✅ Keep Current",

                      callback_data:
                        `admin_account_edit_keep_balance_${edit.accountId}`
                    }
                  ],
                  [
                    {
                      text:
                        "❌ Cancel",

                      callback_data:
                        "admin_account_edit_cancel"
                    }
                  ]
                ]
              }

            }

          );
        }

        // ------------------------------------------------------
        // EDIT — BALANCE
        // ------------------------------------------------------

        if (
          edit.step ===
          "balance"
        ) {

          const balance =
            Number(
              text.replace(
                /,/g,
                ""
              )
            );

          if (
            !Number.isFinite(balance) ||
            balance < 0
          ) {

            return ctx.reply(

              "❌ Invalid balance.\n\n" +

              "Please enter a number greater than or equal to 0.\n\n" +

              "Examples:\n" +
              "`0`\n" +
              "`5000`\n" +
              "`12500.50`",

              {
                parse_mode:
                  "Markdown"
              }

            );

          }

          edit.balance =
            balance;

          edit.step =
            "confirm";

          return showAdminAccountEditConfirmation(
            ctx,
            edit
          );
        }

        return;
      }


      // ========================================================
      // 2. ADD PAYMENT ACCOUNT
      // ========================================================

      const account =
        pendingAdminAccount[
          telegramId
        ];

      if (account) {

        const admin =
          await getCurrentAdmin(ctx);

        if (!admin) {

          delete pendingAdminAccount[
            telegramId
          ];

          return ctx.reply(
            "❌ You are not authorized to create payment accounts."
          );

        }

        // ------------------------------------------------------
        // CANCEL
        // ------------------------------------------------------

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

        // ------------------------------------------------------
        // ACCOUNT NAME
        // ------------------------------------------------------

        if (
          account.step ===
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

          account.accountName =
            text.substring(
              0,
              100
            );

          account.step =
            "account_number";

          const isMobile =
            String(
              account.paymentTypeName || ""
            )
              .trim()
              .toLowerCase() ===
              "mobile" ||

            String(
              account.paymentTypeAmharicName || ""
            ).trim() === "ሞባይል";

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

        // ------------------------------------------------------
        // ACCOUNT NUMBER
        // ------------------------------------------------------

        if (
          account.step ===
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
              account.paymentTypeName,
              account.paymentTypeAmharicName
            );

          const isMobile =
            String(
              account.paymentTypeName || ""
            )
              .trim()
              .toLowerCase() ===
              "mobile" ||

            String(
              account.paymentTypeAmharicName || ""
            ).trim() === "ሞባይል";

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

          account.accountNumber =
            normalizedAccountNumber;

          account.step =
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

        // ------------------------------------------------------
        // INITIAL BALANCE
        // ------------------------------------------------------

        if (
          account.step ===
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

                account.paymentMethodId,

                account.accountName,

                account.accountNumber,

                initialBalance

              );

            if (
              !result ||
              result.success !== true
            ) {

              return ctx.reply(
                `❌ ${
                  result?.message ||
                  "Could not create payment account."
                }`
              );

            }

            delete pendingAdminAccount[
              telegramId
            ];

            const createdAccount =
              result.account;

            return ctx.reply(

              "✅ *PAYMENT ACCOUNT CREATED*\n\n" +

              `💳 Method: *${
                createdAccount.pm_amharic_name ||
                createdAccount.pm_name
              }*\n` +

              `📂 Type: *${
                createdAccount.pt_amharic_name ||
                createdAccount.pt_name ||
                "-"
              }*\n` +

              `👤 Name: *${createdAccount.account_name}*\n` +

              `📱 Account: \`${createdAccount.account_number}\`\n` +

              `💰 Initial Balance: *${createdAccount.balance} ETB*\n` +

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

            return ctx.reply(
              "❌ Could not create the payment account.\n\n" +
              "Please try again."
            );

          }

        }

        return;
      }


      // ========================================================
      // 3. ADMIN WITHDRAWAL REJECTION REASON
      // ========================================================

      const reject =
        pendingAdminReject[
          telegramId
        ];

      if (reject) {

        const admin =
          await getCurrentAdmin(ctx);

        if (!admin) {

          delete pendingAdminReject[
            telegramId
          ];

          return ctx.reply(
            "❌ You are not authorized."
          );

        }

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
          reject.withdrawalId;

        const reason =
          text.substring(
            0,
            500
          );

        delete pendingAdminReject[
          telegramId
        ];

        try {

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
              `❌ ${
                result?.message ||
                "Withdrawal rejection failed."
              }`
            );

          }

          await ctx.reply(

            "❌ *WITHDRAWAL REJECTED*\n\n" +

            `🆔 #${withdrawalId}\n` +

            `👤 User: *${
              result.user_name ||
              reject.withdrawal.name ||
              "Unknown"
            }*\n` +

            `💰 Amount: *${
              result.amount ||
              reject.withdrawal.amount
            } ETB*\n\n` +

            `📝 Reason:\n${reason}\n\n` +

            `👑 Rejected by: ${
              admin.name ||
              admin.telegram_id
            }`,

            {
              parse_mode:
                "Markdown"
            }

          );

          try {

            await bot.api.sendMessage(

              reject.withdrawal.telegram_id,

              "❌ *የወጪ ጥያቄዎ ተቀባይነት አላገኘም።*\n\n" +

              `💰 መጠን፦ *${
                result.amount ||
                reject.withdrawal.amount
              } ETB*\n\n` +

              `📝 ምክንያት፦\n${reason}`,

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

          return showPendingWithdrawals(
            ctx
          );

        } catch (err) {

          console.error(
            "Withdrawal rejection error:",
            err
          );

          return ctx.reply(
            "❌ Withdrawal rejection failed."
          );

        }

      }


      // ========================================================
      // 4. ADMIN MANAGE USER
      // ========================================================

      const userSearchState =
        pendingAdminUserSearch.get(
          telegramId
        );

      if (
        userSearchState &&
        userSearchState.step ===
          "waiting_phone"
      ) {

        const admin =
          await db.getAdminByTelegramId(
            telegramId
          );

        if (
          !admin ||
          admin.admin_role !==
            "main"
        ) {

          pendingAdminUserSearch.delete(
            telegramId
          );

          return ctx.reply(
            "⛔ You are not authorized to manage users."
          );

        }

        const user =
          await db.getUserByPhoneForAdmin(
            text
          );

        if (!user) {

          return ctx.reply(

            `❌ *User not found*\n\n` +

            `📱 Phone: \`${text}\`\n\n` +

            "Please send another phone number or press Cancel.",

            {
              parse_mode:
                "Markdown",

              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "🏠 Home",

                      callback_data:
                        "admin_home"
                    }
                  ],
                  [
                    {
                      text:
                        "❌ Cancel",

                      callback_data:
                        "admin_manage_user_cancel"
                    }
                  ]
                ]
              }

            }

          );

        }

        if (
          String(
            user.telegram_id
          ) ===
          String(
            telegramId
          )
        ) {

          return ctx.reply(
            "⚠️ You cannot block or unblock your own admin account."
          );

        }

        pendingAdminUserSearch.delete(
          telegramId
        );

        const keyboard = [];

        if (
          user.is_blocked
        ) {

          keyboard.push([
            {
              text:
                "✅ Unblock User",

              callback_data:
                `admin_unblock_user_${user.id}`
            }
          ]);

        } else {

          keyboard.push([
            {
              text:
                "🚫 Block User",

              callback_data:
                `admin_block_user_${user.id}`
            }
          ]);

        }

        keyboard.push([
          {
            text:
              "👤 Manage Another User",

            callback_data:
              "admin_manage_user"
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

        keyboard.push([
          {
            text:
              "❌ Close",

            callback_data:
              "admin_manage_user_cancel"
          }
        ]);

        return ctx.reply(

          `👤 *USER FOUND*\n\n` +

          `👤 Name: *${
            user.name ||
            "Unknown"
          }*\n` +

          `📱 Phone: \`${
            user.phone ||
            "Not available"
          }\`\n` +

          `🔐 Blocked: ${
            user.is_blocked
              ? "🚫 Yes"
              : "✅ No"
          }\n` +

          `📌 Status: ${
            user.is_active
              ? "🟢 Active"
              : "⚪ Inactive"
          }`,

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


      // ========================================================
      // 5. ADMIN ROLE / USER FINANCIAL STATISTICS SEARCH
      // ========================================================

      const roleSearchState =
        pendingAdminRoleSearch.get(
          telegramId
        );

      if (
        roleSearchState
      ) {

        // ------------------------------------------------------
        // MANAGE ADMIN
        // ------------------------------------------------------

        if (
          roleSearchState.step ===
          "waiting_phone"
        ) {

          const admin =
            await db.getAdminByTelegramId(
              telegramId
            );

          if (
            !admin ||
            admin.admin_role !==
              "main"
          ) {

            pendingAdminRoleSearch.delete(
              telegramId
            );

            return ctx.reply(
              "⛔ You are not authorized to manage admins."
            );

          }

          const user =
            await db.getUserByPhoneForAdmin(
              text
            );

          if (!user) {

            return ctx.reply(

              `❌ *User not found*\n\n` +

              `📱 Phone: \`${text}\`\n\n` +

              "Please send another phone number or press Cancel.",

              {
                parse_mode:
                  "Markdown",

                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text:
                          "🏠 Home",

                        callback_data:
                          "admin_home"
                      }
                    ],
                    [
                      {
                        text:
                          "❌ Cancel",

                        callback_data:
                          "admin_manage_admins_cancel"
                      }
                    ]
                  ]
                }
              }

            );

          }

          if (
            String(
              user.telegram_id
            ) ===
            String(
              telegramId
            )
          ) {

            return ctx.reply(
              "⚠️ You cannot change your own admin role."
            );

          }

          pendingAdminRoleSearch.delete(
            telegramId
          );

          const keyboard = [
            [
              {
                text:
                  "👑 Main Admin",

                callback_data:
                  `set_admin_main_${user.id}`
              }
            ],
            [
              {
                text:
                  "📊 Statistics Admin",

                callback_data:
                  `set_admin_statistics_${user.id}`
              }
            ],
            [
              {
                text:
                  "💸 Withdrawal Admin",

                callback_data:
                  `set_admin_withdrawal_${user.id}`
              }
            ],
            [
              {
                text:
                  "📢 Broadcast Admin",

                callback_data:
                  `set_admin_broadcast_${user.id}`
              }
            ]
          ];

          if (
            user.is_admin ===
            true
          ) {

            keyboard.push([
              {
                text:
                  "🚫 Remove Admin Rights",

                callback_data:
                  `remove_admin_${user.id}`
              }
            ]);

          }

          keyboard.push([
            {
              text:
                "👑 Manage Another Admin",

              callback_data:
                "admin_manage_admins"
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

          const currentRole =
            user.is_admin
              ? (
                  user.admin_role ===
                    "main"
                    ? "👑 Main Admin"
                    : user.admin_role ===
                      "statistics"
                    ? "📊 Statistics Admin"
                    : user.admin_role ===
                      "withdrawal"
                    ? "💸 Withdrawal Admin"
                    : user.admin_role ===
                      "broadcast"
                    ? "📢 Broadcast Admin"
                    : "Admin"
                )
              : "👤 Normal User";

          return ctx.reply(

            `👑 *MANAGE ADMIN*\n\n` +

            `👤 Name: *${
              user.name ||
              "Unknown"
            }*\n` +

            `📱 Phone: \`${
              user.phone ||
              text
            }\`\n` +

            `🔐 Current Role: *${currentRole}*\n\n` +

            "Select the new admin role:",

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


        // ------------------------------------------------------
        // USER FINANCIAL STATISTICS
        // ------------------------------------------------------

        if (
          roleSearchState.step ===
          "financial_statistics_phone"
        ) {

          const admin =
            await db.getAdminByTelegramId(
              telegramId
            );

          if (
            !admin ||
            (
              admin.admin_role !==
                "main" &&
              admin.admin_role !==
                "statistics"
            )
          ) {

            pendingAdminRoleSearch.delete(
              telegramId
            );

            return ctx.reply(
              "⛔ You are not authorized to view statistics."
            );

          }

          const user =
            await db.getUserByPhoneForAdmin(
              text
            );

          if (!user) {

            return ctx.reply(
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

            `👤 Name: *${
              user.name ||
              "Unknown"
            }*\n` +

            `📱 Phone: \`${
              user.phone ||
              text
            }\`\n\n` +

            `💎 *Total Deposits*\n` +

            `*${
              stats.totalDepositAmount.toFixed(2)
            } ETB*\n\n` +

            `🏧 *Withdrawals*\n` +

            `⏳ Pending: *${
              stats.pendingWithdrawalAmount.toFixed(2)
            } ETB*\n` +

            `✅ Approved: *${
              stats.approvedWithdrawalAmount.toFixed(2)
            } ETB*\n` +

            `❌ Rejected: *${
              stats.rejectedWithdrawalAmount.toFixed(2)
            } ETB*`;

          return ctx.reply(

            message,

            {
              parse_mode:
                "Markdown",

              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "👤 Search Another User",

                      callback_data:
                        "admin_user_financial_statistics"
                    }
                  ],
                  [
                    {
                      text:
                        "⬅️ Statistics",

                      callback_data:
                        "admin_statistics_menu"
                    },
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

        }

      }


      // ========================================================
      // 6. REGISTRATION
      // ========================================================

      const registration =
        pendingPhone[
          telegramId
        ];

      if (
        registration
      ) {

        if (
          registration.step ===
          "ask_name"
        ) {

          if (
            !text ||
            text.startsWith("/")
          ) {

            return next();

          }

          registration.name =
            text.substring(
              0,
              30
            );

          registration.step =
            "ask_phone";

          return ctx.reply(

            `Nice to meet you, *${registration.name}!*\n\n` +

            "Please share your phone number so we can verify your account:",

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

        }

      }


      // ========================================================
      // 7. DEPOSIT SMS
      // ========================================================

      const deposit =
        pendingDeposit[
          telegramId
        ];

      if (
        deposit
      ) {

        if (
          text.startsWith("/")
        ) {

          return next();

        }

        try {

          const paymentMethod =
            ctx.session.paymentMethod;

          const paymentType =
            ctx.session.paymentType;

          await ctx.reply(
            "✅⏳ የክፍያ መልዕክትዎ ደርሶናል። ክፍያዎ እየተረጋገጠ ነው። እባክዎ ትንሽ ይጠብቁ።"
          );

          const result =
            await processDeposit(

              text,

              paymentMethod.name,
              paymentMethod.amharicName,

              paymentType.name,
              paymentType.amharicName

            );

          if (
            typeof result ===
              "object" &&
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

          return ctx.reply(
            "❌ የክፍያውን ማረጋገጥ አልተቻለም።"
          );

        }

      }


      

// ========================================================
// 10. BROADCAST
// ========================================================

const admin =
  await getCurrentAdmin(ctx);

if (admin) {

  const adminTelegramId =
    admin.telegram_id;

  const draft =
    await db.getBroadcastDraft(
      adminTelegramId
    );

  // --------------------------------------------------------
  // BROADCAST CANCEL
  // --------------------------------------------------------

  if (
    text === "/cancel" &&
    draft
  ) {

      pendingBroadcastRecipient.delete(
    adminTelegramId
  );

    await db.deleteBroadcastDraft(
      adminTelegramId
    );

    return ctx.reply(
      "❌ Broadcast cancelled."
    );
  }

  // --------------------------------------------------------
  // DO NOT INTERCEPT ADMIN REJECTION
  // --------------------------------------------------------

  if (
    pendingAdminReject[
      adminTelegramId
    ]
  ) {
    return next();
  }

  if (draft) {
    // ============================================================
// BROADCAST SPECIFIC RECIPIENT PHONE
// ============================================================

if (
  draft &&
  draft.status ===
    "waiting_broadcast_phone"
) {

  const phone =
    text.trim();

  if (
    phone === "/cancel"
  ) {

    pendingBroadcastRecipient.delete(
      adminTelegramId
    );

    await db.updateBroadcastStatus(
      adminTelegramId,
      "preview"
    );

    return ctx.reply(
      "❌ Specific-person broadcast cancelled.\n\n" +
      "The broadcast draft is still available."
    );
  }

  const user =
    await db.getUserByPhone(
      phone
    );

  if (!user) {

    return ctx.reply(
      "❌ *User not found.*\n\n" +
      "Make sure the phone number is registered and the account is active.\n\n" +
      "Example:\n" +
      "`0912345678`\n\n" +
      "or\n" +
      "`+251912345678`",
      {
        parse_mode: "Markdown"
      }
    );
  }

  // ----------------------------------------------------------
  // SAVE RECIPIENT IN ADMIN STATE
  // ----------------------------------------------------------

  pendingBroadcastRecipient.set(
    adminTelegramId,
    {
      step: "confirm",
      userTelegramId:
        user.telegram_id,
      userId:
        user.id,
      phone:
        user.phone,
      name:
        user.name
    }
  );

  await db.updateBroadcastStatus(
    adminTelegramId,
    "specific_recipient_confirm"
  );

  return ctx.reply(
    "👤 *Recipient Found*\n\n" +
    `👤 Name: *${user.name || "Unknown"}*\n` +
    `📱 Phone: \`${user.phone || phone}\`\n\n` +
    "Do you want to send the broadcast to this person?",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ SEND",
              callback_data:
                "broadcast_specific_confirm"
            }
          ],
          [
            {
              text: "❌ CANCEL",
              callback_data:
                "broadcast_cancel_specific"
            }
          ]
        ]
      }
    }
  );
}

    // ------------------------------------------------------
    // MESSAGE
    // ------------------------------------------------------

    if (
      draft.status ===
      "waiting_message"
    ) {

      await db.updateBroadcastMessage(
        adminTelegramId,
        text
      );

      await ctx.reply(
        "✅ Message received."
      );

      return continueBroadcastBuilder(
        ctx,
        adminTelegramId
      );
    }


    // ------------------------------------------------------
    // BUTTON TITLE
    // ------------------------------------------------------

    if (
      draft.status ===
      "waiting_button_title"
    ) {

      const buttonTitle =
        text.trim();

      if (!buttonTitle) {
        return ctx.reply(
          "❌ Button title cannot be empty."
        );
      }

      if (
        buttonTitle.length > 64
      ) {
        return ctx.reply(
          "❌ Button title must be 64 characters or fewer."
        );
      }

      await db.updateBroadcastButtonTitle(
        adminTelegramId,
        buttonTitle
      );

      await ctx.reply(
        "✅ Play button title saved."
      );

      return continueBroadcastBuilder(
        ctx,
        adminTelegramId
      );
    }

  }
}

      // ========================================================
      // NOTHING CLAIMED THIS MESSAGE
      // ========================================================

      return next();

    } catch (err) {

      console.error(
        "Unified message:text handler error:",
        err
      );

      return next();

    }

  }
);


// ============================================================
// BROADCAST CONFIRM
// ============================================================

bot.callbackQuery(
  "broadcast_confirm",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(
        ctx
      );

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

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

    // --------------------------------------------------------
    // SECURITY / VALIDATION
    // --------------------------------------------------------

    if (
      !isBroadcastDraftComplete(
        draft
      )
    ) {
      return ctx.editMessageText(
        "❌ Broadcast information is incomplete."
      );
    }

    const users =
      await db.getAllActiveUsers();

    await ctx.editMessageText(
      `📢 Broadcasting...\n\n` +
      `👥 Users: ${users.length}\n\n` +
      `⏳ Please wait...`
    );

    let sent = 0;
    let failed = 0;

    // --------------------------------------------------------
    // SEND TO EVERY USER
    // --------------------------------------------------------

    for (
      const user of users
    ) {

      try {

        const replyMarkup =
          getBroadcastKeyboard(
            draft,
            user.telegram_id
          );

        // ----------------------------------------------------
        // IMAGE BROADCAST
        // ----------------------------------------------------

        if (
          draft.include_image === true
        ) {

          await bot.api.sendPhoto(
            user.telegram_id,
            draft.image_url,
            {
              caption:
                draft.include_text === true
                  ? draft.message
                  : undefined,

              reply_markup:
                replyMarkup
            }
          );

        }

        // ----------------------------------------------------
        // TEXT-ONLY BROADCAST
        // ----------------------------------------------------

        else if (
          draft.include_text === true
        ) {

          await bot.api.sendMessage(
            user.telegram_id,
            draft.message,
            {
              reply_markup:
                replyMarkup
            }
          );

        }

        sent++;

        // Small delay between users
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

    // --------------------------------------------------------
    // DELETE DRAFT
    // --------------------------------------------------------

    await db.deleteBroadcastDraft(
      adminTelegramId
    );

    // --------------------------------------------------------
    // RESULT
    // --------------------------------------------------------

    await ctx.reply(
      `📢 *Broadcast completed!*\n\n` +
      `👥 Total: ${users.length}\n` +
      `✅ Sent: ${sent}\n` +
      `❌ Failed: ${failed}`,
      {
        parse_mode: "Markdown"
      }
    );
  }
);



// ============================================================
// BROADCAST TO SPECIFIC PERSON
// ============================================================

bot.callbackQuery(
  "broadcast_specific",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const adminTelegramId =
      admin.telegram_id;

    const draft =
      await db.getBroadcastDraft(
        adminTelegramId
      );

    if (!draft) {
      return ctx.reply(
        "❌ Broadcast draft not found."
      );
    }

    if (!isBroadcastDraftComplete(draft)) {
      return ctx.reply(
        "❌ Broadcast information is incomplete."
      );
    }

    // Remember that the next text message is a
    // phone number for a specific broadcast recipient.
    pendingBroadcastRecipient.set(
      adminTelegramId,
      {
        step: "waiting_phone"
      }
    );

    await db.updateBroadcastStatus(
      adminTelegramId,
      "waiting_broadcast_phone"
    );

    await ctx.reply(
      "👤 *Send to Specific Person*\n\n" +
      "Please send the user's phone number.\n\n" +
      "Example:\n" +
      "`0912345678`\n\n" +
      "or\n" +
      "`+251912345678`\n\n" +
      "❌ Send /cancel to cancel.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel",
                callback_data:
                  "broadcast_cancel_specific"
              }
            ]
          ]
        }
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
      await getCurrentAdmin(
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
// CONFIRM SPECIFIC RECIPIENT
// ============================================================

bot.callbackQuery(
  "broadcast_specific_confirm",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

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

    if (!isBroadcastDraftComplete(draft)) {
      return ctx.editMessageText(
        "❌ Broadcast information is incomplete."
      );
    }

    const recipient =
      pendingBroadcastRecipient.get(
        adminTelegramId
      );

    if (
      !recipient ||
      !recipient.userTelegramId
    ) {
      return ctx.editMessageText(
        "❌ Recipient information expired. Please try again."
      );
    }

    const telegramId =
      recipient.userTelegramId;

    try {

      const replyMarkup =
        getBroadcastKeyboard(
          draft,
          telegramId
        );

      // ------------------------------------------------------
      // IMAGE
      // ------------------------------------------------------

      if (
        draft.include_image === true
      ) {

        await bot.api.sendPhoto(
          telegramId,
          draft.image_url,
          {
            caption:
              draft.include_text === true
                ? draft.message
                : undefined,

            reply_markup:
              replyMarkup
          }
        );

      }

      // ------------------------------------------------------
      // TEXT ONLY
      // ------------------------------------------------------

      else if (
        draft.include_text === true
      ) {

        await bot.api.sendMessage(
          telegramId,
          draft.message,
          {
            reply_markup:
              replyMarkup
          }
        );
      }

      pendingBroadcastRecipient.delete(
        adminTelegramId
      );

      await db.deleteBroadcastDraft(
        adminTelegramId
      );

      await ctx.editMessageText(
        "✅ *Broadcast sent successfully.*\n\n" +
        `👤 Recipient: ${recipient.name || "Unknown"}\n` +
        `📱 Phone: \`${recipient.phone || "Unknown"}\``,
        {
          parse_mode: "Markdown"
        }
      );

    } catch (err) {

      console.error(
        "Specific broadcast error:",
        err
      );

      pendingBroadcastRecipient.delete(
        adminTelegramId
      );

      await ctx.editMessageText(
        "❌ Failed to send the broadcast to this user.\n\n" +
        "The broadcast draft has NOT been deleted. " +
        "You can try again."
      );
    }
  }
);
// ============================================================
// CANCEL SPECIFIC RECIPIENT
// ============================================================

bot.callbackQuery(
  "broadcast_cancel_specific",
  async (ctx) => {

    const admin =
      await getCurrentAdmin(ctx);

    if (!admin) {
      return;
    }

    await answerCallback(ctx);

    const adminTelegramId =
      admin.telegram_id;

    pendingBroadcastRecipient.delete(
      adminTelegramId
    );

    const draft =
      await db.getBroadcastDraft(
        adminTelegramId
      );

    if (draft) {

      await db.updateBroadcastStatus(
        adminTelegramId,
        "preview"
      );
    }

    await ctx.editMessageText(
      "❌ Specific-person sending cancelled.\n\n" +
      "Your broadcast draft is still saved."
    );
  }
);
// ============================================================
// ERROR HANDLER
// ============================================================
bot.catch((err) => {console.error("Telegram bot error:", err.error); });
// ============================================================
// VERCEL WEBHOOK
// ============================================================
module.exports =  webhookCallback(bot,"http");
