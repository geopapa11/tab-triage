// Capture chrome://extensions for the README's install step, from a temporary Chrome with an
// empty profile (so no personal extensions appear), with Developer mode switched on and the two
// controls a new user needs ringed and numbered.
//
//   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
//   "$CHROME" --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/tt-profile about:blank &
//   node scripts/demo/capture_extensions_page.mjs docs/images/install-extensions-light.png light
//   node scripts/demo/capture_extensions_page.mjs docs/images/install-extensions-dark.png dark
//
// Then stop that Chrome. The toolbar's puzzle-piece menu cannot be captured this way: it is
// part of the browser window, not of a page.
import fs from "node:fs";
const PORT = 9333, out = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 40 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const created = await send("Target.createTarget", { url: "about:blank" });
if (!created.result) { console.log("createTarget:", JSON.stringify(created.error)); process.exit(1); }
const targetId = created.result.targetId;
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
const nav = await send("Page.navigate", { url: "chrome://extensions" }, sessionId);
if (nav.error || nav.result?.errorText) console.log("navigate:", JSON.stringify(nav.error ?? nav.result.errorText));
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 400, deviceScaleFactor: 2, mobile: false }, sessionId);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: process.argv[3] || "light" }] }, sessionId);
await sleep(1500);
console.log("dev mode toggled:", await ev(`(() => { const t = document.querySelector("extensions-manager")?.shadowRoot?.querySelector("extensions-toolbar")?.shadowRoot; const d = t?.querySelector("#devMode"); if (!d) return "toggle not found"; if (!d.checked) d.click(); return d.checked ? "on" : "clicked"; })()`));
await sleep(900);
console.log("marked:", await ev(`(() => {
  const tb = document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-toolbar").shadowRoot;
  // [selector, badge number, extra px to the left so the ring also wraps the control's label]
  const targets = [["#devMode", "1", 128], ["#loadUnpacked", "2", 0]];
  const done = [];
  for (const [sel, n, extraLeft] of targets) {
    const el = tb.querySelector(sel); if (!el) { done.push(sel + " missing"); continue; }
    const r = el.getBoundingClientRect();
    const pad = 6, left = r.left - pad - extraLeft, top = r.top - pad;
    const ring = document.createElement("div");
    ring.style.cssText = "position:fixed;z-index:99999;border:3px solid #c2410c;border-radius:10px;pointer-events:none;box-sizing:border-box;left:" + left + "px;top:" + top + "px;width:" + (r.width + 2 * pad + extraLeft) + "px;height:" + (r.height + 2 * pad) + "px";
    const badge = document.createElement("div");
    badge.textContent = n;
    badge.style.cssText = "position:fixed;z-index:99999;background:#c2410c;color:#fff;font:700 14px -apple-system,system-ui,sans-serif;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;border:2px solid #fff;left:" + (left - 13) + "px;top:" + (top - 13) + "px";
    document.body.append(ring, badge); done.push(sel + " ok");
  }
  return done.join(", ");
})()`));
await sleep(300);
const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("saved", out, fs.statSync(out).size, "bytes");
await send("Target.closeTarget", { targetId });
ws.close(); process.exit(0);
