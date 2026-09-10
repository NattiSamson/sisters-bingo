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

    try {

      const existing =
        await db.getUserByTelegramId(
          telegramId
        );

      // --------------------------------------------------------
      // New user
      // --------------------------------------------------------

      if (!existing) {

        pendingPhone[
          telegramId
        ] = {

          name:
            firstName,

          step:
            "ask_name"

        };

        return await ctx.reply(

          `👋 Welcome to *Sisters Bingo!*\n\n` +
          `Let's get you registered.\n` +
          `What should we call you?`,

          {
            parse_mode:
              "Markdown"
          }

        );

      }


      // --------------------------------------------------------
      // HOME MENU
      // --------------------------------------------------------

      const keyboard = [

        // Play
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

        // Balance / Transfer
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

        // Deposit / Withdraw
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

        // Support / Delete
        [
          {
            text:
              "🆘 Support",

            callback_data:
              "support"
          },

          {
            text:
              "🗑️ Delete",

            callback_data:
              "delete"
          }
        ]

      ];


      // --------------------------------------------------------
      // ADMIN BUTTONS
      // --------------------------------------------------------

      if (
        telegramId === ADMIN_ID
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

      }


      await ctx.reply(

        `👋 Welcome back, *${existing.name}!* 🎱\n\n` +

        `💰 Balance: *${existing.balance} ETB*\n\n` +

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
