const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function db(query, values = []) {
  const result = await pool.query(query, values);
  return result.rows;
}

async function telegram(method, params = {}) {
  const token = process.env.BOT_TOKEN;

  if (!token) {
    throw new Error("BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      data.description || "Telegram API error"
    );
  }

  return data.result;
}

async function setupDatabase() {
  await db(`
    CREATE TABLE IF NOT EXISTS bot_config (
      id INTEGER PRIMARY KEY,
      bot_username TEXT,
      bot_name TEXT,
      bot_link TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admins (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      role TEXT NOT NULL DEFAULT 'admin',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channels (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      name TEXT NOT NULL,
      link TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'required',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
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

    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      inviter_id BIGINT NOT NULL,
      invited_id BIGINT UNIQUE NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      required_referrals INTEGER NOT NULL DEFAULT 0,
      claim_limit INTEGER NOT NULL DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS voucher_claims (
      id BIGSERIAL PRIMARY KEY,
      voucher_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(voucher_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS admin_logs (
      id BIGSERIAL PRIMARY KEY,
      admin_id BIGINT,
      action TEXT NOT NULL,
      target TEXT,
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
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

async function isJoined(channelId, userId) {
  try {
    const member = await telegram(
      "getChatMember",
      {
        chat_id: channelId,
        user_id: userId
      }
    );

    return (
      ["creator", "administrator", "member"]
        .includes(member.status)
      ||
      (
        member.status === "restricted" &&
        member.is_member === true
      )
    );

  } catch (error) {
    return false;
  }
}

async function saveUser(user) {
  await db(
    `
    INSERT INTO users
      (
        telegram_id,
        username,
        first_name,
        last_name,
        updated_at
      )
    VALUES
      ($1, $2, $3, $4, NOW())

    ON CONFLICT (telegram_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      updated_at = NOW()
    `,
    [
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null
    ]
  );
}

async function getAdmin(userId) {
  const rows = await db(
    `
    SELECT *
    FROM admins
    WHERE telegram_id = $1
      AND enabled = TRUE
    LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
}

async function sendMessage(chatId, text, reply_markup) {
  return await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup
    }
  );
}

async function showStart(chatId, userId) {

  const channels =
    await getRequiredChannels();

  if (!channels.length) {
    return sendDashboardButton(chatId);
  }

  const buttons = [];

  for (const channel of channels) {
    const joined = await isJoined(
      channel.telegram_id,
      userId
    );

    if (!joined) {
      buttons.push([
        {
          text: `📢 ${channel.name}`,
          url: channel.link
        }
      ]);
    }
  }

  if (buttons.length) {

    buttons.push([
      {
        text: "✅ Check Joined",
        callback_data: "check_join"
      }
    ]);

    return sendMessage(
      chatId,
      `<b>🔐 Welcome!</b>

<b>Dashboard open karne ke liye required channels join karein.</b>

Neeche diye gaye channels join karne ke baad <b>Check Joined</b> press karein.`,
      {
        inline_keyboard: buttons
      }
    );
  }

  return sendDashboardButton(chatId);
}

async function sendDashboardButton(chatId) {

  const username =
    process.env.BOT_USERNAME ||
    "";

  const webAppUrl =
    process.env.WEB_APP_URL ||
    "";

  return sendMessage(
    chatId,
    `<b>🎉 Verification Complete!</b>

Ab aap apna Reward Dashboard open kar sakte hain.`,
    {
      inline_keyboard: [
        [
          {
            text: "🚀 Open Dashboard",
            web_app: {
              url: webAppUrl
            }
          }
        ]
      ]
    }
  );
}

