/**
 * Entry point. The window is shown by the shell before any data arrives; the App renders its skeleton
 * immediately and fills it in once the backend answers.
 */
import { App } from "./app.js";
import { hasShell } from "./session.js";
import { logUncaughtErrors, uiLog } from "./uilog.js";

logUncaughtErrors();

// Apply the last known theme before the first paint; the backend's setting confirms or corrects it later.
try {
  const t = localStorage.getItem("uni-git.theme");
  if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
} catch {
  /* storage unavailable */
}

const WINDOW_LOGICAL = { width: 1180, height: 760 };

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");
const app = new App(root);

if (hasShell()) {
  Neutralino.init();

  Neutralino.events.on("ready", async () => {
    // Neutralino window size is in physical pixels; match the logical size from the config on HiDPI screens.
    const dpr = window.devicePixelRatio;
    if (dpr > 1.05 && !sessionStorage.getItem("uni-git.sized")) {
      sessionStorage.setItem("uni-git.sized", "1");
      await Neutralino.window.setSize({
        width: Math.round(WINDOW_LOGICAL.width * dpr),
        height: Math.round(WINDOW_LOGICAL.height * dpr),
      });
      await Neutralino.window.center();
    }
    void app.start();
  });

  // The client library never reconnects: from here on the close button cannot reach this page, and native calls
  // wait forever. The backend sees the close on its own link to the shell and closes the window instead.
  Neutralino.events.on("serverOffline", () => uiLog("the page lost its connection to the Neutralino shell (serverOffline)"));

  // Hide first, then exit: WebView2 teardown takes ~300 ms and would keep the window visible otherwise.
  // A failed or hanging hide must not keep the window open.
  Neutralino.events.on("windowClose", async () => {
    app.api?.shutdown();
    await Promise.race([Neutralino.window.hide().catch(() => {}), new Promise((r) => window.setTimeout(r, 300))]);
    await Neutralino.app.exit();
  });
} else {
  // Plain browser (debugging): ?port=..&token=.. from data/session.json
  void app.start();
}
