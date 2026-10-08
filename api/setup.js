const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function json(res, status, data) {
  return res.status(status).json(data);
}

async function telegram(method, params = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params)
    }
  );

  return await response.json();
}

module.exports = async (req, res) => {

  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  try {

    if (!process.env.BOT_TOKEN) {
      return json(res, 500, {
        ok: false,
        error: "BOT_TOKEN is not configured"
      });
    }

    if (!process.env.DATABASE_URL) {
      return json(res, 500, {
        ok: false,
        error: "DATABASE_URL is not configured"
      });
    }

    const setupKey =
      req.query?.key ||
      (
        typeof req.body === "object" &&
        req.body
          ? req.body.key
          : null
      );

    if (
      !process.env.SETUP_KEY ||
      setupKey !== process.env.SETUP_KEY
    ) {
      return json(res, 403, {
        ok: false,
        error: "Invalid setup key"
      });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        bot_username TEXT,
        bot_name TEXT,
        bot_link TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        telegram_id TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        channel_id TEXT UNIQUE NOT NULL,
        title TEXT,
        username TEXT,
        invite_link TEXT,
        required BOOLEAN DEFAULT TRUE,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id TEXT UNIQUE NOT NULL,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        balance NUMERIC(14,2) DEFAULT 0,
        verified BOOLEAN DEFAULT FALSE,
        blocked BOOLEAN DEFAULT FALSE,
        referred_by INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id INTEGER NOT NULL,
        referred_user_id INTEGER UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vouchers (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        description TEXT,
        reward NUMERIC(14,2) DEFAULT 0,
        active BOOLEAN DEFAULT TRUE,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS voucher_claims (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        voucher_id INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, voucher_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_id TEXT,
        action TEXT,
        details TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const me = await telegram("getMe");

    if (!me.ok) {
      return json(res, 500, {
        ok: false,
        error: "Telegram token is invalid"
      });
    }

    const botUsername = me.result.username || "";
    const botName = me.result.first_name || "Reward Bot";
    const botLink = botUsername
      ? `https://t.me/${botUsername}`
      : "";

    await pool.query(
      `
      INSERT INTO bot_config
        (id, bot_username, bot_name, bot_link)
      VALUES
        (1, $1, $2, $3)
      ON CONFLICT (id)
      DO UPDATE SET
        bot_username = EXCLUDED.bot_username,
        bot_name = EXCLUDED.bot_name,
        bot_link = EXCLUDED.bot_link,
        updated_at = NOW()
      `,
      [
        botUsername,
        botName,
        botLink
      ]
    );

    if (process.env.OWNER_ID) {

      await pool.query(
        `
        INSERT INTO admins
          (telegram_id, role)
        VALUES
          ($1, 'owner')
        ON CONFLICT (telegram_id)
        DO UPDATE SET role = 'owner'
        `,
        [String(process.env.OWNER_ID)]
      );
    }

    const webhookBase =
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      process.env.VERCEL_URL;

    if (!webhookBase) {
      return json(res, 500, {
        ok: false,
        error: "Vercel deployment URL unavailable"
      });
    }

    const cleanBase = webhookBase
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");

    const webhookUrl =
      `https://${cleanBase}/api/bot`;

    const webhook = await telegram(
      "setWebhook",
      {
        url: webhookUrl,
        allowed_updates: [
          "message",
          "callback_query"
        ],
        drop_pending_updates: false
      }
    );

    if (!webhook.ok) {
      return json(res, 500, {
        ok: false,
        error: "Failed to set Telegram webhook",
        telegram: webhook
      });
    }

    return json(res, 200, {
      ok: true,
      message: "Setup completed successfully.",
      bot: {
        username: botUsername,
        name: botName,
        link: botLink
      },
      webhook: webhookUrl,
      owner_configured: Boolean(process.env.OWNER_ID)
    });

  } catch (error) {

    console.error("SETUP ERROR:", error);

    return json(res, 500, {
      ok: false,
      error: "Setup failed"
    });
  }
};