async function adminMenu(chatId, admin) {

  const keyboard = [
    [
      {
        text: "📊 Dashboard",
        callback_data: "admin_dashboard"
      }
    ],
    [
      {
        text: "👥 Users",
        callback_data: "admin_users"
      },
      {
        text: "📢 Channels",
        callback_data: "admin_channels"
      }
    ],
    [
      {
        text: "🎟 Vouchers",
        callback_data: "admin_vouchers"
      },
      {
        text: "🔗 Referrals",
        callback_data: "admin_referrals"
      }
    ],
    [
      {
        text: "⚙️ Settings",
        callback_data: "admin_settings"
      }
    ]
  ];

  if (
    admin.role === "owner" ||
    admin.role === "super_admin"
  ) {
    keyboard.push([
      {
        text: "🛡 Admins",
        callback_data: "admin_admins"
      }
    ]);
  }

  return sendMessage(
    chatId,
    `<b>👑 Admin Panel</b>

<b>Role:</b> ${admin.role}

Yahan se bot ke main features manage kar sakte ho.`,
    {
      inline_keyboard: keyboard
    }
  );
}

async function adminDashboard(chatId) {

  const users = await db(`
    SELECT COUNT(*)::INTEGER AS total
    FROM users
  `);

  const verified = await db(`
    SELECT COUNT(*)::INTEGER AS total
    FROM users
    WHERE verified = TRUE
  `);

  const referrals = await db(`
    SELECT COUNT(*)::INTEGER AS total
    FROM referrals
    WHERE verified = TRUE
  `);

  const vouchers = await db(`
    SELECT COUNT(*)::INTEGER AS total
    FROM vouchers
    WHERE enabled = TRUE
  `);

  return sendMessage(
    chatId,
    `<b>📊 Admin Dashboard</b>

👥 Users: <b>${users[0].total}</b>
✅ Verified: <b>${verified[0].total}</b>
🔗 Referrals: <b>${referrals[0].total}</b>
🎟 Active Vouchers: <b>${vouchers[0].total}</b>`,
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Admin Menu",
            callback_data: "admin_menu"
          }
        ]
      ]
    }
  );
}

async function handleCallback(callback) {

  const data = callback.data;
  const chatId = callback.message.chat.id;
  const userId = callback.from.id;

  await telegram(
    "answerCallbackQuery",
    {
      callback_query_id: callback.id
    }
  );

  if (data === "check_join") {

    const channels =
      await getRequiredChannels();

    const missing = [];

    for (const channel of channels) {

      const joined = await isJoined(
        channel.telegram_id,
        userId
      );

      if (!joined) {
        missing.push(channel);
      }
    }

    if (missing.length) {

      const buttons = missing.map(
        channel => [
          {
            text: `📢 ${channel.name}`,
            url: channel.link
          }
        ]
      );

      buttons.push([
        {
          text: "🔄 Check Again",
          callback_data: "check_join"
        }
      ]);

      return sendMessage(
        chatId,
        `<b>❌ Verification incomplete</b>

Please join all required channels first.`,
        {
          inline_keyboard: buttons
        }
      );
    }

    await db(
      `
      UPDATE users
      SET
        verified = TRUE,
        updated_at = NOW()
      WHERE telegram_id = $1
      `,
      [userId]
    );

    return sendDashboardButton(chatId);
  }

  const admin = await getAdmin(userId);

  if (!admin) {
    return sendMessage(
      chatId,
      "<b>❌ Admin access denied.</b>"
    );
  }

  if (data === "admin_menu") {
    return adminMenu(chatId, admin);
  }

  if (data === "admin_dashboard") {
    return adminDashboard(chatId);
  }

  if (data === "admin_users") {

    const rows = await db(`
      SELECT
        COUNT(*)::INTEGER AS total
      FROM users
    `);

    return sendMessage(
      chatId,
      `<b>👥 Users</b>

Total Users: <b>${rows[0].total}</b>`,
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data: "admin_menu"
            }
          ]
        ]
      }
    );
  }

  if (data === "admin_channels") {

    const rows = await db(`
      SELECT
        name,
        type,
        enabled
      FROM channels
      ORDER BY id ASC
    `);

    let text =
      "<b>📢 Channels</b>\n\n";

    if (!rows.length) {
      text += "No channels configured.";
    } else {
      for (const row of rows) {
        text +=
          `${row.enabled ? "🟢" : "🔴"} ` +
          `<b>${row.name}</b> — ${row.type}\n`;
      }
    }

    return sendMessage(
      chatId,
      text,
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data: "admin_menu"
            }
          ]
        ]
      }
    );
  }

  if (data === "admin_vouchers") {

    const rows = await db(`
      SELECT COUNT(*)::INTEGER AS total
      FROM vouchers
      WHERE enabled = TRUE
    `);

    return sendMessage(
      chatId,
      `<b>🎟 Vouchers</b>

Active vouchers: <b>${rows[0].total}</b>`,
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data: "admin_menu"
            }
          ]
        ]
      }
    );
  }

  if (data === "admin_referrals") {

    const rows = await db(`
      SELECT COUNT(*)::INTEGER AS total
      FROM referrals
      WHERE verified = TRUE
    `);

    return sendMessage(
      chatId,
      `<b>🔗 Referrals</b>

Verified referrals: <b>${rows[0].total}</b>`,
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data: "admin_menu"
            }
          ]
        ]
      }
    );
  }

  if (data === "admin_admins") {

    if (
      admin.role !== "owner" &&
      admin.role !== "super_admin"
    ) {
      return sendMessage(
        chatId,
        "<b>❌ Permission denied.</b>"
      );
    }

    const rows = await db(`
      SELECT
        telegram_id,
        username,
        first_name,
        role,
        enabled
      FROM admins
      ORDER BY created_at ASC
    `);

    let text =
      "<b>🛡 Administrators</b>\n\n";

    for (const row of rows) {
      text +=
        `👤 <b>${row.first_name || "Admin"}</b>\n` +
        `ID: <code>${row.telegram_id}</code>\n` +
        `Role: <b>${row.role}</b>\n\n`;
    }

    return sendMessage(
      chatId,
      text,
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data: "admin_menu"
            }
          ]
        ]
      }
    );
  }

  if (data === "admin_settings") {

    return sendMessage(
      chatId,
      `<b>⚙️ Settings</b>

Settings management will be available here.`,
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data: "admin_menu"
            }
          ]
        ]
      }
    );
  }
}

