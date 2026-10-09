const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
const BOT_USERNAME = process.env.BOT_USERNAME || "";

function reply(res, data) {
  return res.status(200).json(data);
}

async function telegram(method, params = {}) {
  const r = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params)
    }
  );

  return await r.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

async function answerCallback(id, text = "") {
  return telegram("answerCallbackQuery", {
    callback_query_id: id,
    text
  });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================
   ADMIN HELPERS
========================= */

async function getAdmin(telegramId) {
  const r = await pool.query(
    `
    SELECT id, telegram_id, role
    FROM admins
    WHERE telegram_id = $1
    LIMIT 1
    `,
    [String(telegramId)]
  );

  return r.rows[0] || null;
}

async function ensureOwner() {
  if (!process.env.OWNER_ID) return;

  await pool.query(
    `
    INSERT INTO admins (telegram_id, role)
    VALUES ($1, 'owner')
    ON CONFLICT (telegram_id)
    DO UPDATE SET role = 'owner'
    `,
    [String(process.env.OWNER_ID)]
  );
}

function hasChannelPermission(admin) {
  return [
    "owner",
    "super_admin",
    "admin"
  ].includes(admin.role);
}

function isOwnerRole(admin) {
  return [
    "owner",
    "super_admin"
  ].includes(admin.role);
}

/* =========================
   USER HELPERS
========================= */

async function saveUser(user) {
  const r = await pool.query(
    `
    INSERT INTO users
      (telegram_id, username, first_name, last_name)
    VALUES
      ($1, $2, $3, $4)
    ON CONFLICT (telegram_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      updated_at = NOW()
    RETURNING *
    `,
    [
      String(user.id),
      user.username || "",
      user.first_name || "",
      user.last_name || ""
    ]
  );

  return r.rows[0];
}

/* =========================
   CHANNEL HELPERS
========================= */

async function getRequiredChannels() {
  const r = await pool.query(
    `
    SELECT
      id,
      channel_id,
      title,
      username,
      invite_link
    FROM channels
    WHERE active = true
      AND required = true
    ORDER BY id ASC
    `
  );

  return r.rows;
}

async function isJoined(channelId, userId) {
  try {
    const r = await telegram("getChatMember", {
      chat_id: channelId,
      user_id: userId
    });

    if (!r.ok || !r.result) return false;

    const status = r.result.status;

    return (
      ["creator", "administrator", "member"].includes(status) ||
      (
        status === "restricted" &&
        r.result.is_member === true
      )
    );
  } catch (error) {
    console.error("CHANNEL MEMBERSHIP ERROR:", error);
    return false;
  }
}

async function checkAllChannels(userId) {
  const channels = await getRequiredChannels();
  const notJoined = [];

  for (const channel of channels) {
    const joined = await isJoined(
      channel.channel_id,
      userId
    );

    if (!joined) {
      notJoined.push(channel);
    }
  }

  return {
    allJoined: notJoined.length === 0,
    notJoined
  };
}

/* =========================
   JOIN KEYBOARD
   Two channel buttons per row
========================= */

function joinKeyboard(channels) {
  const rows = [];
  let row = [];

  for (const channel of channels) {
    const storedUsername = String(
      channel.username || ""
    ).trim();

    const validUsername = /^[A-Za-z0-9_]{5,}$/.test(
      storedUsername.replace(/^@/, "")
    );

    const link =
      channel.invite_link ||
      (
        validUsername
          ? `https://t.me/${storedUsername.replace("@", "")}`
          : null
      );

    if (!link) continue;

    row.push({
      text: `📢 ${channel.title || "Join Channel"}`,
      url: link
    });

    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length) {
    rows.push(row);
  }

  rows.push([
    {
      text: "🔄 Request Check",
      callback_data: "check_join"
    }
  ]);

  return {
    inline_keyboard: rows
  };
}

function dashboardKeyboard() {
  if (!WEB_APP_URL) {
    return {
      inline_keyboard: []
    };
  }

  return {
    inline_keyboard: [
      [
        {
          text: "🚀 Open Dashboard",
          web_app: {
            url: WEB_APP_URL
          }
        }
      ]
    ]
  };
}

/* =========================
   ADMIN KEYBOARD
========================= */

function adminKeyboard(role) {
  const rows = [
    [
      {
        text: "📊 Dashboard",
        callback_data: "admin_dashboard"
      },
      {
        text: "👥 Users",
        callback_data: "admin_users"
      }
    ],
    [
      {
        text: "📢 Channels",
        callback_data: "admin_channels"
      },
      {
        text: "🎁 Vouchers",
        callback_data: "admin_vouchers"
      }
    ],
    [
      {
        text: "🔗 Referrals",
        callback_data: "admin_referrals"
      },
      {
        text: "⚙️ Settings",
        callback_data: "admin_settings"
      }
    ]
  ];

  if (role === "owner" || role === "super_admin") {
    rows.push([
      {
        text: "👑 Admins",
        callback_data: "admin_admins"
      }
    ]);
  }

  return {
    inline_keyboard: rows
  };
}

/* =========================
   START / VERIFICATION
========================= */

async function showStart(chatId, user) {
  await saveUser(user);

  const check = await checkAllChannels(user.id);

  if (!check.allJoined) {
    return sendMessage(
      chatId,
      `<b>🔐 Welcome to Reward Center</b>

To continue, please join all required channels below.

After joining, tap <b>Request Check</b>.`,
      {
        reply_markup: joinKeyboard(check.notJoined)
      }
    );
  }

  await pool.query(
    `
    UPDATE users
    SET verified = true,
        updated_at = NOW()
    WHERE telegram_id = $1
    `,
    [String(user.id)]
  );

  await processReferral(user);

  return sendMessage(
    chatId,
    `<b>✅ Verification complete</b>

Welcome, ${escapeHtml(user.first_name || "User")}!

Your dashboard is ready.`,
    {
      reply_markup: dashboardKeyboard()
    }
  );
}

/* =========================
   REFERRAL SYSTEM
========================= */

async function processReferral(user) {
  const referredUser = await pool.query(
    `
    SELECT id, referred_by
    FROM users
    WHERE telegram_id = $1
    LIMIT 1
    `,
    [String(user.id)]
  );

  if (!referredUser.rows.length) return;

  const currentUser = referredUser.rows[0];

  const existing = await pool.query(
    `
    SELECT id
    FROM referrals
    WHERE referred_user_id = $1
    LIMIT 1
    `,
    [currentUser.id]
  );

  if (existing.rows.length) return;

  if (!currentUser.referred_by) return;

  const referredBy = Number(currentUser.referred_by);

  if (!Number.isFinite(referredBy)) return;

  const referrer = await pool.query(
    `
    SELECT id, telegram_id
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [referredBy]
  );

  if (!referrer.rows.length) return;

  if (Number(referrer.rows[0].telegram_id) === Number(user.id)) {
    return;
  }

  const setting = await pool.query(
    `
    SELECT value
    FROM app_settings
    WHERE key = 'referral_bonus'
    LIMIT 1
    `
  );

  const bonus = Number(setting.rows[0]?.value || 0);

  const inserted = await pool.query(
    `
    INSERT INTO referrals
      (referrer_id, referred_user_id)
    VALUES ($1, $2)
    ON CONFLICT (referred_user_id)
    DO NOTHING
    RETURNING id
    `,
    [
      referredBy,
      currentUser.id
    ]
  );

  if (!inserted.rows.length) return;

  if (bonus > 0) {
    await pool.query(
      `
      UPDATE users
      SET balance = COALESCE(balance, 0) + $1
      WHERE id = $2
      `,
      [
        bonus,
        referredBy
      ]
    );

    await sendMessage(
      referrer.rows[0].telegram_id,
      `<b>🎉 New Referral!</b>

You received <b>₹${bonus.toFixed(2)}</b> referral reward.`
    );
  }
}

/* =========================
   ADMIN DASHBOARD
========================= */

async function adminDashboard(chatId, messageId) {
  const [
    users,
    verified,
    vouchers,
    referrals
  ] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM users
    `),

    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE verified = true
    `),

    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM vouchers
      WHERE active = true
    `),

    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM referrals
    `)
  ]);

  return editMessage(
    chatId,
    messageId,
    `<b>📊 Admin Dashboard</b>

👥 Users: <b>${users.rows[0].count}</b>
✅ Verified: <b>${verified.rows[0].count}</b>
🎁 Active Vouchers: <b>${vouchers.rows[0].count}</b>
🔗 Referrals: <b>${referrals.rows[0].count}</b>`,
    {
      reply_markup: {
        inline_keyboard: [
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
              text: "🎁 Vouchers",
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
            },
            {
              text: "🔙 Main",
              callback_data: "admin_main"
            }
          ]
        ]
      }
    }
  );
}

/* =========================
   ADMIN USERS
========================= */

async function adminUsers(chatId, messageId) {
  const r = await pool.query(`
    SELECT
      telegram_id,
      username,
      first_name,
      balance,
      verified,
      blocked
    FROM users
    ORDER BY id DESC
    LIMIT 15
  `);

  let text = `<b>👥 Recent Users</b>\n\n`;

  if (!r.rows.length) {
    text += "No users yet.";
  } else {
    for (const u of r.rows) {
      text +=
        `👤 <b>${escapeHtml(u.first_name || "User")}</b>\n` +
        `ID: <code>${escapeHtml(u.telegram_id)}</code>\n` +
        `Balance: ₹${Number(u.balance || 0).toFixed(2)}\n` +
        `Status: ${
          u.blocked
            ? "🚫 Blocked"
            : u.verified
              ? "✅ Verified"
              : "⏳ Unverified"
        }\n\n`;
    }
  }

  return editMessage(
    chatId,
    messageId,
    text,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔙 Admin",
              callback_data: "admin_main"
            }
          ]
        ]
      }
    }
  );
}

/* =========================
   ADMIN CHANNELS
========================= */

async function adminChannels(chatId, messageId) {
  const r = await pool.query(`
    SELECT
      id,
      channel_id,
      title,
      username,
      active,
      required,
      invite_link
    FROM channels
    ORDER BY id DESC
  `);

  let text = `<b>📢 Channels</b>\n\n`;

  if (!r.rows.length) {
    text += "No channels added.\n\n";
  } else {
    for (const c of r.rows) {
      const username = String(c.username || "").trim();
      const validUsername = /^[A-Za-z0-9_]{5,}$/.test(
        username.replace(/^@/, "")
      );

      text +=
        `<b>${escapeHtml(c.title || "Channel")}</b>\n` +
        `Database ID: <code>${c.id}</code>\n` +
        `Channel ID: <code>${escapeHtml(c.channel_id)}</code>\n` +
        (
          validUsername
            ? `Username: ${escapeHtml(username)}\n`
            : ""
        ) +
        `Required: ${c.required ? "Yes" : "No"}\n` +
        `Status: ${c.active ? "🟢 Active" : "🔴 Off"}\n\n`;
    }
  }

  text +=
    `<b>New format:</b>\n` +
    `<code>/adchannel CHANNEL_ID LINK</code>\n\n` +
    `<b>Old format (also supported):</b>\n` +
    `<code>/addchannel ID | Title | Username | InviteLink</code>\n\n` +
    `<b>Remove:</b>\n` +
    `<code>/delchannel DATABASE_ID</code>`;

  return editMessage(
    chatId,
    messageId,
    text,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔄 Refresh",
              callback_data: "admin_channels"
            }
          ],
          [
            {
              text: "🔙 Admin",
              callback_data: "admin_main"
            }
          ]
        ]
      }
    }
  );
}

/* =========================
   ADMIN VOUCHERS
========================= */

async function adminVouchers(chatId, messageId) {
  const r = await pool.query(`
    SELECT
      id,
      code,
      reward,
      active,
      expires_at
    FROM vouchers
    ORDER BY id DESC
    LIMIT 20
  `);

  let text = `<b>🎁 Vouchers</b>\n\n`;

  if (!r.rows.length) {
    text += "No vouchers yet.\n\n";
  } else {
    for (const v of r.rows) {
      text +=
        `<b>${escapeHtml(v.code)}</b> — ₹${Number(v.reward || 0).toFixed(2)}\n` +
        `ID: <code>${v.id}</code>\n` +
        `Status: ${v.active ? "🟢 Active" : "🔴 Disabled"}\n\n`;
    }
  }

  text +=
    `<b>Add:</b>\n` +
    `<code>/addvoucher CODE | Description | Reward</code>\n\n` +
    `<b>Disable:</b>\n` +
    `<code>/disablevoucher ID</code>`;

  return editMessage(
    chatId,
    messageId,
    text,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔄 Refresh",
              callback_data: "admin_vouchers"
            }
          ],
          [
            {
              text: "🔙 Admin",
              callback_data: "admin_main"
            }
          ]
        ]
      }
    }
  );
}

/* =========================
   ADMIN REFERRALS
========================= */

async function adminReferrals(chatId, messageId) {
  const r = await pool.query(`
    SELECT COUNT(*)::int AS total
    FROM referrals
  `);

  return editMessage(
    chatId,
    messageId,
    `<b>🔗 Referral Statistics</b>

Total referrals:
<b>${r.rows[0].total}</b>

Referral bonus is controlled from Settings.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⚙️ Settings",
              callback_data: "admin_settings"
            }
          ],
          [
            {
              text: "🔙 Admin",
              callback_data: "admin_main"
            }
          ]
        ]
      }
    }
  );
}

