import { spawn } from "child_process";

const ENV = { ...process.env, DISPLAY: ":99" };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

function xdo(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("xdotool", args, { env: ENV });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`xdotool ${args[0]} failed (${code}): ${stderr.trim()}`))
    );
  });
}

// xdotool type chokes on multi-byte UTF-8 (Japanese, CJK, etc.).
// For those strings: write to clipboard via xsel (exits immediately after write),
// then paste with ctrl+v — same end result, no encoding errors.
function hasMultiByte(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return true;
  }
  return false;
}

function xselSet(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("xsel", ["--clipboard", "--input"], { env: ENV });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`xsel failed (${code}): ${stderr.trim()}`))
    );
    proc.stdin?.write(text, "utf8");
    proc.stdin?.end();
  });
}

async function xdoType(text: string, delay = 40): Promise<void> {
  if (!hasMultiByte(text)) {
    await xdo(["type", "--clearmodifiers", "--delay", String(delay), text]);
  } else {
    await xselSet(text);
    await sleep(80);
    await xdo(["key", "--clearmodifiers", "ctrl+v"]);
  }
}

// Navigate Chrome to a URL by typing it into the omnibox.
export async function xdoNavigate(url: string): Promise<void> {
  await xdo(["key", "--clearmodifiers", "ctrl+l"]);
  await sleep(200);
  await xdo(["key", "--clearmodifiers", "ctrl+a"]);
  await sleep(50);
  await xdoType(url, 0);
  await sleep(120);
  await xdo(["key", "Return"]);
}

// Type a plain search keyword in the omnibox (not a URL).
export async function xdoOmniboxSearch(query: string): Promise<void> {
  await xdo(["key", "--clearmodifiers", "ctrl+l"]);
  await sleep(200);
  await xdo(["key", "--clearmodifiers", "ctrl+a"]);
  await sleep(50);
  await xdoType(query, 40);
  await sleep(rand(200, 400));
  await xdo(["key", "Return"]);
}

export async function xdoScroll(): Promise<void> {
  const steps = rand(3, 6);
  for (let i = 0; i < steps; i++) {
    await xdo(["mousemove", String(rand(300, 800)), String(rand(200, 500))]);
    await sleep(rand(100, 200));
    for (let j = 0; j < rand(2, 4); j++) {
      await xdo(["click", "5"]);
      await sleep(rand(80, 200));
    }
    await sleep(rand(300, 600));
  }
}

export async function xdoClick(x: number, y: number): Promise<void> {
  await xdo(["mousemove", "--sync", String(x), String(y)]);
  await sleep(rand(50, 120));
  await xdo(["click", "1"]);
}

// Select all existing text and replace — for reusing the search box.
export async function xdoReplaceText(text: string): Promise<void> {
  await xdo(["key", "--clearmodifiers", "ctrl+a"]);
  await sleep(50);
  await xdoType(text, 40);
}

export async function xdoKey(key: string): Promise<void> {
  await xdo(["key", "--clearmodifiers", key]);
}
