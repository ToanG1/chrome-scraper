/**
 * Idle browser activity — builds Google cookie trust between real requests.
 *
 * While the server is idle, Chrome behaves like a real user: searches random
 * Japanese keywords, clicks organic results, visits normal sites, scrolls.
 * This grows the NID cookie weight so Docker Chrome looks less like a fresh bot.
 *
 * Coordination: real requests set _lastRealRequest timestamp; idleBrowse() skips
 * if a request ran within the last IDLE_COOLDOWN ms, so there is no collision.
 */

import { idleBrowse } from "./scraper";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rand  = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const INTERVAL = { min: 3 * 60_000, max: 8 * 60_000 };  // 3–8 min, constant 24/7

let _running = false;

export function startIdleBrowsing(): void {
  if (_running) return;
  _running = true;
  console.log("[idle] warm-up loop started");
  loop().catch((e) => console.error("[idle] loop crashed:", (e as Error).message));
}

export function stopIdleBrowsing(): void {
  _running = false;
}

async function loop(): Promise<void> {
  // Initial cold-start delay — don't fire immediately on container launch
  await sleep(rand(90_000, 180_000));

  while (_running) {
    try {
      await idleBrowse();
    } catch (e) {
      console.warn("[idle] browse error (skipping):", (e as Error).message);
    }

    const wait = rand(INTERVAL.min, INTERVAL.max);
    console.log(`[idle] next session in ${Math.round(wait / 60_000)}m`);
    await sleep(wait);
  }
}