/* =========================
   ADMIN SETTINGS
========================= */

async function adminSettings(chatId, messageId) {
  const r = await pool.query(`
    SELECT key, value
    FROM app_settings
    ORDER BY key
  `);

  let text = `<b>⚙️ Settings</b>\n\n`;

  if (!r.rows.length) {
    text += "No settings configured.\n\n";
  } else {
    for (const s of r.rows) {
      text +=
        `<b>${escapeHtml(s.key)}</b>: ` +
        `<code>${escapeHtml(s.value || "")}</code>\n`;
    }

    text += "\n";
  }

  text +=
    `<b>Set:</b>\n` +
    `<code>/setsetting KEY | VALUE</code>\n\n` +
    `Example:\n` +
    `<code>/setsetting referral_bonus | 1</code>`;

  return editMessage(
    chatId,
    messageId,
    text,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔄 Refresh",
              callback_data: "admin_settings"
            }
          ],
          [
            {
              text: "🔙 Admin",
              callback_data: "admin_main"
            }
          ]
        ]
      }
    }
  );
}

async function adminMain(chatId, messageId, admin) {
  return editMessage(
    chatId,
    messageId,
    `<b>👑 Admin Panel</b>

Welcome to the bot control center.

Select an option below.`,
    {
      reply_markup: adminKeyboard(admin.role)
    }
  );
}

