/**
 * telegram-bot.js — Beteseb Bingo Telegram Bot
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

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAME_URL =
  process.env.GAME_URL || "https://sisters-bingo.vercel.app";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN environment variable is missing");
}

const bot = new Bot(BOT_TOKEN);

// State machine: pending registrations waiting for phone
const pendingPhone = {}; // telegramId -> { name, step }


// ─────────────────────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const telegramId = ctx.from.id;
  const firstName = ctx.from.first_name || "Player";

  try {
    // Check if already registered
    const existing = await db.getUserByTelegramId(telegramId);

    if (existing) {
      return await ctx.reply(
        `Welcome back, *${existing.name}!* 🎱\n` +
        `Your balance: *${existing.balance} ETB*`,
          {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Play 🎱",
                  web_app: {
                    url: `${GAME_URL}?tid=${telegramId}`,
                  },
                },
              ],
              [
              {
                  text: "Balance 💰",
                  callback_data: "balance",
                },
              {
                  text: "Transfer 🔄",
                  callback_data: "transfer",
                },
              ],
              [
              {
                  text: "Deposit 💎",
                  callback_data: "deposit",
                },
              {
                  text: "Withdraw 🏧",
                  callback_data: "withdraw",
                },
              ],
              [
              {
                  text: "Support 🆘",
                  callback_data: "support",
                },
              {
                  text: "Delete 🗑️",
                  callback_data: "delete",
                },
              ],              
            ],
          },
        }
      );
    }

    // New user — start registration
    pendingPhone[telegramId] = {
      name: firstName,
      step: "ask_name",
    };

    await ctx.reply(
      `👋 Welcome to *Sisters Bingo!*\n\n` +
      `Let's get you registered.\n` +
      `What should we call you?`,
      {
        parse_mode: "Markdown",
      }
    );
  } catch (err) {
    console.error("Start error:", err);
    await ctx.reply("❌ Something went wrong. Please try again.");
  }
});


// ─────────────────────────────────────────────────────────────
// Handle text messages — registration flow
// ─────────────────────────────────────────────────────────────

bot.on("message:text", async (ctx, next) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text;
  const pending = pendingPhone[telegramId];

   if (!pending) {
    return next();
  }

  // User is entering their name
  if (
    pending.step === "ask_name" &&
    text &&
    !text.startsWith("/")
  ) {
    pending.name = text.trim().substring(0, 30);
    pending.step = "ask_phone";

    await ctx.reply(
      `Nice to meet you, *${pending.name}!*\n\n` +
      `Please share your phone number so we can verify your account:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [
            [
              {
                text: "📱 Share My Phone Number",
                request_contact: true,
              },
            ],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
  }
   return next();
});


// ─────────────────────────────────────────────────────────────
// Handle contact / phone number
// ─────────────────────────────────────────────────────────────

bot.on("message:contact", async (ctx) => {
  const telegramId = ctx.from.id;
  const pending = pendingPhone[telegramId];

  if (!pending || pending.step !== "ask_phone") {
    return;
  }

  const contact = ctx.message.contact;
  const phone = contact.phone_number;
  const name = pending.name;

  // Optional security check:
  // Make sure the shared contact belongs to the Telegram user
  if (contact.user_id && contact.user_id !== telegramId) {
    await ctx.reply(
      "❌ Please use the button to share your own phone number."
    );
    return;
  }

  try {
    const user = await db.registerUser(
      telegramId,
      name,
      phone
    );

    delete pendingPhone[telegramId];

    await ctx.reply(
      `✅ *Registered successfully!*\n\n` +
      `Name: *${user.name}*\n` +
      `Phone: ${phone}\n` +
      `Starting balance: *${user.balance} ETB*\n\n` +
      `You're all set — tap below to play! 🎱`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎮 Play Beteseb Bingo",
                web_app: {
                  url: `${GAME_URL}?tid=${telegramId}`,
                },
              },
            ],
          ],
        },
      }
    );

    // Remove the phone keyboard
    await ctx.reply("Choose an option:", {
      reply_markup: {
        keyboard: [["🎮 Play", "💰 Balance"], ["📊 Leaderboard"], ],
        resize_keyboard: true,
      },
    });
  } catch (err) {
    console.error("Registration error:", err);

    await ctx.reply(
      "❌ Registration failed. Please try /start again."
    );
  }
});


// ─────────────────────────────────────────────────────────────
// /balance
// ─────────────────────────────────────────────────────────────

async function showBalance(ctx) {
  const user = await db.getUserByTelegramId(ctx.from.id);

  if (!user) {
    return await ctx.reply(
      "Please /start to register first."
    );
  }

  await ctx.reply(
    `💰 Your balance: *${user.balance} ETB*`,
    {
      parse_mode: "Markdown",
    }
  );
}

bot.command("balance", showBalance);
bot.hears("balance", showBalance);
bot.callbackQuery("balance", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showBalance(ctx);
});

// ─────────────────────────────────────────────────────────────
// /deposit
// ─────────────────────────────────────────────────────────────

async function showDeposit(ctx) {
  const user = await db.getUserByTelegramId(ctx.from.id);

  if (!user) {
    return await ctx.reply(
      "Please /start to register first."
    );
  }

  await ctx.reply(
    "❇️ ብር ማስገባት የሚችሉት አሁን በተቀመጠዉ የTelebirr አካዉንት ብቻ ነዉ።\n\n" +
    "🚫 ከዚህ ዉጭ የላከ አናስተናግድም 🚫\n\n" +
    "👇 Telebirr የሚለዉን ይምረጡ 👇",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📱 Telebirr",
              callback_data: "telebirr",
            },
          ],
          [
            {
              text: "Cancel ❌",
              callback_data: "canceldeposit",
            },
          ],
        ],
      },
    }
  );
}

bot.command("deposit", showDeposit);
bot.hears("deposit", showDeposit);

bot.callbackQuery("deposit", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showDeposit(ctx);
});

bot.callbackQuery("telebirr", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    "1. ከታች ባለው የቴሌብር አካውንት ብር ያስገቡ\n\n" +
    "📞 *Telebirr:* `09XXXXXXXX`\n\n" +
    "2. የከፈሉበትን አጭር የጹሁፍ መልዕክት(message) copy በማድረግ እዚ ላይ Past አድረገው ያስገቡና ይላኩት👇👇👇",
    {
      parse_mode: "Markdown",
    }
  );
});

bot.on("message:text", async (ctx, next) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text;

  // Is this user currently making a deposit?
  if (pendingDeposit[telegramId]) {
    console.log("📩 Telebirr message received:", text);

    // Remove waiting state
    delete pendingDeposit[telegramId];

    await ctx.reply(
      "✅ የክፍያ መልዕክትዎ ደርሶናል።\n\n" +
      "⏳ ክፍያዎ እየተረጋገጠ ነው።"
    );

    // Later you can process the Telebirr SMS here
    // Example:
    // await processTelebirrPayment(ctx.from.id, text);

    return;
  }

  // Let the other handlers process this message
  return next();
});
bot.callbackQuery("canceldeposit", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    "የገቢ ጥያቄዎ ተሰርዟል። ❌" +
    {
      parse_mode: "Markdown",
    }
  );
});
// ─────────────────────────────────────────────────────────────
// /Support
// ─────────────────────────────────────────────────────────────
async function showSupport(ctx) {
  const user = await db.getUserByTelegramId(ctx.from.id);

  if (!user) {
    return await ctx.reply(
      "Please /start to register first."
    );
  }

  await ctx.reply(
    "🆘 ድጋፍ ይፈልጋሉ?\n\n" + 
    "👇 ለማንኛውም ጥያቄ ወይም አስተያየት 👇\n\n"+
    "👤 @sistersbingosupport",
    {
      parse_mode: "Markdown",
    }
  );
}

bot.command("support", showSupport);
bot.hears("support", showSupport);
bot.callbackQuery("support", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSupport(ctx);
});

// ─────────────────────────────────────────────────────────────
// /leaderboard
// ─────────────────────────────────────────────────────────────

async function showLeaderboard(ctx) {
  const rows = await db.getLeaderboard(10);

  const medals = ["🥇", "🥈", "🥉"];

  const text = rows
    .map((r, i) => {
      const position = medals[i] || `${i + 1}.`;

      return (
        `${position} *${r.name}* — ` +
        `${r.total_winnings} ETB ` +
        `(${r.total_wins} wins)`
      );
    })
    .join("\n");

  await ctx.reply(
    `🏆 *Leaderboard*\n\n${text || "No games yet!"}`,
    {
      parse_mode: "Markdown",
    }
  );
}

bot.command("leaderboard", showLeaderboard);
bot.hears("📊 Leaderboard", showLeaderboard);
bot.callbackQuery("leaderboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showLeaderboard(ctx);
});


// ─────────────────────────────────────────────────────────────
// /play
// ─────────────────────────────────────────────────────────────

async function showPlay(ctx) {
  const user = await db.getUserByTelegramId(ctx.from.id);

  if (!user) {
    return await ctx.reply(
      "Please /start to register first."
    );
  }

  await ctx.reply(
    `Ready to play, *${user.name}*? 🎱\n` +
    `Balance: *${user.balance} ETB*`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🎮 Open Beteseb Bingo",
              web_app: {
                url: `${GAME_URL}?tid=${ctx.from.id}`,
              },
            },
          ],
        ],
      },
    }
  );
}

bot.command("play", showPlay);
bot.hears("🎮 Play", showPlay);



// ─────────────────────────────────────────────────────────────
// Vercel webhook handler
// ─────────────────────────────────────────────────────────────

module.exports = webhookCallback(bot, "http");
