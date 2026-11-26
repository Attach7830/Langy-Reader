import { setTimeout as delay } from 'node:timers/promises';

// Cover lookups and recommendations share one lane for this server's public IP.
let lane = Promise.resolve(), nextRequest = 0;
export function waitForOpenLibrary(signal, interval = 1100) {
  const pending = lane.then(async () => {
    signal?.throwIfAborted();
    if (interval > 0) await delay(Math.max(0, nextRequest - Date.now()), undefined, { signal });
    signal?.throwIfAborted();
    nextRequest = Date.now() + interval;
  });
  lane = pending.catch(() => {});
  return pending;
}
