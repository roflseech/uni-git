/**
 * epic-git backend — Node process next to the Neutralino shell.
 *
 * Stage 1 will put here: local HTTP/WS server on 127.0.0.1 with a random port + token,
 * the per-repository job queue, git CLI wrapper, fs watchers, askpass bridge.
 * See plan_work.md, section 2.
 */
import { APP_NAME } from "@epic-git/shared";

function main(): void {
  console.log(`${APP_NAME} backend: skeleton, nothing to serve yet (pid ${process.pid})`);
}

main();
