const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function db(query, values = []) {
  const result = await pool.query(query, values);
  return result.rows;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({
        success: false,
        message: "DATABASE_URL is not configured"
      });
    }

    if (req.method !== "GET") {
      return res.status(405).json({
        success: false,
        message: "Method not allowed"
      });
    }

    const userId = String(
      req.query.user_id || ""
    );

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "user_id is required"
      });
    }

    const users = await db(
      `
      SELECT
        telegram_id,
        username,
        first_name,
        last_name,
        verified,
        blocked,
        referrals,
        claimed
      FROM users
      WHERE telegram_id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (!users[0]) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = users[0];

    if (user.blocked) {
      return res.status(403).json({
        success: false,
        blocked: true,
        message: "User blocked"
      });
    }

    const vouchers = await db(`
      SELECT
        id,
        code,
        title,
        description,
        required_referrals,
        claim_limit,
        enabled
      FROM vouchers
      WHERE enabled = TRUE
      ORDER BY id DESC
      LIMIT 50
    `);

    const claimed = await db(
      `
      SELECT voucher_id
      FROM voucher_claims
      WHERE user_id = $1
      `,
      [userId]
    );

    const claimedIds = claimed.map(
      row => Number(row.voucher_id)
    );

    const referrals = await db(
      `
      SELECT
        COUNT(*)::INTEGER AS total
      FROM referrals
      WHERE inviter_id = $1
        AND verified = TRUE
      `,
      [userId]
    );

    const settingsRows = await db(`
      SELECT key, value
      FROM app_settings
    `);

    const settings = {};

    for (const row of settingsRows) {
      settings[row.key] = row.value;
    }

    return res.status(200).json({
      success: true,

      user: {
        id: user.telegram_id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        verified: user.verified,
        referrals: Number(
          referrals[0]?.total || 0
        ),
        claimed: Number(
          user.claimed || 0
        )
      },

      vouchers: vouchers.map(v => ({
        id: v.id,
        code: v.code,
        title: v.title,
        description: v.description,
        required_referrals:
          Number(v.required_referrals || 0),
        claim_limit:
          Number(v.claim_limit || 1),
        claimed:
          claimedIds.includes(Number(v.id))
      })),

      settings
    });

  } catch (error) {

    console.error(
      "APP API ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};
