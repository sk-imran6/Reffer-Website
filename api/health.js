const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function json(res, status, data) {
  return res.status(status).json(data);
}

async function telegram(method) {
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`
  );

  return await response.json();
}

module.exports = async (req, res) => {

  if (req.method !== "GET") {
    return json(res, 405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  const result = {
    ok: true,
    database: false,
    telegram: false,
    bot: null,
    time: new Date().toISOString()
  };

  try {

    if (process.env.DATABASE_URL) {
      await pool.query("SELECT 1");
      result.database = true;
    }

    if (process.env.BOT_TOKEN) {
      const telegramResult = await telegram("getMe");

      if (telegramResult.ok) {
        result.telegram = true;

        result.bot = {
          id: telegramResult.result.id,
          username: telegramResult.result.username,
          name: telegramResult.result.first_name
        };
      }
    }

    result.ok =
      result.database &&
      result.telegram;

    return json(
      res,
      result.ok ? 200 : 503,
      result
    );

  } catch (error) {

    console.error("HEALTH ERROR:", error);

    return json(res, 503, {
      ok: false,
      database: result.database,
      telegram: result.telegram,
      error: "Health check failed",
      time: new Date().toISOString()
    });
  }
};
