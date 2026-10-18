const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const figlet = require("figlet");
const moment = require("moment-timezone");
moment.tz.setDefault("Asia/Jakarta");
const { bold, red, yellow, blue, magenta, cyan, green } = require("kleur/colors");



const args = process.argv.slice(2);
const isDebug = args.includes("--debug");
const isDryRun = args.includes("--dry-run");
const CREDENTIALS_FILE = path.join(__dirname, "cookies.json");
const CONFIG_FILE = path.join(__dirname, "config.json");
const loadConfig = () => {
  const fromEnv = process.env.CONFIG_JSON;
  if (fromEnv) {
    try {
      return JSON.parse(fromEnv);
    } catch {
      throw new Error("Invalid CONFIG_JSON environment variable");
    }
  }
  if (!fs.existsSync(CONFIG_FILE))
    throw new Error("config.json tidak ditemukan");
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    throw new Error("Invalid config.json");
  }
};
const CONFIG = loadConfig();
if (process.env.HEADLESS !== undefined) CONFIG.headless = process.env.HEADLESS === "true";
if (process.env.TOTAL_USERS !== undefined) CONFIG.totalUsers = Number(process.env.TOTAL_USERS);
if (process.env.MESSAGE !== undefined) CONFIG.message = process.env.MESSAGE;
const BROWSER_CONFIG = {
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  headless: CONFIG.headless,
};
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  BROWSER_CONFIG.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}
const fetchQuote = async () => {
  try {
    const res = await fetch("https://dummyjson.com/quotes/random");
    const data = await res.json();
    return `"${data.quote}" — ${data.author}`;
  } catch {
    return null;
  }
};



