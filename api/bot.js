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
const { processDeposit } = require("../deposit");

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAME_URL =
  process.env.GAME_URL || "https://sisters-bingo.vercel.app";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN environment variable is missing");
}

const bot = new Bot(BOT_TOKEN);


// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

// Registration state
// telegramId -> { name, step }
const pendingPhone = {};

// Deposit state
// telegramId -> true
//
// NOTE:
// For production on Vercel, this should eventually be stored
// in PostgreSQL instead of memory.
const pendingDeposit = {};


// ─────────────────────────────────────────────────────────────
// Safe callback answer
// ─────────────────────────────────────────────────────────────

async function answerCallback(ctx, text = undefined) {
  try {
    if (text) {
      await ctx.answerCallbackQuery({
        text,
      });
    } else {
      await ctx.answerCallbackQuery();
    }
  } catch (err) {
    console.log(
      "Callback answer failed:",
      err.description || err.message
    );
  }
}


// ─────────────────────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const telegramId = ctx.from.id;
  const firstName = ctx.from.first_name || "Player";

  try {
    const existing = await db.getUserByTelegramId(telegramId);

    // Existing user
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

    // New user
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

    await ctx.reply(
      "❌ Something went wrong. Please try again."
    );
  }
});


// ─────────────────────────────────────────────────────────────
// Registration text flow
// ─────────────────────────────────────────────────────────────

bot.on("message:text", async (ctx, next) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text;

  const pending = pendingPhone[telegramId];

  if (!pending) {
    return next();
  }

  // Ask name
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

    return;
  }

  return next();
});


