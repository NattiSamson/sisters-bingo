const db = require('../../db');

module.exports = async (req, res) => {
  try {
    const telegramId = String(req.query.tid || '').trim();

    if (!telegramId) {
      return res.status(400).json({
        error: 'Telegram ID is required'
      });
    }

    console.log('🔎 Balance request for Telegram ID:', telegramId);

    const user = await db.getUserByTelegramId(telegramId);

    console.log('🗄️ User returned from Neon:', user ? {
      telegram_id: user.telegram_id,
      name: user.name,
      balance: user.balance
    } : null);

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    return res.status(200).json({
      name: user.name,
      phone: user.phone,
      balance: Number(user.balance || 0),
      telegram_id: user.telegram_id
    });

  } catch (error) {
    console.error('❌ /api/user error:', error);

    return res.status(500).json({
      error: 'Failed to load user'
    });
  }
};