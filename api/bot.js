const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
const BOT_USERNAME = process.env.BOT_USERNAME || "";

function reply(res, data) {
  res.status(200).json(data);
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

async function saveUser(user) {
  const r = await pool.query(
    `
    INSERT INTO users
      (
        telegram_id,
        username,
        first_name,
        last_name
      )
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

    if (!r.ok) return false;

    const status = r.result.status;

    return [
      "creator",
      "administrator",
      "member"
    ].includes(status);
  } catch {
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

function joinKeyboard(channels) {
  const rows = [];

  for (const channel of channels) {
    const link =
      channel.invite_link ||
      (
        channel.username
          ? `https://t.me/${channel.username.replace("@", "")}`
          : null
      );

    if (link) {
      rows.push([
        {
          text: `📢 ${channel.title || "Join Channel"}`,
          url: link
        }
      ]);
    }
  }

  rows.push([
    {
      text: "✅ Check Joined",
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

async function showStart(chatId, user) {
  await saveUser(user);

  const check = await checkAllChannels(user.id);

  if (!check.allJoined) {

    return sendMessage(
      chatId,
      `<b>🔐 Welcome to Reward Center</b>

To continue, please join all required channels below.

After joining, tap <b>Check Joined</b>.`,
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

async function processReferral(user) {

  const existing = await pool.query(
    `
    SELECT id
    FROM referrals
    WHERE referred_user_id = (
      SELECT id
      FROM users
      WHERE telegram_id = $1
      LIMIT 1
    )
    LIMIT 1
    `,
    [String(user.id)]
  );

  if (existing.rows.length) return;

  const ref = await pool.query(
    `
    SELECT referred_by
    FROM users
    WHERE telegram_id = $1
    LIMIT 1
    `,
    [String(user.id)]
  );

  if (
    !ref.rows.length ||
    !ref.rows[0].referred_by
  ) {
    return;
  }

  const referredBy = Number(
    ref.rows[0].referred_by
  );

  if (referredBy === Number(user.id)) return;

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

  const setting = await pool.query(
    `
    SELECT value
    FROM app_settings
    WHERE key = 'referral_bonus'
    LIMIT 1
    `
  );

  const bonus = Number(
    setting.rows[0]?.value || 0
  );

  await pool.query(
    `
    INSERT INTO referrals
      (referrer_id, referred_user_id)
    VALUES
      ($1, (
        SELECT id
        FROM users
        WHERE telegram_id = $2
        LIMIT 1
      ))
    ON CONFLICT (referred_user_id)
    DO NOTHING
    `,
    [
      referredBy,
      String(user.id)
    ]
  );

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

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
        `👤 <b>${escapeHtml(
          u.first_name || "User"
        )}</b>\n` +
        `ID: <code>${u.telegram_id}</code>\n` +
        `Balance: ₹${Number(u.balance || 0).toFixed(2)}\n` +
        `Status: ${u.blocked ? "🚫 Blocked" : u.verified ? "✅ Verified" : "⏳ Unverified"}\n\n`;
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

async function adminChannels(chatId, messageId) {

  const r = await pool.query(`
    SELECT
      id,
      channel_id,
      title,
      username,
      active,
      required
    FROM channels
    ORDER BY id DESC
  `);

  let text = `<b>📢 Channels</b>\n\n`;

  if (!r.rows.length) {
    text += "No channels added.\n\n";
  } else {

    for (const c of r.rows) {
      text +=
        `<b>${escapeHtml(c.title || "Channel")}</b>\n` +
        `ID: <code>${escapeHtml(c.channel_id)}</code>\n` +
        `${c.username ? `Username: ${escapeHtml(c.username)}\n` : ""}` +
        `Required: ${c.required ? "Yes" : "No"}\n` +
        `Status: ${c.active ? "🟢 Active" : "🔴 Off"}\n\n`;
    }
  }

  text +=
    `<b>Add:</b>\n` +
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

async function adminReferrals(chatId, messageId) {

  const r = await pool.query(`
    SELECT
      COUNT(*)::int AS total
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
  const command = parts[0].split("@")[0].toLowerCase();

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
    command === "/addchannel" &&
    (admin.role === "owner" ||
      admin.role === "super_admin" ||
      admin.role === "admin")
  ) {

    const raw = text
      .replace(/^\/addchannel(?:@\w+)?\s*/i, "");

    const p = raw.split("|").map(x => x.trim());

    if (p.length < 4) {
      await sendMessage(
        message.chat.id,
        `<b>Format:</b>

<code>/addchannel ID | Title | Username | InviteLink</code>`
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
        active = true
      `,
      [
        p[0],
        p[1],
        p[2],
        p[3]
      ]
    );

    await sendMessage(
      message.chat.id,
      "✅ Channel added successfully."
    );

    return;
  }

  if (command === "/delchannel") {

    const id = Number(parts[1]);

    if (!id) {
      await sendMessage(
        message.chat.id,
        "Usage: <code>/delchannel DATABASE_ID</code>"
      );
      return;
    }

    await pool.query(
      `
      DELETE FROM channels
      WHERE id = $1
      `,
      [id]
    );

    await sendMessage(
      message.chat.id,
      "✅ Channel removed."
    );

    return;
  }

  if (command === "/addvoucher") {

    const raw = text
      .replace(/^\/addvoucher(?:@\w+)?\s*/i, "");

    const p = raw.split("|").map(x => x.trim());

    if (p.length < 3) {
      await sendMessage(
        message.chat.id,
        `<b>Format:</b>

<code>/addvoucher CODE | Description | Reward</code>`
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
        (
          code,
          description,
          reward,
          active
        )
      VALUES
        ($1, $2, $3, true)
      `,
      [
        p[0],
        p[1],
        reward
      ]
    );

    await sendMessage(
      message.chat.id,
      "✅ Voucher created successfully."
    );

    return;
  }

  if (command === "/disablevoucher") {

    const id = Number(parts[1]);

    if (!id) {
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

    if (!target) {
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

    if (!target) {
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

    const raw = text
      .replace(/^\/setsetting(?:@\w+)?\s*/i, "");

    const p = raw.split("|").map(x => x.trim());

    if (p.length < 2) {
      await sendMessage(
        message.chat.id,
        `<b>Format:</b>

<code>/setsetting KEY | VALUE</code>`
      );
      return;
    }

    await pool.query(
      `
      INSERT INTO app_settings
        (key, value, updated_at)
      VALUES
        ($1, $2)
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
      `<b>Telegram ID</b>

<code>${user.id}</code>`
    );

    return;
  }
}

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

    await ensureOwner();

    const update =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

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

Join them and tap <b>Check Joined</b>.`,
            {
              reply_markup:
                joinKeyboard(check.notJoined)
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
            reply_markup:
              dashboardKeyboard()
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
        }

        else if (data === "admin_dashboard") {
          await adminDashboard(
            message.chat.id,
            message.message_id
          );
        }

        else if (data === "admin_users") {
          await adminUsers(
            message.chat.id,
            message.message_id
          );
        }

        else if (data === "admin_channels") {
          await adminChannels(
            message.chat.id,
            message.message_id
          );
        }

        else if (data === "admin_vouchers") {
          await adminVouchers(
            message.chat.id,
            message.message_id
          );
        }

        else if (data === "admin_referrals") {
          await adminReferrals(
            message.chat.id,
            message.message_id
          );
        }

        else if (data === "admin_settings") {
          await adminSettings(
            message.chat.id,
            message.message_id
          );
        }

        else if (data === "admin_admins") {

          if (
            admin.role !== "owner" &&
            admin.role !== "super_admin"
          ) {
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

            let text =
              `<b>👑 Administrators</b>\n\n`;

            for (const a of admins.rows) {
              text +=
                `• <code>${a.telegram_id}</code> — ${escapeHtml(a.role)}\n`;
            }

            text +=
              `\nAdd admin:\n` +
              `<code>/addadmin TELEGRAM_ID</code>`;

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

      if (
        text.startsWith("/start")
      ) {

        const startParts =
          text.trim().split(/\s+/);

        const payload =
          startParts[1] || "";

        if (
          payload.startsWith("ref_")
        ) {

          const refTelegramId =
            payload.substring(4);

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
};
