
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

  const body =
    typeof req.body === "string"
      ? (() => {
          try {
            return JSON.parse(req.body || "{}");
          } catch {
            return null;
          }
        })()
      : (req.body || {});

  if (!body) {
    return send(res, 400, {
      ok: false,
      error: "Invalid request body"
    });
  }

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

  let client;

  try {
    client = await pool.connect();

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
        error: "Please start the bot first."
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
      SELECT id, code, description, reward, active, expires_at
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

    const referralResult = await client.query(
      `
      SELECT COUNT(*)::int AS total
      FROM referrals
      WHERE referrer_id = $1
      `,
      [user.id]
    );

    const usedResult = await client.query(
      `
      SELECT COALESCE(SUM(referrals_used), 0)::int AS used
      FROM referral_claims
      WHERE user_id = $1
      `,
      [user.id]
    );

    const totalReferrals = referralResult.rows[0].total;
    const referralsUsed = usedResult.rows[0].used;
    const availableReferrals = Math.max(
      0,
      totalReferrals - referralsUsed
    );

    if (availableReferrals < 5) {
      await client.query("ROLLBACK");

      return send(res, 400, {
        ok: false,
        error: "You need 5 available referrals to claim this code.",
        total_referrals: totalReferrals,
        referrals_used: referralsUsed,
        available_referrals: availableReferrals,
        required_referrals: 5
      });
    }

    await client.query(
      `
      INSERT INTO referral_claims
        (user_id, referrals_used, voucher_id)
      VALUES
        ($1, 5, $2)
      `,
      [user.id, voucher.id]
    );

    const remainingReferrals = availableReferrals - 5;

    await client.query("COMMIT");

    return send(res, 200, {
      ok: true,
      message: "Voucher code claimed successfully!",
      code: voucher.code,
      description: voucher.description || "",
      referrals_used: 5,
      total_referrals: totalReferrals,
      available_referrals: remainingReferrals,
      required_referrals: 5
    });

  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    console.error("CLAIM API ERROR:", error);

    return send(res, 500, {
      ok: false,
      error: "Internal server error"
    });

  } finally {
    if (client) client.release();
  }
};
