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

// Admin rejection state
// telegramId -> { withdrawalId, withdrawal }
const pendingAdminReject = {};


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
// HOME MENU
// ============================================================

async function showHome(
  ctx,
  user
) {

  const telegramId =
    ctx.from.id;


  const keyboard = [

    [

      {

        text:
          "🎮 Play",

        web_app: {

          url:
            `${GAME_URL}?tid=${telegramId}`

        }

      }

    ],

    [

      {

        text:
          "💰 Balance",

        callback_data:
          "balance"

      },

      {

        text:
          "🔄 Transfer",

        callback_data:
          "transfer"

      }

    ],

    [

      {

        text:
          "💎 Deposit",

        callback_data:
          "deposit"

      },

      {

        text:
          "🏧 Withdraw",

        callback_data:
          "withdraw"

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

  ];


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

  let isAdmin =
    false;


  try {

    if (
      user &&
      user.is_admin === true &&
      user.is_active !== false &&
      user.is_banned !== true
    ) {

      isAdmin = true;

    } else {

      const admin =
        await getCurrentAdmin(
          ctx
        );

      isAdmin =
        !!admin;

    }

  } catch (err) {

    console.error(
      "Home admin check error:",
      err
    );

  }


  if (
    isAdmin
  ) {

    keyboard.push([

      {

        text:
          "⏳ Pending",

        callback_data:
          "admin_withdrawals"

      },

      {

        text:
          "📢 Broadcast",

        callback_data:
          "admin_broadcast"

      }

    ]);
    keyboard.push([
  {
    text: "📊 Statistics",
    callback_data: "admin_statistics"
  }
]);

  }


  await ctx.reply(

    `Welcome back, *${user.name}!* 🎱\n\n` +

    `💰 Balance: *${user.balance} ETB*\n\n` +

    `Choose an option:`,

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
        await db.getAdminByTelegramId(
          ctx.from.id
        );

      if (!admin) {

        return await ctx.reply(
          "❌ You are not authorized to view statistics."
        );

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
        `⚪ Inactive Users: *${stats.inactiveUsers}*\n\n` +

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
        await db.getUserByTelegramId(
          telegramId
        );


      // ------------------------------------------------------
      // Existing user
      // ------------------------------------------------------

      if (existing) {

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
          await db.approveDepositttttttttttt(
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

    const admin =
      await requireAdmin(ctx);

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
// DELETE
// ============================================================

bot.callbackQuery(
  "delete",
  async (ctx) => {

    await answerCallback(
      ctx
    );


    clearPendingState(
      ctx.from.id
    );


    await ctx.reply(

      "🗑️ *Delete Account*\n\n" +

      "Account deletion is currently unavailable.\n" +

      "Please contact Support if you want to delete your account.",

      {

        parse_mode:
          "Markdown"

      }

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
