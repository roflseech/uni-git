import { APP_NAME } from "@epic-git/shared";

const WINDOW_LOGICAL = { width: 1180, height: 760 };

Neutralino.init();

Neutralino.events.on("ready", async () => {
  // Neutralino window size is in physical pixels; match the logical size from the config on HiDPI screens.
  const dpr = window.devicePixelRatio;
  if (dpr > 1.05) {
    await Neutralino.window.setSize({
      width: Math.round(WINDOW_LOGICAL.width * dpr),
      height: Math.round(WINDOW_LOGICAL.height * dpr),
    });
    await Neutralino.window.center();
  }
  render();
});

// Hide first, then exit: WebView2 teardown takes ~300 ms and would keep the window visible otherwise.
Neutralino.events.on("windowClose", async () => {
  await Neutralino.window.hide();
  await Neutralino.app.exit();
});

function render(): void {
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = `
    <div class="shell">
      <h1>${APP_NAME}</h1>
      <p>Empty shell. UI comes with stage 1, see <code>plan_work.md</code> and <code>docs/wireframes</code>.</p>
    </div>`;
}