const main = async () => {
  const banner = figlet.textSync("TikTok Streak", { font: CONFIG.bannerFont, horizontalLayout: "default", verticalLayout: "default" });
  console.clear();
  console.log(bold(cyan(banner)));
  console.log(yellow("\n[+] Made with 🚬 and ☕ by Saturia."));
  if (CONFIG.useQuotesAPi) console.log(blue("[+] Message: Random quote (dummyjson.com)"));
  else console.log(blue(`[+] Message: ${CONFIG.message}`));
  console.log(magenta(`[+] Delay: ${CONFIG.actionDelayMs} ms\n`));
  console.log(yellow(`[+] Mode: ${isDebug ? "Debug" : "Normal"}\n`));



  let credentials;
  if (process.env.COOKIES_JSON) {
    try {
      const data = JSON.parse(process.env.COOKIES_JSON);
      credentials = Array.isArray(data) ? { cookies: data } : { cookies: [data] };
      console.log(green("[+] Cookies loaded from COOKIES_JSON env var"));
    } catch {
      throw new Error("Invalid COOKIES_JSON environment variable");
    }
  } else if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
      credentials = Array.isArray(data) ? { cookies: data } : { cookies: [data] };
      console.log(yellow("[+] Cookies loaded from cookies.json (local only)"));
    } catch {
      throw new Error("Invalid session file");
    }
  } else {
    throw new Error("Session not found. Set COOKIES_JSON env var or create cookies.json");
  }



  let browser;
  try {
    browser = await puppeteer.launch(BROWSER_CONFIG);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setCookie(...credentials.cookies);
    if (isDebug) console.log(yellow("[+] Membuka halaman TikTok messages..."));
    await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
    if (isDebug) console.log(yellow("[+] Halaman loaded, tunggu UI siap..."));
    await new Promise((r) => setTimeout(r, CONFIG.pageLoadDelayMs));
    console.log(blue(`[+] URL: ${page.url()}`));
    if (/\/login/.test(page.url()))
      throw new Error("Redirected to login page: cookies are invalid/expired (or TikTok rejected the session from this IP)");



    let success = 0,
    failed = 0;
    // Business Suite wraps the inbox in an iframe; the normal /messages page does not
    // (personal accounts get redirected from business-suite to /messages).
    let frame = page.mainFrame();
    const iframe = await page.$("iframe[src*='/messages?']");
    if (iframe) {
      frame = await iframe.contentFrame();
      if (!frame) throw new Error("Messages iframe found but its content frame is not accessible");
    }
    if (isDebug) console.log(yellow(`[+] Using frame: ${frame.url()}`));
    await frame.waitForSelector('[data-e2e="dm-new-conversation-item"]', { timeout: 30000 })
      .catch(() => { throw new Error("Conversation list not found on the messages page"); });
    try {
      await frame.waitForSelector("._TUXModal-wrapper", { visible: true, timeout: 3000});
      await frame.evaluate(() => {
        const modal = document.querySelector("._TUXModal-wrapper");
        if (!modal) return;
        const rect = modal.getBoundingClientRect();
        const x = Math.max(1, rect.left - 10);
        const y = Math.max(1, rect.top - 10);
        document.elementFromPoint(x, y)?.click();
      });
    } catch (e) {
    }



    for (let i = 0; i < CONFIG.totalUsers; i++) {
      try {
        const userSelector = `div[data-index="${i}"] [data-e2e="dm-new-conversation-item"]`;
        await frame.waitForSelector(userSelector, { timeout: 3000 });
        await frame.click(userSelector);
        const nicknameSelector = `div[data-index="${i}"] [data-e2e="dm-new-conversation-nickname"]`;
        const username = await frame.evaluate((sel) => {
          return document.querySelector(sel)?.textContent || `user${i}`;
        }, nicknameSelector);
        console.log(yellow(`\n[${i + 1}/${CONFIG.totalUsers}] Mengirim pesan ke: ${username}`));
        await new Promise((r) => setTimeout(r, 500));
        if (isDebug) console.log(yellow("  [~] Mencari editor..."));
        await frame.waitForSelector("div.notranslate.public-DraftEditor-content", { timeout: 3000 });
        const editor = await frame.$("div.notranslate.public-DraftEditor-content");
        if (!editor) throw new Error("Editor not found");
        await editor.click();
        await new Promise((r) => setTimeout(r, CONFIG.afterClickDelayMs));
        let message = CONFIG.message;
        if (CONFIG.useQuotesAPi) {
          const quote = await fetchQuote();
          if (!quote) throw new Error("Gagal fetch quote");
          message = quote;
          if (isDebug) console.log(cyan(`  [~] Quote: ${quote}`));
        }
        await page.keyboard.type(message, { delay: CONFIG.typeDelayMs });
        await new Promise((r) => setTimeout(r, CONFIG.afterSendDelayMs));
        const editorText = () => frame.$eval("div.notranslate.public-DraftEditor-content", (el) => el.innerText.trim());
        if (isDryRun) {
          const typed = await editorText();
          await page.keyboard.down("Control");
          await page.keyboard.press("KeyA");
          await page.keyboard.up("Control");
          await page.keyboard.press("Backspace");
          if (typed !== message.trim()) throw new Error(`Typed text mismatch: "${typed}"`);
          console.log(green(`  [✓] Dry run: message typed, not sent`));
          success++;
          continue;
        }
        if (isDebug) console.log(blue("  [~] Mengirim dengan Ctrl+Enter..."));
        await page.keyboard.down("Control");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Control");
        await new Promise((r) => setTimeout(r, CONFIG.afterSendDelayMs));
        if (await editorText()) {
          if (isDebug) console.log(blue("  [~] Ctrl+Enter did not send, trying Enter..."));
          await page.keyboard.press("Enter");
          await new Promise((r) => setTimeout(r, CONFIG.afterSendDelayMs));
        }
        if (await editorText()) throw new Error("Message still in editor after sending: not sent");
        console.log(green(`  [✓] Terkirim!`));
        success++;
      } catch (e) {
        console.log(red(`  [✗] Error: ${e.message}`));
        failed++;
      }



      if (i < CONFIG.totalUsers - 1) {
        if (isDebug) console.log(yellow(`  [~] Tunggu ${CONFIG.actionDelayMs} ms...`));
        await new Promise((r) => setTimeout(r, CONFIG.actionDelayMs));
      }
    }



    console.log(green(`\n[+] SELESAI!`));
    console.log(blue(`[+] Success: ${success}`));
    console.log(red(`[+] Failed: ${failed}\n`));
    await new Promise((r) => setTimeout(r, CONFIG.finishDelayMs));
    if (success === 0) throw new Error("No messages were sent");
  } catch (e) {
    console.error(red(`[!] Fatal error: ${e.message}`));
    const page = browser && (await browser.pages().catch(() => []))[0];
    if (page) {
      await page.screenshot({ path: path.join(__dirname, "debug.png"), fullPage: true }).catch(() => {});
      console.error(red("[!] Screenshot saved to debug.png"));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
};



main();
