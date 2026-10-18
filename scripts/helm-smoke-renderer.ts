// Renderer half of the Helm launch check (scripts/helm-smoke-mac.sh).
//
// The launched app keeps its process and its backend up even when React has
// crashed into the "Something went wrong." screen, so the process check alone
// passes a broken build. This attaches to the window over the DevTools
// protocol and walks the screens an update lands on:
//
//   1. whatever route the profile restores (an update restarts into it);
//   2. a new thread draft (mod+N);
//   3. the first thread in the sidebar;
//   4. settings.
//
// A screen fails when it shows the root error view, or when React reports an
// error (render loops, hook order and the like) while it is open.
//
//   node scripts/helm-smoke-renderer.ts <devtools port>

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: helm-smoke-renderer.ts <devtools port>");
  process.exit(2);
}

const TARGET_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 60_000;
const SETTLE_MS = 4_000;
const CRASH_MARKER = "Error report";
const REACT_ERROR =
  /Minified React error|Too many re-renders|Maximum update depth|Rendered (more|fewer) hooks/;

type CdpMessage = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function findWindowTarget(): Promise<string> {
  const deadline = Date.now() + TARGET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as Array<{
        type: string;
        url: string;
        webSocketDebuggerUrl?: string;
      }>;
      // The main window loads the app bundle; preview tabs are other pages.
      const main = targets.find(
        (target) =>
          target.type === "page" && target.url.startsWith("helm://") && target.webSocketDebuggerUrl,
      );
      if (main?.webSocketDebuggerUrl) return main.webSocketDebuggerUrl;
    } catch {
      // DevTools endpoint not up yet.
    }
    await sleep(500);
  }
  throw new Error(`no app window on DevTools port ${port} after ${TARGET_TIMEOUT_MS / 1000}s`);
}

class Cdp {
  private nextId = 1;
  private pending = new Map<number, (message: CdpMessage) => void>();
  readonly reactErrors: string[] = [];
  readonly otherErrors: string[] = [];

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
        return;
      }
      this.onEvent(message);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), {
        once: true,
      });
    });
    return new Cdp(socket);
  }

  private onEvent(message: CdpMessage) {
    let text: string | null = null;
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      text = details.exception?.description ?? details.text;
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      text = message.params.args.map((arg: any) => arg.description ?? arg.value ?? "").join(" ");
    }
    if (text === null) return;
    (REACT_ERROR.test(text) ? this.reactErrors : this.otherErrors).push(text);
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) =>
        message.error
          ? reject(new Error(`${method}: ${message.error.message}`))
          : resolve(message.result),
      );
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${expression}`);
    return result.result.value as T;
  }

  close() {
    this.socket.close();
  }
}

type Screen = { route: string; crashReport: string | null };

async function readScreen(cdp: Cdp): Promise<Screen> {
  return cdp.evaluate<Screen>(`(() => {
    const text = document.body?.innerText ?? "";
    const pre = [...document.querySelectorAll("pre")].map((node) => node.innerText).join("\\n");
    return {
      route: location.hash.replace(/^#/, "") || "/",
      crashReport: text.includes(${JSON.stringify(CRASH_MARKER)}) ? pre || text : null,
    };
  })()`);
}

// The app has rendered once the splash is gone and something interactive is on screen.
async function waitForRender(cdp: Cdp) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate<boolean>(
      `document.readyState === "complete" && document.querySelectorAll("button, a[href]").length > 0`,
    );
    if (ready) return;
    await sleep(500);
  }
  throw new Error(`the window rendered nothing interactive in ${RENDER_TIMEOUT_MS / 1000}s`);
}

const failures: string[] = [];

async function check(cdp: Cdp, name: string, open: () => Promise<void>) {
  const reactBefore = cdp.reactErrors.length;
  await open();
  await sleep(SETTLE_MS);
  const screen = await readScreen(cdp);
  const reactErrors = cdp.reactErrors.slice(reactBefore);
  if (screen.crashReport !== null) {
    failures.push(`${name} (${screen.route}): crash screen\n${screen.crashReport}`);
    console.log(`helm-smoke-renderer: ${name}: CRASH at ${screen.route}`);
  } else if (reactErrors.length > 0) {
    failures.push(`${name} (${screen.route}): React error\n${reactErrors.join("\n")}`);
    console.log(`helm-smoke-renderer: ${name}: React error at ${screen.route}`);
  } else {
    console.log(`helm-smoke-renderer: ${name}: ok (${screen.route})`);
  }
}

async function goTo(cdp: Cdp, route: string) {
  await cdp.evaluate(`void (location.hash = ${JSON.stringify(`#${route}`)})`);
}

async function pressNewThread(cdp: Cdp) {
  const key = { key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 4 /* meta */ };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

async function main() {
  const cdp = await Cdp.connect(await findWindowTarget());
  try {
    await cdp.send("Runtime.enable");
    await waitForRender(cdp);

    await check(cdp, "restored route", async () => {});

    await check(cdp, "home", () => goTo(cdp, "/"));

    await check(cdp, "new thread draft", async () => {
      await cdp.evaluate(`document.body.focus()`);
      await pressNewThread(cdp);
      await sleep(1_500);
      // mod+N with several projects opens a project picker; take its first project.
      await cdp.evaluate(`document.querySelector('[role="option"]')?.click()`);
    });

    // Sidebar rows are buttons, not links: open the first thread by clicking it.
    const hasThread = await cdp.evaluate<boolean>(
      `document.querySelector('[data-thread-item] [data-testid="sidebar-row-card"]') !== null`,
    );
    if (hasThread) {
      await check(cdp, "thread", () =>
        cdp.evaluate(
          `document.querySelector('[data-thread-item] [data-testid="sidebar-row-card"]').click()`,
        ),
      );
    } else {
      console.log("helm-smoke-renderer: thread: skipped, no thread in the sidebar");
    }

    await check(cdp, "settings", () => goTo(cdp, "/settings/general"));
  } finally {
    cdp.close();
  }

  if (cdp.otherErrors.length > 0) {
    console.log(
      `helm-smoke-renderer: ${cdp.otherErrors.length} other console error(s), not failing:`,
    );
    for (const error of cdp.otherErrors.slice(0, 5)) console.log(`  ${error.split("\n")[0]}`);
  }
  if (failures.length > 0) {
    console.error(`\nhelm-smoke-renderer: ${failures.length} screen(s) failed:\n`);
    for (const failure of failures) console.error(`${failure}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`helm-smoke-renderer: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
