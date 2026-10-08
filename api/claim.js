const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function send(res, status, data) {
  return res.status(status).json(data);
}

function validateInitData(initData) {
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
        Buffer.from(receivedHash),
        Buffer.from(calculatedHash)
      )
    ) {
      return null;
    }

    const authDate = Number(params.get("auth_date") || 0);

    if (!authDate) return null;

    if (Math.floor(Date.now() / 1000) - authDate > 86400) {
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
    return send(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  if (!process.env.DATABASE_URL) {
    return send(res, 500, {
      ok: false,
      error: "DATABASE_URL is not configured"
    });
  }

  const client = await pool.connect();

  try {

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    const telegramUser = validateInitData(body.initData);

    if (!telegramUser) {
      return send(res, 401, {
        ok: false,
        error: "Invalid Telegram session"
      });
    }

    const voucherId = Number(body.voucher_id);

    if (!Number.isInteger(voucherId) || voucherId <= 0) {
      return send(res, 400, {
        ok: false,
        error: "Invalid voucher"
      });
    }

    await client.query("BEGIN");

    const userResult = await client.query(
      `
      SELECT id, balance, blocked, verified
      FROM users
      WHERE telegram_id = $1
      FOR UPDATE
      `,
      [String(telegramUser.id)]
    );

    if (!userResult.rows.length) {
      await client.query("ROLLBACK");

      return send(res, 404, {
        ok: false,
        error: "User not found"
      });
    }

    const user = userResult.rows[0];

    if (user.blocked) {
      await client.query("ROLLBACK");

      return send(res, 403, {
        ok: false,
        error: "Your account is blocked."
      });
    }

    if (!user.verified) {
      await client.query("ROLLBACK");

      return send(res, 403, {
        ok: false,
        error: "Please complete channel verification first."
      });
    }

    const voucherResult = await client.query(
      `
      SELECT
        id,
        code,
        description,
        reward,
        active,
        expires_at
      FROM vouchers
      WHERE id = $1
      FOR UPDATE
      `,
      [voucherId]
    );

    if (!voucherResult.rows.length) {
      await client.query("ROLLBACK");

      return send(res, 404, {
        ok: false,
        error: "Voucher not found."
      });
    }

    const voucher = voucherResult.rows[0];

    if (!voucher.active) {
      await client.query("ROLLBACK");

      return send(res, 400, {
        ok: false,
        error: "This voucher is no longer active."
      });
    }

    if (
      voucher.expires_at &&
      new Date(voucher.expires_at).getTime() <= Date.now()
    ) {
      await client.query("ROLLBACK");

      return send(res, 400, {
        ok: false,
        error: "This voucher has expired."
      });
    }

    const alreadyClaimed = await client.query(
      `
      SELECT id
      FROM voucher_claims
      WHERE user_id = $1
        AND voucher_id = $2
      LIMIT 1
      `,
      [user.id, voucher.id]
    );

    if (alreadyClaimed.rows.length) {
      await client.query("ROLLBACK");

      return send(res, 409, {
        ok: false,
        error: "You already claimed this voucher."
      });
    }

    const reward = Number(voucher.reward || 0);

    if (!Number.isFinite(reward) || reward < 0) {
      await client.query("ROLLBACK");

      return send(res, 400, {
        ok: false,
        error: "Invalid voucher reward."
      });
    }

    await client.query(
      `
      INSERT INTO voucher_claims
        (user_id, voucher_id)
      VALUES
        ($1, $2)
      `,
      [user.id, voucher.id]
    );

    const updatedUser = await client.query(
      `
      UPDATE users
      SET balance = COALESCE(balance, 0) + $1
      WHERE id = $2
      RETURNING balance
      `,
      [reward, user.id]
    );

    await client.query("COMMIT");

    return send(res, 200, {
      ok: true,
      message:
        reward > 0
          ? `Voucher claimed! ₹${reward} added.`
          : "Voucher claimed successfully.",
      reward,
      balance: updatedUser.rows[0].balance
    });

  } catch (error) {

    try {
      await client.query("ROLLBACK");
    } catch {}

    if (error.code === "23505") {
      return send(res, 409, {
        ok: false,
        error: "You already claimed this voucher."
      });
    }

    console.error("CLAIM API ERROR:", error);

    return send(res, 500, {
      ok: false,
      error: "Internal server error"
    });

  } finally {
    client.release();
  }
};
