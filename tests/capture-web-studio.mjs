// Opt-in Chrome verification, using Node built-ins and a disposable profile only.
// Requires serve_web_studio_fixture.py; never navigate to the real manager.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const [fixtureUrl, outputDirectory, ...onlyCaptures] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(fixtureUrl || "") || !outputDirectory) throw new Error("Provide the synthetic fixture's loopback URL and screenshot directory.");
const profile = await mkdtemp(path.join(tmpdir(), "studio-chrome-ui-"));
const browser = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) { try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch { await pause(100); } }
  if (!port) throw new Error("Chrome did not expose its isolated test debugger.");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0; const pending = new Map(), requests = new Set();
  socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); if (message.error) callback?.reject(new Error(message.error.message)); else callback?.resolve(message.result); } else if (message.method === "Network.requestWillBeSent") requests.add(message.params.request.url); else if (message.method === "Page.javascriptDialogOpening") { void send("Page.handleJavaScriptDialog", { accept: true }); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  await send("Page.enable"); await send("Network.enable");
  const version = await send("Browser.getVersion");
  const results = [];
  for (const [name, width, height, view, scenario] of [["home-desktop", 1650, 900, "home"], ["home-mobile", 390, 900, "home"], ["extensions-desktop", 1650, 900, "extensions"], ["extensions-mobile", 390, 900, "extensions"], ["candidates-desktop", 1650, 900, "candidates"], ["candidates-mobile", 390, 900, "candidates"], ["profile-career", 1650, 900, "candidates", "career"], ["profile-calendar", 1650, 900, "candidates", "calendar"], ["studio-desktop", 1650, 900, "resume"], ["studio-responsive", 800, 1000, "resume"], ["studio-mobile", 390, 900, "resume"], ["studio-multipage", 1650, 900, "resume", "long"], ["template-library", 1650, 900, "documents"]]) {
    if (onlyCaptures.length && !onlyCaptures.includes(name)) continue;
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const target = new URL(fixtureUrl); target.searchParams.set("view", view); if (scenario) target.searchParams.set("scenario", scenario);
    await send("Page.navigate", { url: target.href });
    let report;
    for (let attempt = 0; attempt < 200; attempt++) { const raw = await evaluate("document.getElementById('fixture-report')?.textContent"); if (raw) { report = JSON.parse(raw); break; } await pause(100); }
    if (!report?.ready) throw new Error(JSON.stringify(report || { error: "Fixture timed out" }));
    await pause(2500); // Real time for Chrome's PDF viewer/compositor, not virtual time.
    if (scenario === "calendar") {
      const point = await evaluate("(() => { const r = document.getElementById('profile-personal-birthday-calendar').getBoundingClientRect(); return {x:r.x + r.width/2,y:r.y + r.height/2}; })()");
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
      await pause(400);
      report.calendarOpen = await evaluate("document.getElementById('profile-personal-birthday-calendar').matches(':open')");
      if (!report.calendarOpen) throw new Error("The birthdate calendar did not open after a user click.");
    }
    const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(path.join(outputDirectory, name + ".png"), Buffer.from(screenshot.data, "base64"));
    results.push({ name, ...report });
  }
  const remoteRequests = [...requests].filter(url => /^https?:/.test(url) && !url.startsWith(fixtureUrl));
  const result = { browser: version.product, results, remoteRequests };
  await writeFile(path.join(outputDirectory, "studio-browser-results.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  await send("Browser.close");
} finally {
  socket?.close(); browser.kill();
  // Disposable profile is in the OS temp directory; no user browser profile is read.
}
