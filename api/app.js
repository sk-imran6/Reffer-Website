
const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function json(res, status, data) {
  return res.status(status).json(data);
}

function validateTelegramInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) return null;

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (
      receivedHash.length !== calculatedHash.length ||
      !crypto.timingSafeEqual(
        Buffer.from(receivedHash, "hex"),
        Buffer.from(calculatedHash, "hex")
      )
    ) {
      return null;
    }

    const authDate = Number(params.get("auth_date") || 0);
    const now = Math.floor(Date.now() / 1000);

    if (!authDate || authDate > now + 60 || now - authDate > 86400) {
      return null;
    }

    const user = JSON.parse(params.get("user") || "null");

    if (!user || !user.id) return null;

    return user;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  if (!process.env.DATABASE_URL) {
    return json(res, 500, {
      ok: false,
      error: "DATABASE_URL is not configured"
    });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    const telegramUser = validateTelegramInitData(body.initData);

    if (!telegramUser) {
      return json(res, 401, {
        ok: false,
        error: "Invalid Telegram session"
      });
    }

    const userResult = await pool.query(
      `
      SELECT
        id,
        telegram_id,
        username,
        first_name,
        last_name,
        balance,
        verified,
        blocked
      FROM users
      WHERE telegram_id = $1
      LIMIT 1
      `,
      [String(telegramUser.id)]
    );

    if (!userResult.rows.length) {
      return json(res, 403, {
        ok: false,
        error: "Please start the bot first."
      });
    }

    const user = userResult.rows[0];

    if (user.blocked) {
      return json(res, 403, {
        ok: false,
        error: "Your account is blocked."
      });
    }

    if (!user.verified) {
      return json(res, 403, {
        ok: false,
        error: "Please complete channel verification first."
      });
    }

    const voucherResult = await pool.query(
      `
      SELECT
        id,
        code,
        description,
        reward,
        expires_at
      FROM vouchers
      WHERE active = true
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY id DESC
      `
    );

    const claimedResult = await pool.query(
      `
      SELECT DISTINCT voucher_id
      FROM voucher_claims
      WHERE user_id = $1
      `,
      [user.id]
    );

    const referralResult = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM referrals
      WHERE referrer_id = $1
      `,
      [user.id]
    );

    const usedResult = await pool.query(
      `
      SELECT COALESCE(SUM(referrals_used), 0)::int AS used
      FROM referral_claims
      WHERE user_id = $1
      `,
      [user.id]
    );

    const totalReferrals = referralResult.rows[0]?.total || 0;
    const referralsUsed = usedResult.rows[0]?.used || 0;
    const availableReferrals = Math.max(
      0,
      totalReferrals - referralsUsed
    );

    const settingsResult = await pool.query(
      `
      SELECT key, value
      FROM app_settings
      ORDER BY key
      `
    );

    const botConfigResult = await pool.query(
      `
      SELECT bot_username, bot_name, bot_link
      FROM bot_config
      WHERE id = 1
      LIMIT 1
      `
    );

    const settings = {};

    for (const row of settingsResult.rows) {
      settings[row.key] = row.value;
    }

    const botConfig = botConfigResult.rows[0] || {};

    return json(res, 200, {
      ok: true,

      user: {
        id: user.id,
        telegram_id: user.telegram_id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        balance: user.balance
      },

      bot_username:
        botConfig.bot_username ||
        process.env.BOT_USERNAME ||
        "",

      bot_name:
        botConfig.bot_name ||
        "Reward Bot",

      bot_link:
        botConfig.bot_link ||
        "",

      referrals: availableReferrals,
      total_referrals: totalReferrals,
      referrals_used: referralsUsed,
      referrals_required: 5,

      vouchers: voucherResult.rows,

      claimed_vouchers: claimedResult.rows.map(
        row => Number(row.voucher_id)
      ),

      settings
    });

  } catch (error) {
    console.error("APP API ERROR:", error);

    return json(res, 500, {
      ok: false,
      error: "Internal server error"
    });
  }
};
