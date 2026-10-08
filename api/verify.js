// Vercel Serverless Function.
// Install: npm install @vercel/node
// IMPORTANT: set BOT_TOKEN as a Vercel Environment Variable.
// Never put the bot token in index.html.

const crypto = require("crypto");

const REQUIRED_CHANNELS = [
  { id: "@YourChannel1", name: "Main Channel", link: "https://t.me/YourChannel1" },
  { id: "@YourChannel2", name: "Rewards Channel", link: "https://t.me/YourChannel2" }
];

function validateInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");
  const pairs = [...params.entries()]
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculated = crypto
    .createHmac("sha256", secret)
    .update(pairs)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash))) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.floor(Date.now()/1000) - authDate > 86400) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;

  return JSON.parse(userRaw);
}

async function memberStatus(chatId, userId, token) {
  const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!data.ok) return false;
  const s = data.result.status;
  return ["creator","administrator","member"].includes(s) ||
    (s === "restricted" && data.result.is_member === true);
}

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({channels: REQUIRED_CHANNELS});

  if (req.method !== "POST") return res.status(405).json({verified:false,message:"Method not allowed"});

  try {
    const token = "8714642881:AAGk1Tf8BvcS6w2tX0pEGQW5VWhcOiAhyc8";
    if (!token) return res.status(500).json({verified:false,message:"BOT_TOKEN is not configured"});

    const user = validateInitData(req.body?.initData || "", token);
    if (!user) return res.status(401).json({verified:false,message:"Invalid Telegram session"});

    for (const ch of REQUIRED_CHANNELS) {
      const ok = await memberStatus(ch.id, user.id, token);
      if (!ok) return res.status(403).json({verified:false,message:`Join ${ch.name} first`});
    }

    // Replace these demo values with your database lookup.
    return res.status(200).json({
      verified:true,
      referrals:0,
      claimed:0,
      user:{id:user.id, first_name:user.first_name, username:user.username || null}
    });
  } catch (e) {
    return res.status(500).json({verified:false,message:"Verification error"});
  }
};