/* =========================
   CHANNEL COMMAND HELPERS
========================= */

async function addChannelFromCommand(message, admin, command) {
  if (!hasChannelPermission(admin)) {
    await sendMessage(
      message.chat.id,
      "⛔ Admin access denied."
    );
    return;
  }

  const text = message.text || "";

  const raw = text.replace(
    /^\/(?:adchannel|addchannel)(?:@\w+)?\s*/i,
    ""
  ).trim();

  let channelId = "";
  let title = "";
  let username = "";
  let inviteLink = "";

  if (command === "/addchannel") {
    const p = raw.split("|").map(x => x.trim());

    if (p.length < 4) {
      await sendMessage(
        message.chat.id,
        `<b>Old format:</b>\n<code>/addchannel ID | Title | Username | InviteLink</code>\n\n<b>New format:</b>\n<code>/adchannel CHANNEL_ID LINK</code>`
      );
      return;
    }

    channelId = p[0];
    title = p[1];
    username = p[2];
    inviteLink = p[3];

    /*
      Old records sometimes used invite tokens like
      +06-zAvK0QNJiZmM1 in the username field.
      Keep the invite link and avoid treating that
      token as a public channel username.
    */
    const cleanedUsername = username.replace(/^@/, "");

    if (!/^[A-Za-z0-9_]{5,}$/.test(cleanedUsername)) {
      username = "";
    } else {
      username = cleanedUsername;
    }

    /*
      Try fetching the actual channel title.
      If Telegram cannot find the channel, preserve
      the title supplied in the old command.
    */
    try {
      const chat = await telegram("getChat", {
        chat_id: channelId
      });

      if (chat.ok && chat.result) {
        channelId = String(chat.result.id);
        title = chat.result.title || title;
        username = chat.result.username || username;
      }
    } catch (error) {
      console.error("OLD CHANNEL LOOKUP ERROR:", error);
    }
  } else {
    const match = raw.match(
      /^(-?\d+|@[A-Za-z0-9_]+)\s+(https?:\/\/\S+)$/i
    );

    if (!match) {
      await sendMessage(
        message.chat.id,
        `<b>Usage:</b>\n<code>/adchannel CHANNEL_ID LINK</code>\n\nExample:\n<code>/adchannel -1001234567890 https://t.me/mychannel</code>`
      );
      return;
    }

    channelId = match[1];
    inviteLink = match[2];

    const chat = await telegram("getChat", {
      chat_id: channelId
    });

    if (!chat.ok || !chat.result) {
      await sendMessage(
        message.chat.id,
        `❌ <b>Channel details could not be fetched.</b>

Check the channel ID and make sure the bot has access to the channel.`
      );
      return;
    }

    channelId = String(chat.result.id);
    title = chat.result.title || chat.result.username || "Channel";
    username = chat.result.username || "";
  }

  if (!channelId || !inviteLink) {
    await sendMessage(
      message.chat.id,
      "❌ Channel ID or invite link is missing."
    );
    return;
  }

  await pool.query(
    `
    INSERT INTO channels
      (
        channel_id,
        title,
        username,
        invite_link,
        required,
        active
      )
    VALUES
      ($1, $2, $3, $4, true, true)
    ON CONFLICT (channel_id)
    DO UPDATE SET
      title = EXCLUDED.title,
      username = EXCLUDED.username,
      invite_link = EXCLUDED.invite_link,
      required = true,
      active = true
    `,
    [
      String(channelId),
      title || "Channel",
      username || "",
      inviteLink
    ]
  );

  await sendMessage(
    message.chat.id,
    `<b>✅ Channel saved successfully!</b>

📢 Name: <b>${escapeHtml(title || "Channel")}</b>
🆔 ID: <code>${escapeHtml(channelId)}</code>

🔗 Link: ${escapeHtml(inviteLink)}`
  );
}

