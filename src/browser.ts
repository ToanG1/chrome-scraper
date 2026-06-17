import { WebSocket } from "ws";

const CHROME = process.env.CHROME_DEBUG_URL ?? "http://localhost:9222";

let _browserSession: CDPSession | null = null;

async function getBrowserSession(): Promise<CDPSession> {
  if (_browserSession?.isConnected()) return _browserSession;
  const res = await fetch(`${CHROME}/json/version`);
  const info = (await res.json()) as { webSocketDebuggerUrl: string };
  _browserSession = await connectTab(info.webSocketDebuggerUrl);
  return _browserSession;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TabInfo {
  id: string;
  webSocketDebuggerUrl: string;
}

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface EventListener {
  method: string;
  resolve: (params: unknown) => void;
}

// ── CDP session ───────────────────────────────────────────────────────────────

export class CDPSession {
  private _ws: WebSocket;
  private _nextId = 1;
  private _pending = new Map<number, PendingCommand>();
  private _eventListeners: EventListener[] = [];

  constructor(ws: WebSocket) {
    this._ws = ws;

    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
        params?: unknown;
      };

      if (msg.id !== undefined) {
        const p = this._pending.get(msg.id);
        if (!p) return;
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result ?? {});
        return;
      }

      if (msg.method) {
        const idx = this._eventListeners.findIndex((l) => l.method === msg.method);
        if (idx !== -1) {
          const [listener] = this._eventListeners.splice(idx, 1);
          listener.resolve(msg.params);
        }
      }
    });
  }

  isConnected(): boolean {
    return this._ws.readyState === WebSocket.OPEN;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method: string, timeoutMs = 15000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method}`)),
        timeoutMs,
      );
      this._eventListeners.push({
        method,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      });
    });
  }

  close(): void {
    this._ws.close();
  }
}

// ── Tab helpers ───────────────────────────────────────────────────────────────

export async function openTab(): Promise<TabInfo> {
  const res = await fetch(`${CHROME}/json/new`, { method: "PUT" });
  if (!res.ok) throw new Error(`Cannot open tab: ${res.status}`);
  return res.json() as Promise<TabInfo>;
}

// Open a tab in an isolated browser context that routes through proxyServer.
// Each call creates a fresh context — no shared cookies/cache with the main session.
// The caller is responsible for calling disposeBrowserContext(contextId) when done.
export async function openTabWithProxy(
  proxyServer: string,
): Promise<{ tab: TabInfo; contextId: string }> {
  const browser = await getBrowserSession();

  const ctx = (await browser.send("Target.createBrowserContext", {
    proxyServer,
    proxyBypassList: "<-loopback>",
  })) as { browserContextId: string };

  const target = (await browser.send("Target.createTarget", {
    url: "about:blank",
    browserContextId: ctx.browserContextId,
  })) as { targetId: string };

  const tabs = (await fetch(`${CHROME}/json/list`).then((r) =>
    r.json(),
  )) as Array<{ id: string; webSocketDebuggerUrl: string }>;
  const tab = tabs.find((t) => t.id === target.targetId);
  if (!tab) throw new Error("Proxied tab not found after creation");

  return { tab: { id: tab.id, webSocketDebuggerUrl: tab.webSocketDebuggerUrl }, contextId: ctx.browserContextId };
}

export async function disposeBrowserContext(contextId: string): Promise<void> {
  const browser = await getBrowserSession();
  await browser.send("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => {});
}

export async function closeTab(tabId: string): Promise<void> {
  await fetch(`${CHROME}/json/close/${tabId}`).catch(() => {});
}

export async function healthCheck(): Promise<{ Browser: string }> {
  const res = await fetch(`${CHROME}/json/version`);
  if (!res.ok) throw new Error("Chrome not reachable");
  return res.json() as Promise<{ Browser: string }>;
}

export function connectTab(wsUrl: string): Promise<CDPSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 20 * 1024 * 1024 });
    ws.once("open", () => resolve(new CDPSession(ws)));
    ws.once("error", reject);
  });
}

// ── CDP input helpers ─────────────────────────────────────────────────────────

export async function mouseClick(session: CDPSession, x: number, y: number): Promise<void> {
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function getElementRect(
  session: CDPSession,
  selector: string,
): Promise<ElementRect | null> {
  const result = (await session.send("Runtime.evaluate", {
    expression: `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x:r.left,y:r.top,width:r.width,height:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2};
    })()`,
    returnByValue: true,
  })) as { result?: { value?: ElementRect | null } };
  return result?.result?.value ?? null;
}
