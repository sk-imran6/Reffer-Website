const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function json(res, status, data) {
  return res.status(status).json(data);
}

async function isAdmin(telegramId) {
  const result = await pool.query(
    `
    SELECT id, telegram_id, role
    FROM admins
    WHERE telegram_id = $1
    LIMIT 1
    `,
    [String(telegramId)]
  );

  return result.rows[0] || null;
}

module.exports = async (req, res) => {

  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  try {

    if (!process.env.DATABASE_URL) {
      return json(res, 500, {
        ok: false,
        error: "DATABASE_URL is not configured"
      });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    const telegramId = body.telegram_id;

    if (!telegramId) {
      return json(res, 400, {
        ok: false,
        error: "telegram_id is required"
      });
    }

    const admin = await isAdmin(telegramId);

    if (!admin) {
      return json(res, 403, {
        ok: false,
        error: "Admin access denied"
      });
    }

    const action = body.action;

    /* =========================
       DASHBOARD
    ========================= */

    if (action === "dashboard") {

      const [
        users,
        verified,
        vouchers,
        claims,
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
          FROM voucher_claims
        `),

        pool.query(`
          SELECT COUNT(*)::int AS count
          FROM referrals
        `)

      ]);

      return json(res, 200, {
        ok: true,
        admin,
        stats: {
          users: users.rows[0].count,
          verified_users: verified.rows[0].count,
          active_vouchers: vouchers.rows[0].count,
          voucher_claims: claims.rows[0].count,
          referrals: referrals.rows[0].count
        }
      });
    }

    /* =========================
       USERS
    ========================= */

    if (action === "users") {

      const result = await pool.query(`
        SELECT
          id,
          telegram_id,
          username,
          first_name,
          last_name,
          balance,
          verified,
          blocked,
          created_at
        FROM users
        ORDER BY id DESC
        LIMIT 100
      `);

      return json(res, 200, {
        ok: true,
        users: result.rows
      });
    }

    /* =========================
       BLOCK USER
    ========================= */

    if (action === "block_user") {

      if (!body.user_id) {
        return json(res, 400, {
          ok: false,
          error: "user_id is required"
        });
      }

      await pool.query(
        `
        UPDATE users
        SET blocked = true,
            updated_at = NOW()
        WHERE id = $1
        `,
        [Number(body.user_id)]
      );

      return json(res, 200, {
        ok: true,
        message: "User blocked."
      });
    }

    /* =========================
       UNBLOCK USER
    ========================= */

    if (action === "unblock_user") {

      if (!body.user_id) {
        return json(res, 400, {
          ok: false,
          error: "user_id is required"
        });
      }

      await pool.query(
        `
        UPDATE users
        SET blocked = false,
            updated_at = NOW()
        WHERE id = $1
        `,
        [Number(body.user_id)]
      );

      return json(res, 200, {
        ok: true,
        message: "User unblocked."
      });
    }

    /* =========================
       CHANNELS
    ========================= */

    if (action === "channels") {

      const result = await pool.query(`
        SELECT
          id,
          channel_id,
          title,
          username,
          invite_link,
          required,
          active,
          created_at
        FROM channels
        ORDER BY id DESC
      `);

      return json(res, 200, {
        ok: true,
        channels: result.rows
      });
    }

    /* =========================
       ADD CHANNEL
    ========================= */

    if (action === "add_channel") {

      if (!body.channel_id) {
        return json(res, 400, {
          ok: false,
          error: "channel_id is required"
        });
      }

      const result = await pool.query(
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
          ($1, $2, $3, $4, $5, true)
        ON CONFLICT (channel_id)
        DO UPDATE SET
          title = EXCLUDED.title,
          username = EXCLUDED.username,
          invite_link = EXCLUDED.invite_link,
          required = EXCLUDED.required,
          active = true
        RETURNING *
        `,
        [
          String(body.channel_id),
          body.title || "",
          body.username || "",
          body.invite_link || "",
          body.required !== false
        ]
      );

      return json(res, 200, {
        ok: true,
        channel: result.rows[0]
      });
    }

    /* =========================
       REMOVE CHANNEL
    ========================= */

    if (action === "remove_channel") {

      if (!body.channel_id) {
        return json(res, 400, {
          ok: false,
          error: "channel_id is required"
        });
      }

      await pool.query(
        `
        DELETE FROM channels
        WHERE id = $1
        `,
        [Number(body.channel_id)]
      );

      return json(res, 200, {
        ok: true,
        message: "Channel removed."
      });
    }

    /* =========================
       VOUCHERS
    ========================= */

    if (action === "vouchers") {

      const result = await pool.query(`
        SELECT
          id,
          code,
          description,
          reward,
          active,
          expires_at,
          created_at
        FROM vouchers
        ORDER BY id DESC
      `);

      return json(res, 200, {
        ok: true,
        vouchers: result.rows
      });
    }

    /* =========================
       ADD VOUCHER
    ========================= */

    if (action === "add_voucher") {

      if (!body.code) {
        return json(res, 400, {
          ok: false,
          error: "Voucher code is required"
        });
      }

      const reward = Number(body.reward || 0);

      if (!Number.isFinite(reward) || reward < 0) {
        return json(res, 400, {
          ok: false,
          error: "Invalid reward"
        });
      }

      const result = await pool.query(
        `
        INSERT INTO vouchers
          (
            code,
            description,
            reward,
            active,
            expires_at
          )
        VALUES
          ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [
          String(body.code).trim(),
          body.description || "",
          reward,
          body.active !== false,
          body.expires_at || null
        ]
      );

      return json(res, 200, {
        ok: true,
        voucher: result.rows[0]
      });
    }

    /* =========================
       DISABLE VOUCHER
    ========================= */

    if (action === "disable_voucher") {

      if (!body.voucher_id) {
        return json(res, 400, {
          ok: false,
          error: "voucher_id is required"
        });
      }

      await pool.query(
        `
        UPDATE vouchers
        SET active = false
        WHERE id = $1
        `,
        [Number(body.voucher_id)]
      );

      return json(res, 200, {
        ok: true,
        message: "Voucher disabled."
      });
    }

    /* =========================
       REFERRALS
    ========================= */

    if (action === "referrals") {

      const result = await pool.query(`
        SELECT
          r.id,
          r.referrer_id,
          r.referred_user_id,
          r.created_at,
          u1.telegram_id AS referrer_telegram_id,
          u1.username AS referrer_username,
          u2.telegram_id AS referred_telegram_id,
          u2.username AS referred_username
        FROM referrals r
        LEFT JOIN users u1
          ON u1.id = r.referrer_id
        LEFT JOIN users u2
          ON u2.id = r.referred_user_id
        ORDER BY r.id DESC
        LIMIT 100
      `);

      return json(res, 200, {
        ok: true,
        referrals: result.rows
      });
    }

    /* =========================
       SETTINGS
    ========================= */

    if (action === "settings") {

      const result = await pool.query(`
        SELECT key, value, updated_at
        FROM app_settings
        ORDER BY key
      `);

      return json(res, 200, {
        ok: true,
        settings: result.rows
      });
    }

    /* =========================
       UPDATE SETTING
    ========================= */

    if (action === "set_setting") {

      if (!body.key) {
        return json(res, 400, {
          ok: false,
          error: "Setting key is required"
        });
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
          String(body.key),
          String(body.value ?? "")
        ]
      );

      return json(res, 200, {
        ok: true,
        message: "Setting updated."
      });
    }

    /* =========================
       ADMIN LOG
    ========================= */

    await pool.query(
      `
      INSERT INTO admin_logs
        (admin_id, action, details)
      VALUES
        ($1, $2, $3)
      `,
      [
        String(telegramId),
        String(action || "unknown"),
        JSON.stringify(body)
      ]
    );

    return json(res, 400, {
      ok: false,
      error: "Unknown admin action"
    });

  } catch (error) {

    console.error("ADMIN API ERROR:", error);

    return json(res, 500, {
      ok: false,
      error: "Admin operation failed"
    });
  }
};