// ─────────────────────────────────────────────────────────────
// Registration contact / phone
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

  // Make sure the shared contact belongs to this Telegram user
  if (
    contact.user_id &&
    contact.user_id !== telegramId
  ) {
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

    // Remove phone keyboard
    await ctx.reply("Choose an option:", {
      reply_markup: {
        keyboard: [
          ["🎮 Play", "💰 Balance"],
          ["📊 Leaderboard"],
        ],
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
// BALANCE
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

bot.hears("💰 Balance", showBalance);

bot.callbackQuery("balance", async (ctx) => {
  await answerCallback(ctx);

  await showBalance(ctx);
});


// ─────────────────────────────────────────────────────────────
// DEPOSIT
// ─────────────────────────────────────────────────────────────

async function showDeposit(ctx) {
  const user = await db.getUserByTelegramId(ctx.from.id);

  if (!user) {
    return await ctx.reply(
      "Please /start to register first."
    );
  }

  const paymentmethods =
    await db.getPaymentMethods();

  if (
    !paymentmethods ||
    paymentmethods.length === 0
  ) {
    return await ctx.reply(
      "ይቅርታ! ለጊዜው የክፍያ መንገድ አልተዘጋጀም::"
    );
  }

  let mes =
    "❇️ ብር ማስገባት የሚችሉት ቀጥሎ በተቀመጡት የ";

  if (paymentmethods.length === 1) {

    mes += paymentmethods[0].amharic_name;

  } else {

    for (
      let i = 0;
      i < paymentmethods.length - 1;
      i++
    ) {
      mes +=
        paymentmethods[i].amharic_name +
        ", ";
    }

    mes +=
      paymentmethods[
        paymentmethods.length - 1
      ].amharic_name;
  }

  mes +=
    " አማራጮች ብቻ ነው።\n\n";

  mes +=
    "🚫 ከዚህ ዉጭ የላከ አናስተናግድም 🚫\n\n";


  // Create buttons from database
  const buttons = paymentmethods.map((pm) => [
    {
      text: `${pm.emoji} ${pm.amharic_name}`,
      callback_data: `payment_${pm.id}`,
    },
  ]);


  // Cancel button
  buttons.push([
    {
      text: "❌ ሰርዝ",
      callback_data: "canceldeposit",
    },
  ]);


  await ctx.reply(mes, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}


bot.command("deposit", showDeposit);

bot.hears("deposit", showDeposit);

bot.callbackQuery("deposit", async (ctx) => {
  // Answer FIRST
  await answerCallback(ctx);

  await showDeposit(ctx);
});


// ─────────────────────────────────────────────────────────────
// Dynamic payment method button
// payment_1
// payment_2
// payment_3
// ─────────────────────────────────────────────────────────────

bot.callbackQuery(
  /^payment_(\d+)$/,
  async (ctx) => {

    // Answer Telegram immediately
    await answerCallback(ctx);

    const paymentMethodId =
      Number(ctx.match[1]);

    console.log(
      "Selected payment method:",
      paymentMethodId
    );


    try {

      // Get selected payment method
      const paymentMethod =
        await db.getPaymentMethodById(
          paymentMethodId
        );


      if (!paymentMethod) {

        await ctx.reply(
          "❌ የክፍያ መንገዱ አልተገኘም።"
        );

        return;
      }


      console.log(
        "Payment method:",
        paymentMethod
      );


      // If your database uses name to determine
      // the payment method:
      if (
        paymentMethod.name
          .toLowerCase()
          .includes("telebirr")
      ) {

        pendingDeposit[ctx.from.id] = true;


        await ctx.editMessageText(
          "1. ከታች ባለው የቴሌብር አካውንት ብር ያስገቡ\n\n" +

          "📞 *Telebirr:* `09XXXXXXXX`\n\n" +

          "2. የከፈሉበትን አጭር የጹሁፍ መልዕክት (SMS) " +
          "copy በማድረግ እዚህ ላይ Paste አድርገው " +
          "ያስገቡና ይላኩት👇👇👇",
          {
            parse_mode: "Markdown",
          }
        );

        return;
      }


      // Other payment methods
      await ctx.reply(
        `${paymentMethod.emoji || "💳"} ` +
        `${paymentMethod.amharic_name}\n\n` +
        `ይህ የክፍያ መንገድ በቅርቡ ይገኛል።`
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


// ─────────────────────────────────────────────────────────────
// Telebirr SMS / deposit message
// ─────────────────────────────────────────────────────────────

bot.on("message:text", async (ctx, next) => {

  const telegramId = ctx.from.id;
  const text = ctx.message.text;


  // Is this user currently making a deposit?
  if (!pendingDeposit[telegramId]) {
    return next();
  }


  // Delete state immediately
  delete pendingDeposit[telegramId];


  console.log(
    "📩 Telebirr message received:",
    text
  );


  // Tell user immediately
  await ctx.reply(
    "✅ የክፍያ መልዕክትዎ ደርሶናል።\n\n" +
    "⏳ ክፍያዎ እየተረጋገጠ ነው።"
  );


  try {

    const result =
      await processDeposit(text);


    // processDeposit returned an object
    if (
      typeof result === "object" &&
      result !== null
    ) {

      const receipt =
        result.receipt;


      if (!receipt) {

        await ctx.reply(
          "❌ የክፍያ ደረሰኝ መረጃ አልተገኘም።"
        );

        return;
      }


      console.log(
        "Receipt:",
        receipt
      );


      console.log("before approve");


      const result2 =
        await db.approveDepositttttttttttt(
          receipt,
          telegramId
        );


      console.log(
        "after approve:",
        result2
      );


      if (result2 == 4) {

        await ctx.reply(
          "✅ *የገቢ ጥያቄዎ ተሳክቷል!*\n\n" +
          "💰 ገንዘቡ ወደ ሂሳብዎ ተጨምሯል።",
          {
            parse_mode: "Markdown",
          }
        );

      } else {

        await ctx.reply(
          "❌ የገቢ ጥያቄዎ አልተሳካም።\n\n" +
          `Error: ${result2}`
        );
      }


      return;
    }


    // processDeposit returned a numeric result
    switch (result) {

      case 1:

        await ctx.reply(
          "🚫 ጥያቄው አልተሳካም። " +
          "እባክዎ ስልክዎ ላይ የገባውን " +
          "ትክክለኛ ሚሴጅ (SMS) ኮፒ አድርገው ይላኩ፡፡\n\n" +
          "❓ ለድጋፍ @betesebbingosupport ላይ ይፃፉልን"
        );

        break;


      case 2:

        await ctx.reply(
          "🚫 ጥያቄው አልተሳካም። " +
          "እባክዎ ስልክዎ ላይ የገባውን " +
          "ትክክለኛ ሚሴጅ (SMS) ኮፒ አድርገው ይላኩ፡፡\n\n" +
          "❓ ለድጋፍ @betesebbingosupport ላይ ይፃፉልን"
        );

        break;


      default:

        await ctx.reply(
          "🚫 ጥያቄው አልተሳካም። " +
          "እባክዎ ስልክዎ ላይ የገባውን " +
          "ትክክለኛ ሚሴጅ (SMS) ኮፒ አድርገው ይላኩ፡፡\n\n" +
          "❓ ለድጋፍ @betesebbingosupport ላይ ይፃፉልን"
        );

        break;
    }

  } catch (err) {

    console.error(
      "Deposit processing error:",
      err
    );

    await ctx.reply(
      "❌ የክፍያውን ማረጋገጥ አልተቻለም። " +
      "እባክዎ ቆይተው እንደገና ይሞክሩ።"
    );
  }
});


// ─────────────────────────────────────────────────────────────
// Cancel deposit
// ─────────────────────────────────────────────────────────────

bot.callbackQuery(
  "canceldeposit",
  async (ctx) => {

    await answerCallback(ctx);

    // Cancel pending deposit state
    delete pendingDeposit[ctx.from.id];


    try {

      await ctx.editMessageText(
        "የገቢ ጥያቄዎ ተሰርዟል። ❌"
      );

    } catch (err) {

      console.error(
        "Cancel deposit error:",
        err
      );

      await ctx.reply(
        "የገቢ ጥያቄዎ ተሰርዟል። ❌"
      );
    }
  }
);


// ─────────────────────────────────────────────────────────────
// SUPPORT
// ─────────────────────────────────────────────────────────────

async function showSupport(ctx) {

  const user =
    await db.getUserByTelegramId(
      ctx.from.id
    );

  if (!user) {

    return await ctx.reply(
      "Please /start to register first."
    );
  }


  await ctx.reply(
    "🆘 ድጋፍ ይፈልጋሉ?\n\n" +
    "👇 ለማንኛውም ጥያቄ ወይም አስተያየት 👇\n\n" +
    "👤 @sistersbingosupport",
    {
      parse_mode: "Markdown",
    }
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

    await answerCallback(ctx);

    await showSupport(ctx);
  }
);


// ─────────────────────────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────────────────────────

async function showLeaderboard(ctx) {

  const rows =
    await db.getLeaderboard(10);


  const medals = [
    "🥇",
    "🥈",
    "🥉",
  ];


  const text =
    rows
      .map((r, i) => {

        const position =
          medals[i] ||
          `${i + 1}.`;

        return (
          `${position} *${r.name}* — ` +
          `${r.total_winnings} ETB ` +
          `(${r.total_wins} wins)`
        );
      })
      .join("\n");


  await ctx.reply(
    `🏆 *Leaderboard*\n\n` +
    `${text || "No games yet!"}`,
    {
      parse_mode: "Markdown",
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

bot.callbackQuery(
  "leaderboard",
  async (ctx) => {

    await answerCallback(ctx);

    await showLeaderboard(ctx);
  }
);


// ─────────────────────────────────────────────────────────────
// PLAY
// ─────────────────────────────────────────────────────────────

async function showPlay(ctx) {

  const user =
    await db.getUserByTelegramId(
      ctx.from.id
    );


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
                url:
                  `${GAME_URL}?tid=${ctx.from.id}`,
              },
            },
          ],
        ],
      },
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


// ─────────────────────────────────────────────────────────────
// Vercel webhook handler
// ─────────────────────────────────────────────────────────────

module.exports =
  webhookCallback(bot, "http");
