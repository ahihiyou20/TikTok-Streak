const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const figlet = require("figlet");
const { bold, red, yellow, blue, magenta, cyan, green } = require("kleur/colors");



const args = process.argv.slice(2);
const isDebug = args.includes("--debug");
const isDryRun = args.includes("--dry-run");
const isLogin = args.includes("--login");
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
    throw new Error("config.json not found");
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    throw new Error("Invalid config.json");
  }
};
// config.local.json (gitignored) overrides config.json, e.g. for your private `targets` list.
const LOCAL_CONFIG_FILE = path.join(__dirname, "config.local.json");
const loadLocalConfig = () => {
  if (!fs.existsSync(LOCAL_CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, "utf8"));
  } catch {
    throw new Error("Invalid config.local.json");
  }
};
const CONFIG = { ...loadConfig(), ...loadLocalConfig() };
if (process.env.HEADLESS !== undefined) CONFIG.headless = process.env.HEADLESS === "true";
if (process.env.TOTAL_USERS !== undefined) CONFIG.totalUsers = Number(process.env.TOTAL_USERS);
if (process.env.MESSAGE !== undefined) CONFIG.message = process.env.MESSAGE;
// Persistent Chrome profile: keeps the TikTok session (and its refreshed cookies) between runs.
const PROFILE_DIR = path.resolve(__dirname, CONFIG.userDataDir || "profile");
const BROWSER_CONFIG = {
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  headless: CONFIG.headless,
  userDataDir: PROFILE_DIR,
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 60000,
};
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  BROWSER_CONFIG.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchQuote = async () => {
  try {
    const res = await fetch("https://dummyjson.com/quotes/random");
    const data = await res.json();
    return `"${data.quote}" — ${data.author}`;
  } catch {
    return null;
  }
};



// Optional: cookies from COOKIES_JSON or cookies.json are imported into the profile.
// Not needed once you have logged in with `npm run login`.
const loadCookies = () => {
  let raw, source;
  if (process.env.COOKIES_JSON) [raw, source] = [process.env.COOKIES_JSON, "COOKIES_JSON env var"];
  else if (fs.existsSync(CREDENTIALS_FILE)) [raw, source] = [fs.readFileSync(CREDENTIALS_FILE, "utf8"), "cookies.json"];
  else return null;
  if (!raw.trim()) return null;
  try {
    const data = JSON.parse(raw);
    console.log(yellow(`[+] Cookies loaded from ${source}`));
    return Array.isArray(data) ? data : [data];
  } catch {
    throw new Error(`Invalid cookies in ${source}`);
  }
};



