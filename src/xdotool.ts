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

// Navigate Chrome to a URL by typing it into the omnibox.
// URL is passed as a spawn argument (not a shell string) so &, %, = are literal.
// This produces isTrusted=true events — identical to manual omnibox input.
export async function xdoNavigate(url: string): Promise<void> {
  await xdo(["key", "--clearmodifiers", "ctrl+l"]);
  await sleep(200);
  await xdo(["key", "--clearmodifiers", "ctrl+a"]);
  await sleep(50);
  await xdo(["type", "--clearmodifiers", "--delay", "0", url]);
  await sleep(120);
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
