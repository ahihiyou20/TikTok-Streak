// Temporary diagnostic: does this machine's IP accept the TikTok session? Prints no cookie values or personal data.
const fs = require("fs");
(async () => {
  const raw = process.env.COOKIES_JSON || fs.readFileSync("cookies.json", "utf8");
  const list = [].concat(JSON.parse(raw));
  const cookie = list.map((c) => `${c.name}=${c.value}`).join("; ");
  const geo = await fetch("https://ipinfo.io/json").then((r) => r.json()).catch(() => ({}));
  console.log("runner country:", geo.country, "| org:", geo.org);
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  const res = await fetch("https://www.tiktok.com/passport/web/account/info/?aid=1459", { headers: { cookie, "user-agent": ua } });
  const body = await res.json().catch(() => null);
  console.log("account/info status:", res.status, "| message:", body?.message, "| logged in:", !!body?.data?.user_id_str || !!body?.data?.username, "| error:", body?.data?.description || body?.data?.error_code || "");
  const set = res.headers.getSetCookie?.() || [];
  console.log("server set-cookie names:", set.map((s) => s.split("=")[0]).join(","));
  const idc = set.find((s) => s.startsWith("tt-target-idc="));
  console.log("tt-target-idc:", idc ? idc.split(";")[0].split("=")[1] : "(none)");
})();