// Opens a normal (non-automated) Chrome window on the bot's profile so you can log in yourself.
const login = async () => {
  const executable = BROWSER_CONFIG.executablePath || (await puppeteer.executablePath());
  return new Promise((resolve, reject) => {
    console.log(yellow("[+] A Chrome window is opening. Log in to TikTok (the QR code is easiest), then close the window."));
    const chrome = spawn(executable, [`--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check", "https://www.tiktok.com/login"], { stdio: "ignore" });
    chrome.on("error", reject);
    chrome.on("exit", () => {
      console.log(green("[+] Browser closed. Check the login with: npm run dry-run"));
      resolve();
    });
  });
};



const CONVERSATION = '[data-e2e="dm-new-conversation-item"]';
const NICKNAME = '[data-e2e="dm-new-conversation-nickname"]';
const CHAT_ITEM = '[data-e2e="dm-new-chat-item"]';
const EDITOR = "div.notranslate.public-DraftEditor-content";

const nicknameOf = (item) =>
  item.evaluate((el, sel) => (el.closest("[data-index]") || el).querySelector(sel)?.textContent.trim() || "", NICKNAME);

const findConversation = async (frame, nickname) => {
  for (const item of await frame.$$(CONVERSATION)) {
    if ((await nicknameOf(item)) === nickname.trim()) return item;
  }
  return null;
};

// Resolves once the chat shows a NEW last message containing `message`.
const waitForNewMessage = async (frame, previousLast, message, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await frame.evaluate(
      (sel, prev, msg) => {
        const items = document.querySelectorAll(sel);
        const last = items[items.length - 1];
        return !!last && last !== prev && last.innerText.includes(msg);
      },
      CHAT_ITEM, previousLast, message.trim()
    );
    if (ok) return true;
    await sleep(500);
  }
  return false;
};

const lastChatText = (frame) =>
  frame.$$eval(CHAT_ITEM, (els) => (els.length ? els[els.length - 1].innerText.trim() : ""));



const openMessages = async (page) => {
  await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(CONFIG.pageLoadDelayMs);
  console.log(blue(`[+] URL: ${page.url()}`));
  if (/\/login/.test(page.url()))
    throw new Error("Not logged in (redirected to login). Run `npm run login`, or put fresh cookies in cookies.json");
  // Business Suite wraps the inbox in an iframe; the normal /messages page does not.
  let frame = page.mainFrame();
  const iframe = await page.$("iframe[src*='/messages?']");
  if (iframe) {
    frame = await iframe.contentFrame();
    if (!frame) throw new Error("Messages iframe found but its content frame is not accessible");
  }
  await frame.waitForSelector(CONVERSATION, { timeout: 30000 })
    .catch(() => { throw new Error("Conversation list not found on the messages page"); });
  try {
    await frame.waitForSelector("._TUXModal-wrapper", { visible: true, timeout: 3000 });
    await frame.evaluate(() => {
      const modal = document.querySelector("._TUXModal-wrapper");
      if (!modal) return;
      const rect = modal.getBoundingClientRect();
      document.elementFromPoint(Math.max(1, rect.left - 10), Math.max(1, rect.top - 10))?.click();
    });
  } catch {}
  return frame;
};



const main = async () => {
  if (isLogin) return login();

  const banner = figlet.textSync("TikTok Streak", { font: CONFIG.bannerFont, horizontalLayout: "default", verticalLayout: "default" });
  if (process.stdout.isTTY) console.clear();
  console.log(bold(cyan(banner)));
  console.log(yellow("\n[+] Made with 🚬 and ☕ by Saturia."));
  if (CONFIG.useQuotesAPi) console.log(blue("[+] Message: Random quote (dummyjson.com)"));
  else console.log(blue(`[+] Message: ${CONFIG.message}`));
  console.log(magenta(`[+] Delay: ${CONFIG.actionDelayMs} ms`));
  console.log(yellow(`[+] Mode: ${isDryRun ? "Dry run (nothing is sent)" : isDebug ? "Debug" : "Normal"}`));
  console.log(yellow(`[+] Time: ${new Date().toLocaleString()}\n`));

  const targets = Array.isArray(CONFIG.targets) && CONFIG.targets.length ? CONFIG.targets : null;
  const total = targets ? targets.length : CONFIG.totalUsers;
  const sent = [];
  const report = []; // per-account results for run.ps1 (Discord embed)
  let fatal = null;
  let success = 0,
    failed = 0,
    verified = 0;
  let browser, page;
  try {
    const cookies = loadCookies();
    browser = await puppeteer.launch(BROWSER_CONFIG);
    [page] = await browser.pages();
    // An unanswered JS dialog freezes every later evaluate() call, so dismiss any that appear.
    page.on("dialog", (d) => {
      console.log(yellow(`  [~] Dismissing ${d.type()} dialog: ${d.message()}`));
      d.dismiss().catch(() => {});
    });
    if (cookies) await page.setCookie(...cookies);
    if (isDebug) console.log(yellow("[+] Opening TikTok messages..."));
    let frame = await openMessages(page);



    for (let i = 0; i < total; i++) {
      let label = targets ? targets[i] : `#${i + 1}`;
      try {
        // Sending moves a conversation to the top, so index i still points at the next unsent one.
        const item = targets
          ? await findConversation(frame, targets[i])
          : await frame.waitForSelector(`div[data-index="${i}"] ${CONVERSATION}`, { timeout: 3000 });
        if (!item) throw new Error(`Conversation "${targets[i]}" not found in the recent conversations`);
        const username = (await nicknameOf(item)) || `user${i}`;
        label = username;
        console.log(yellow(`\n[${i + 1}/${total}] Sending to: ${username}`));
        await item.click();
        await sleep(1500);
        if (isDebug) console.log(yellow("  [~] Looking for the editor..."));
        const editor = await frame.waitForSelector(EDITOR, { timeout: 5000 });
        await editor.click();
        await sleep(CONFIG.afterClickDelayMs);
        if (isDebug) console.log(yellow("  [~] Typing..."));
        let message = CONFIG.message;
        if (CONFIG.useQuotesAPi) {
          const quote = await fetchQuote();
          if (!quote) throw new Error("Failed to fetch quote");
          message = quote;
          if (isDebug) console.log(cyan(`  [~] Quote: ${quote}`));
        }
        await page.keyboard.type(message, { delay: CONFIG.typeDelayMs });
        await sleep(CONFIG.afterSendDelayMs);
        const editorText = () => frame.$eval(EDITOR, (el) => el.innerText.trim());
        if (isDebug) console.log(yellow("  [~] Reading editor..."));
        if (isDryRun) {
          const typed = await editorText();
          await page.keyboard.down("Control");
          await page.keyboard.press("KeyA");
          await page.keyboard.up("Control");
          await page.keyboard.press("Backspace");
          if (typed !== message.trim()) throw new Error(`Typed text mismatch: "${typed}"`);
          console.log(green(`  [✓] Dry run: message typed, not sent`));
          report.push({ name: username, status: "dry" });
          success++;
          continue;
        }
        const previousLast = await frame.evaluateHandle((sel) => {
          const items = document.querySelectorAll(sel);
          return items[items.length - 1] || null;
        }, CHAT_ITEM);
        if (isDebug) console.log(blue("  [~] Sending with Enter..."));
        await page.keyboard.press("Enter");
        await sleep(1500);
        if (await editorText()) {
          if (isDebug) console.log(blue("  [~] Enter did not send, trying Ctrl+Enter..."));
          await page.keyboard.down("Control");
          await page.keyboard.press("Enter");
          await page.keyboard.up("Control");
        }
        if (!(await waitForNewMessage(frame, previousLast, message, 10000))) {
          if (await editorText()) throw new Error("Message is still in the editor: Enter did not send it");
          throw new Error("Message did not appear in the chat after sending");
        }
        console.log(green(`  [✓] Sent (shown in chat)`));
        sent.push({ username, message });
        report.push({ name: username, status: "sent" });
        success++;
      } catch (e) {
        console.log(red(`  [✗] Error: ${e.message}`));
        report.push({ name: label, status: "failed", detail: e.message });
        failed++;
      }

      if (i < total - 1) {
        if (isDebug) console.log(yellow(`  [~] Waiting ${CONFIG.actionDelayMs} ms...`));
        await sleep(CONFIG.actionDelayMs);
      }
    }



    // Second check: reload and confirm every sent message is still the last one in its chat.
    if (sent.length) {
      console.log(yellow("\n[+] Reloading to verify delivery..."));
      await sleep(3000);
      frame = await openMessages(page);
      for (const { username, message } of sent) {
        const item = await findConversation(frame, username);
        let ok = false;
        if (item) {
          await item.click();
          await sleep(2500);
          ok = (await lastChatText(frame)).includes(message.trim());
        }
        if (ok) verified++;
        const entry = report.find((r) => r.name === username && r.status === "sent");
        if (entry) Object.assign(entry, ok ? { status: "verified" } : { status: "failed", detail: "Sent, but not in the chat after reload" });
        console.log(ok ? green(`  [✓] Verified: ${username}`) : red(`  [✗] Not found after reload: ${username}`));
      }
    }



    console.log(green(`\n[+] Done!`));
    console.log(blue(`[+] Success: ${success}`));
    console.log(red(`[+] Failed: ${failed}`));
    if (!isDryRun) console.log(blue(`[+] Verified after reload: ${verified}/${sent.length}`));
    await sleep(CONFIG.finishDelayMs);
    if (success === 0) throw new Error("No messages were sent");
    if (failed > 0 || verified < sent.length) process.exitCode = 1;
  } catch (e) {
    console.error(red(`[!] Fatal error: ${e.message}`));
    fatal = e.message;
    if (page) {
      await page.screenshot({ path: path.join(__dirname, "debug.png") }).catch(() => {});
      console.error(red("[!] Screenshot saved to debug.png"));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    // One machine-readable line for run.ps1's notification
    console.log(`REPORT ${JSON.stringify({ dryRun: isDryRun, message: CONFIG.useQuotesAPi ? "(random quote)" : CONFIG.message, total, success, failed, verified, fatal, results: report })}`);
    console.log(`RESULT sent=${success} failed=${failed} verified=${verified} dryRun=${isDryRun} exit=${process.exitCode || 0}`);
  }
};



main();
