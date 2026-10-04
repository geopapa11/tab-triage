// Capture the README's dashboard pictures from the demo harness (see harness.py for how to start
// it): the whole dashboard, plus close-ups of the header and of the view switcher, light and dark.
//
//   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
//   "$CHROME" --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/tt-profile about:blank &
//   node scripts/demo/capture_dashboard.mjs docs/images
//
// Then stop that Chrome.
import fs from "node:fs";
const PORT = 9333, outDir = process.argv[2] || "docs/images";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 40 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

// name -> expression returning the {x, y, width, height} to capture (null = the whole window)
const SHOTS = {
  dashboard: null,
  header: `(() => { const r = document.querySelector(".masthead").getBoundingClientRect(); return { x: r.left - 14, y: r.top - 14, width: r.width + 28, height: r.height + 28 }; })()`,
  views: `(() => { const b = [...document.querySelectorAll("#views button")].map((e) => e.getBoundingClientRect()); const l = b[0].left, r = b.at(-1).right; return { x: l - 14, y: b[0].top - 14, width: r - l + 28, height: b[0].height + 28 }; })()`,
};

for (const scheme of ["light", "dark"]) {
  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result?.result?.value;
  await send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 1140, deviceScaleFactor: 2, mobile: false }, sessionId);
  await send("Page.navigate", { url: `http://127.0.0.1:8791/dashboard/index.html?${scheme}=1` }, sessionId);
  for (let i = 0; i < 40 && !(await ev(`!!document.querySelector(".theme") && !!document.querySelector(".gauge")`)); i++) await sleep(250);
  await sleep(700); // favicons and meter transitions
  for (const [name, rect] of Object.entries(SHOTS)) {
    const clip = rect ? { ...(await ev(rect)), scale: 1 } : undefined;
    const shot = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) }, sessionId);
    const out = `${outDir}/${name}-${scheme}.png`;
    fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    console.log("saved", out, fs.statSync(out).size, "bytes");
  }
  await send("Target.closeTarget", { targetId });
}
ws.close(); process.exit(0);