/* =========================
   ADMIN COMMAND HANDLER
========================= */

async function handleAdminCommand(message, user) {
  const admin = await getAdmin(user.id);

  if (!admin) {
    await sendMessage(
      message.chat.id,
      "⛔ You don't have admin access."
    );
    return;
  }

  const text = message.text || "";
  const parts = text.trim().split(/\s+/);
  const command = (parts[0] || "")
    .split("@")[0]
    .toLowerCase();

  if (command === "/admin") {
    await sendMessage(
      message.chat.id,
      `<b>👑 Admin Panel</b>

Welcome to the bot control center.`,
      {
        reply_markup: adminKeyboard(admin.role)
      }
    );

    return;
  }

  if (
    command === "/adchannel" ||
    command === "/addchannel"
  ) {
    await addChannelFromCommand(
      message,
      admin,
      command
    );
    return;
  }

  if (command === "/delchannel") {
    if (!hasChannelPermission(admin)) {
      await sendMessage(message.chat.id, "⛔ Admin access denied.");
      return;
    }

    const id = Number(parts[1]);

    if (!Number.isInteger(id) || id <= 0) {
      await sendMessage(
        message.chat.id,
        "Usage: <code>/delchannel DATABASE_ID</code>"
      );
      return;
    }

    const result = await pool.query(
      `
      DELETE FROM channels
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    await sendMessage(
      message.chat.id,
      result.rows.length
        ? "✅ Channel removed."
        : "⚠️ Channel ID not found."
    );

    return;
  }

  if (command === "/addvoucher") {
    const raw = text.replace(
      /^\/addvoucher(?:@\w+)?\s*/i,
      ""
    );

    const p = raw.split("|").map(x => x.trim());

    if (p.length < 3) {
      await sendMessage(
        message.chat.id,
        `<b>Format:</b>\n<code>/addvoucher CODE | Description | Reward</code>`
      );
      return;
    }

    const reward = Number(p[2]);

    if (!Number.isFinite(reward) || reward < 0) {
      await sendMessage(
        message.chat.id,
        "❌ Invalid reward amount."
      );
      return;
    }

    await pool.query(
      `
      INSERT INTO vouchers
        (code, description, reward, active)
      VALUES
        ($1, $2, $3, true)
      `,
      [p[0], p[1], reward]
    );

    await sendMessage(
      message.chat.id,
      "✅ Voucher created successfully."
    );

    return;
  }

  if (command === "/disablevoucher") {
    const id = Number(parts[1]);

    if (!Number.isInteger(id) || id <= 0) {
      await sendMessage(
        message.chat.id,
        "Usage: <code>/disablevoucher ID</code>"
      );
      return;
    }

    await pool.query(
      `
      UPDATE vouchers
      SET active = false
      WHERE id = $1
      `,
      [id]
    );

    await sendMessage(
      message.chat.id,
      "✅ Voucher disabled."
    );

    return;
  }

  if (command === "/block") {
    const target = parts[1];

    if (!target || !/^\d+$/.test(target)) {
      await sendMessage(
        message.chat.id,
        "Usage: <code>/block TELEGRAM_ID</code>"
      );
      return;
    }

    await pool.query(
      `
      UPDATE users
      SET blocked = true,
          updated_at = NOW()
      WHERE telegram_id = $1
      `,
      [String(target)]
    );

    await sendMessage(
      message.chat.id,
      "🚫 User blocked."
    );

    return;
  }

  if (command === "/unblock") {
    const target = parts[1];

    if (!target || !/^\d+$/.test(target)) {
      await sendMessage(
        message.chat.id,
        "Usage: <code>/unblock TELEGRAM_ID</code>"
      );
      return;
    }

    await pool.query(
      `
      UPDATE users
      SET blocked = false,
          updated_at = NOW()
      WHERE telegram_id = $1
      `,
      [String(target)]
    );

    await sendMessage(
      message.chat.id,
      "✅ User unblocked."
    );

    return;
  }

  if (command === "/setsetting") {
    const raw = text.replace(
      /^\/setsetting(?:@\w+)?\s*/i,
      ""
    );

    const p = raw.split("|").map(x => x.trim());

    if (p.length < 2 || !p[0]) {
      await sendMessage(
        message.chat.id,
        `<b>Format:</b>\n<code>/setsetting KEY | VALUE</code>`
      );
      return;
    }

    await pool.query(
      `
      INSERT INTO app_settings
        (key, value, updated_at)
      VALUES
        ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
      `,
      [
        p[0],
        p.slice(1).join(" | ")
      ]
    );

    await sendMessage(
      message.chat.id,
      "✅ Setting updated."
    );

    return;
  }

  if (command === "/id") {
    await sendMessage(
      message.chat.id,
      `<b>Telegram ID</b>\n\n<code>${user.id}</code>`
    );
    return;
  }

  if (command === "/addadmin") {
    if (!isOwnerRole(admin)) {
      await sendMessage(
        message.chat.id,
        "⛔ Owner access required."
      );
      return;
    }

    const target = parts[1];

    if (!target || !/^\d+$/.test(target)) {
      await sendMessage(
        message.chat.id,
        "Usage: <code>/addadmin TELEGRAM_ID</code>"
      );
      return;
    }

    await pool.query(
      `
      INSERT INTO admins (telegram_id, role)
      VALUES ($1, 'admin')
      ON CONFLICT (telegram_id)
      DO UPDATE SET role = 'admin'
      `,
      [String(target)]
    );

    await sendMessage(
      message.chat.id,
      `✅ Admin added: <code>${target}</code>`
    );

    return;
  }

  if (command === "/removeadmin") {
    if (!isOwnerRole(admin)) {
      await sendMessage(
        message.chat.id,
        "⛔ Owner access required."
      );
      return;
    }

    const target = parts[1];

    if (!target || !/^\d+$/.test(target)) {
      await sendMessage(
        message.chat.id,
        "Usage: <code>/removeadmin TELEGRAM_ID</code>"
      );
      return;
    }

    if (String(target) === String(process.env.OWNER_ID)) {
      await sendMessage(
        message.chat.id,
        "❌ The configured owner cannot be removed here."
      );
      return;
    }

    await pool.query(
      `
      DELETE FROM admins
      WHERE telegram_id = $1
        AND role NOT IN ('owner', 'super_admin')
      `,
      [String(target)]
    );

    await sendMessage(
      message.chat.id,
      "✅ Admin removal request processed."
    );

    return;
  }
}

/* =========================
   WEBHOOK ENTRY
========================= */

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return reply(res, {
      ok: true,
      message: "Bot webhook is running."
    });
  }

  try {
    if (!BOT_TOKEN) {
      return reply(res, {
        ok: false,
        error: "BOT_TOKEN is not configured"
      });
    }

    if (!process.env.DATABASE_URL) {
      return reply(res, {
        ok: false,
        error: "DATABASE_URL is not configured"
      });
    }

    const update =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    await ensureOwner();

    /* =========================
       CALLBACK QUERY
    ========================= */

    if (update.callback_query) {
      const call = update.callback_query;
      const user = call.from;
      const data = call.data || "";
      const message = call.message;

      await saveUser(user);

      if (data === "check_join") {
        const check = await checkAllChannels(user.id);

        if (!check.allJoined) {
          await answerCallback(
            call.id,
            "❌ Please join all required channels first."
          );

          await editMessage(
            message.chat.id,
            message.message_id,
            `<b>🔐 Channel Verification</b>

You still have ${check.notJoined.length} required channel(s) left to join.

Join them and tap <b>Request Check</b>.`,
            {
              reply_markup: joinKeyboard(check.notJoined)
            }
          );

          return reply(res, { ok: true });
        }

        await pool.query(
          `
          UPDATE users
          SET verified = true,
              updated_at = NOW()
          WHERE telegram_id = $1
          `,
          [String(user.id)]
        );

        await processReferral(user);

        await answerCallback(
          call.id,
          "✅ Verification successful!"
        );

        await editMessage(
          message.chat.id,
          message.message_id,
          `<b>✅ Verification complete</b>

Your dashboard is ready.`,
          {
            reply_markup: dashboardKeyboard()
          }
        );

        return reply(res, { ok: true });
      }

      if (data.startsWith("admin_")) {
        const admin = await getAdmin(user.id);

        if (!admin) {
          await answerCallback(
            call.id,
            "⛔ Admin access denied."
          );

          return reply(res, { ok: true });
        }

        await answerCallback(call.id);

        if (data === "admin_main") {
          await adminMain(
            message.chat.id,
            message.message_id,
            admin
          );
        } else if (data === "admin_dashboard") {
          await adminDashboard(
            message.chat.id,
            message.message_id
          );
        } else if (data === "admin_users") {
          await adminUsers(
            message.chat.id,
            message.message_id
          );
        } else if (data === "admin_channels") {
          await adminChannels(
            message.chat.id,
            message.message_id
          );
        } else if (data === "admin_vouchers") {
          await adminVouchers(
            message.chat.id,
            message.message_id
          );
        } else if (data === "admin_referrals") {
          await adminReferrals(
            message.chat.id,
            message.message_id
          );
        } else if (data === "admin_settings") {
          await adminSettings(
            message.chat.id,
            message.message_id
          );
        } else if (data === "admin_admins") {
          if (!isOwnerRole(admin)) {
            await sendMessage(
              message.chat.id,
              "⛔ Owner access required."
            );
          } else {
            const admins = await pool.query(`
              SELECT telegram_id, role
              FROM admins
              ORDER BY id ASC
            `);

            let text = `<b>👑 Administrators</b>\n\n`;

            for (const a of admins.rows) {
              text +=
                `• <code>${escapeHtml(a.telegram_id)}</code> — ` +
                `${escapeHtml(a.role)}\n`;
            }

            text +=
              `\n<b>Add admin:</b>\n` +
              `<code>/addadmin TELEGRAM_ID</code>\n\n` +
              `<b>Remove admin:</b>\n` +
              `<code>/removeadmin TELEGRAM_ID</code>`;

            await editMessage(
              message.chat.id,
              message.message_id,
              text,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "🔙 Admin",
                        callback_data: "admin_main"
                      }
                    ]
                  ]
                }
              }
            );
          }
        }

        return reply(res, { ok: true });
      }

      return reply(res, { ok: true });
    }

    /* =========================
       NORMAL MESSAGE
    ========================= */

    if (update.message) {
      const message = update.message;
      const user = message.from;

      if (!user) {
        return reply(res, { ok: true });
      }

      await saveUser(user);

      const text = message.text || "";

      if (text.startsWith("/start")) {
        const startParts = text.trim().split(/\s+/);
        const payload = startParts[1] || "";

        if (payload.startsWith("ref_")) {
          const refTelegramId = payload.substring(4);

          if (
            /^\d+$/.test(refTelegramId) &&
            String(refTelegramId) !== String(user.id)
          ) {
            const referrer = await pool.query(
              `
              SELECT id
              FROM users
              WHERE telegram_id = $1
              LIMIT 1
              `,
              [String(refTelegramId)]
            );

            if (referrer.rows.length) {
              await pool.query(
                `
                UPDATE users
                SET referred_by = $1,
                    updated_at = NOW()
                WHERE telegram_id = $2
                  AND referred_by IS NULL
                `,
                [
                  referrer.rows[0].id,
                  String(user.id)
                ]
              );
            }
          }
        }

        await showStart(
          message.chat.id,
          user
        );

        return reply(res, { ok: true });
      }

      const admin = await getAdmin(user.id);

      if (admin) {
        await handleAdminCommand(
          message,
          user
        );

        return reply(res, { ok: true });
      }

      if (text === "/id") {
        await sendMessage(
          message.chat.id,
          `<b>Your Telegram ID:</b>\n\n<code>${user.id}</code>`
        );

        return reply(res, { ok: true });
      }

      await sendMessage(
        message.chat.id,
        `<b>👋 Welcome!</b>

Use /start to open the bot.`
      );

      return reply(res, { ok: true });
    }

    return reply(res, { ok: true });

  } catch (error) {
    console.error("BOT WEBHOOK ERROR:", error);

    return reply(res, {
      ok: false,
      error: "Webhook processing failed"
    });
  }
}; a
