const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function db(query, values = []) {
  const result = await pool.query(query, values);
  return result.rows;
}

async function setupDatabase() {
  await db(`
    CREATE TABLE IF NOT EXISTS bot_config (
      id INTEGER PRIMARY KEY,
      bot_username TEXT,
      bot_name TEXT,
      bot_token TEXT,
      bot_link TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channels (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      name TEXT NOT NULL,
      link TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'required',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      blocked BOOLEAN NOT NULL DEFAULT FALSE,
      referrals INTEGER NOT NULL DEFAULT 0,
      claimed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS channels_type_idx
    ON channels(type, enabled);
  `);
}

function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
      return null;
    }

    params.delete("hash");

    const pairs = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secret = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const calculated = crypto
      .createHmac("sha256", secret)
      .update(pairs)
      .digest("hex");

    const a = Buffer.from(calculated, "hex");
    const b = Buffer.from(hash, "hex");

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return null;
    }

    const authDate = Number(params.get("auth_date") || 0);
    const now = Math.floor(Date.now() / 1000);

    if (!authDate || now - authDate > 86400 || authDate > now + 60) {
      return null;
    }

    const userRaw = params.get("user");

    if (!userRaw) {
      return null;
    }

    return JSON.parse(userRaw);

  } catch (e) {
    return null;
  }
}

async function memberStatus(chatId, userId, token) {
  try {
    const url =
      `https://api.telegram.org/bot${token}/getChatMember` +
      `?chat_id=${encodeURIComponent(chatId)}` +
      `&user_id=${encodeURIComponent(userId)}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.ok || !data.result) {
      return false;
    }

    const status = data.result.status;

    return (
      ["creator", "administrator", "member"].includes(status) ||
      (
        status === "restricted" &&
        data.result.is_member === true
      )
    );

  } catch (e) {
    return false;
  }
}

async function getBotConfig() {
  const rows = await db(`
    SELECT *
    FROM bot_config
    WHERE id = 1
    LIMIT 1
  `);

  return rows[0] || null;
}

async function getRequiredChannels() {
  return await db(`
    SELECT
      id,
      telegram_id,
      name,
      link
    FROM channels
    WHERE type = 'required'
      AND enabled = TRUE
    ORDER BY id ASC
  `);
}

async function saveUser(user, verified) {
  await db(
    `
    INSERT INTO users
      (
        telegram_id,
        username,
        first_name,
        last_name,
        verified,
        updated_at
      )
    VALUES
      ($1, $2, $3, $4, $5, NOW())

    ON CONFLICT (telegram_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      verified = EXCLUDED.verified,
      updated_at = NOW()
    `,
    [
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null,
      verified
    ]
  );
}

module.exports = async (req, res) => {

  res.setHeader("Cache-Control", "no-store");

  try {

    if (!process.env.DATABASE_URL) {
      return res.status(500).json({
        verified: false,
        message: "DATABASE_URL is not configured"
      });
    }

    await setupDatabase();

    /*
     * GET
     * Returns channels for the User Mini App.
     */
    if (req.method === "GET") {

      const channels = await getRequiredChannels();

      return res.status(200).json({
        success: true,
        channels: channels.map(ch => ({
          id: ch.telegram_id,
          name: ch.name,
          link: ch.link
        }))
      });
    }

    /*
     * Only POST is allowed for verification.
     */
    if (req.method !== "POST") {
      return res.status(405).json({
        verified: false,
        message: "Method not allowed"
      });
    }

    /*
     * Get bot configuration.
     *
     * First version also supports BOT_TOKEN environment
     * variable so the existing bot keeps working.
     */
    const config = await getBotConfig();

    const token =
      config?.bot_token ||
      process.env.BOT_TOKEN;

    if (!token) {
      return res.status(500).json({
        verified: false,
        message: "Bot token is not configured"
      });
    }

    const initData =
      req.body?.initData ||
      req.headers["x-telegram-init-data"] ||
      "";

    if (!initData) {
      return res.status(400).json({
        verified: false,
        message: "Telegram initData missing"
      });
    }

    /*
     * Validate Telegram Mini App session.
     */
    const user = validateInitData(
      initData,
      token
    );

    if (!user) {

      return res.status(401).json({
        verified: false,
        message: "Invalid Telegram session"
      });
    }

    /*
     * Blocked users cannot access the Mini App.
     */
    const existing = await db(
      `
      SELECT
        telegram_id,
        blocked,
        referrals,
        claimed
      FROM users
      WHERE telegram_id = $1
      LIMIT 1
      `,
      [user.id]
    );

    if (
      existing[0] &&
      existing[0].blocked === true
    ) {

      return res.status(403).json({
        verified: false,
        blocked: true,
        message: "Your account has been blocked"
      });
    }

    /*
     * Get currently enabled Required Channels
     * from the database.
     */
    const channels = await getRequiredChannels();

    /*
     * Verify every required channel.
     */
    for (const channel of channels) {

      const joined = await memberStatus(
        channel.telegram_id,
        user.id,
        token
      );

      if (!joined) {

        await saveUser(user, false);

        return res.status(403).json({
          verified: false,
          message: `Join ${channel.name} first`,
          channel: {
            id: channel.telegram_id,
            name: channel.name,
            link: channel.link
          }
        });
      }
    }

    /*
     * Everything verified.
     */
    await saveUser(user, true);

    const updated = await db(
      `
      SELECT
        referrals,
        claimed
      FROM users
      WHERE telegram_id = $1
      LIMIT 1
      `,
      [user.id]
    );

    const stats = updated[0] || {
      referrals: 0,
      claimed: 0
    };

    return res.status(200).json({

      verified: true,

      referrals: Number(stats.referrals || 0),

      claimed: Number(stats.claimed || 0),

      user: {
        id: user.id,
        first_name: user.first_name || "",
        last_name: user.last_name || "",
        username: user.username || null
      }

    });

  } catch (error) {

    console.error("VERIFY ERROR:", error);

    return res.status(500).json({
      verified: false,
      message: "Verification error"
    });
  }
};
