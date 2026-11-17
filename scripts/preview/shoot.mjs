// Opens hopkins in the preview daemon's web UI and saves a screenshot (and the page's text).
//
//   node scripts/preview/shoot.mjs <name> <width> <height> <today|review|open|thread> <light|dark>
//
// PLAYWRIGHT_CORE: a directory whose node_modules has playwright-core (default: this repo).
// CHROME: a Chrome/Chromium binary (default: google-chrome on PATH).
// CLIP="x,y,w,h": save only that region.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const dir = process.env.HOPKINS_PREVIEW_DIR ?? path.join(repo, ".dev/preview");
const port = process.env.HOPKINS_PREVIEW_PORT ?? "7792";
const require = createRequire(path.join(process.env.PLAYWRIGHT_CORE ?? repo, "package.json"));
const { chromium } = require("playwright-core");

const [name, w, h, mode = "today", scheme = "light"] = process.argv.slice(2);
const width = Number(w);
const height = Number(h);
const out = path.join(dir, "shots");
fs.mkdirSync(out, { recursive: true });
const password = fs.readFileSync(path.join(dir, "password"), "utf8").trim();

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "google-chrome", headless: true });
const phone = width < 600;
const page = await (await browser.newContext({ viewport: { width, height }, colorScheme: scheme === "dark" ? "dark" : "light", deviceScaleFactor: 2, hasTouch: phone, isMobile: phone })).newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[Plugins]") && !t.includes("Password required")) problems.push(t.slice(0, 200));
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle", timeout: 60_000 });
await page.getByText("Direct connection", { exact: true }).click();
await page.waitForTimeout(800);
const inputs = page.locator("input");
await inputs.nth(0).fill("127.0.0.1");
await inputs.nth(1).fill(port);
await page.locator('input[type="password"]').fill(password);
await page.keyboard.press("Enter");
await page.waitForTimeout(7000);

const visible = async (locator) => {
  for (let i = 0; i < (await locator.count()); i++) if (await locator.nth(i).isVisible()) return locator.nth(i);
  return null;
};
const openSidebar = async () => {
  if (phone) {
    await page.mouse.click(34, 35); // the menu button, top left
    await page.waitForTimeout(1200);
  }
};

if (mode === "thread") {
  // The hopkins conversation: the workspace row under the "hopkins" project (named "hopkins",
  // or "main" in a preview made before workspaces were named).
  if (!(await visible(page.getByText("hopkins", { exact: true })))) await openSidebar();
  const rows = page.getByText("hopkins", { exact: true });
  const target = (await visible(page.getByText("main", { exact: true }))) ?? ((await rows.count()) > 2 ? rows.nth((await rows.count()) - 1) : null);
  if (target) await target.click();
  else problems.push("could not find the hopkins conversation in the sidebar");
  await page.waitForTimeout(5000);
} else {
  let entry = await visible(page.getByText("hopkins", { exact: true }));
  if (!entry) {
    await openSidebar();
    entry = await visible(page.getByText("hopkins", { exact: true }));
  }
  if (entry) await entry.click();
  else problems.push("could not find hopkins in the sidebar");
  await page.waitForTimeout(3500);
  if (mode === "review") {
    await page.getByText("Review", { exact: true }).first().click();
    await page.waitForTimeout(1500);
  }
  if (mode === "open") {
    for (const label of (process.env.OPEN ?? "").split("|").filter(Boolean)) {
      const target = await visible(label.includes(" ") && /^[A-Z]/.test(label) ? page.getByText(new RegExp(`^${label}\\b`)) : page.getByText(label, { exact: true }));
      if (target) {
        await target.click();
        await page.waitForTimeout(500);
      } else problems.push(`not visible: ${label}`);
    }
    await page.waitForTimeout(800);
  }
}

const clip = process.env.CLIP ? (([x, y, cw, ch]) => ({ x, y, width: cw, height: ch }))(process.env.CLIP.split(",").map(Number)) : undefined;
await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: !clip, ...(clip ? { clip } : {}) });
fs.writeFileSync(path.join(out, `${name}.txt`), await page.evaluate(() => document.body.innerText));
console.log(`${name}: ${path.join(out, `${name}.png`)}${problems.length ? `\n  ${problems.slice(0, 6).join("\n  ")}` : ""}`);
await browser.close();