module.exports = async (req, res) => {

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  try {

    if (!process.env.DATABASE_URL) {
      return res.status(500).json({
        ok: false,
        error: "DATABASE_URL is not configured"
      });
    }

    if (!process.env.BOT_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "BOT_TOKEN is not configured"
      });
    }

    await setupDatabase();

    if (req.method !== "POST") {
      return res.status(200).json({
        ok: true,
        message: "Reward bot is running"
      });
    }

    const update = req.body;

    if (update.callback_query) {
      await handleCallback(
        update.callback_query
      );

      return res.status(200).json({
        ok: true
      });
    }

    if (!update.message) {
      return res.status(200).json({
        ok: true
      });
    }

    const message = update.message;
    const chatId = message.chat.id;
    const user = message.from;
    const text =
      String(message.text || "").trim();

    await saveUser(user);

    if (text === "/start") {
      await showStart(
        chatId,
        user.id
      );

      return res.status(200).json({
        ok: true
      });
    }

    if (
      text === "/admin" ||
      text === "/admin@"
    ) {

      const admin =
        await getAdmin(user.id);

      if (!admin) {

        await sendMessage(
          chatId,
          "<b>❌ Admin access denied.</b>"
        );

        return res.status(200).json({
          ok: true
        });
      }

      await adminMenu(
        chatId,
        admin
      );

      return res.status(200).json({
        ok: true
      });
    }

    if (text === "/id") {

      await sendMessage(
        chatId,
        `<b>Telegram ID:</b> <code>${user.id}</code>`
      );

      return res.status(200).json({
        ok: true
      });
    }

    await sendMessage(
      chatId,
      `<b>👋 Welcome!</b>

Use /start to open the Reward Dashboard.`
    );

    return res.status(200).json({
      ok: true
    });

  } catch (error) {

    console.error(
      "BOT ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "Internal server error"
    });
  }
};
