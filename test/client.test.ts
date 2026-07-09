// Cache behavior of the real client's `get`. The client is otherwise verified live, but the 24 h
// catalog memoization is pure logic, so it's unit-tested here with an injected fetch
// (call-counting) and an injected clock. No network.

import { test, expect } from "bun:test";
import { makeVanguardGet } from "../src/client.js";
import { LIST_URL, componentUrl } from "../src/vanguard.js";

/** A fake fetch that counts calls and returns a canned JSON body. */
function countingFetch(body: unknown = { ok: 1 }) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const HOLDINGS_URL = componentUrl("VOO", "portfolio-holding/stock");

test("catalog is fetched once then served from cache within the TTL", async () => {
  const { impl, calls } = countingFetch();
  let clock = 1_000_000;
  const get = makeVanguardGet(impl, { now: () => clock });
  await get(LIST_URL);
  await get(LIST_URL);
  clock += 60 * 60 * 1000; // +1 h, still within the 24 h TTL
  await get(LIST_URL);
  expect(calls.length).toBe(1);
});

test("catalog is refetched after the TTL expires", async () => {
  const { impl, calls } = countingFetch();
  let clock = 0;
  const get = makeVanguardGet(impl, { now: () => clock });
  await get(LIST_URL);
  clock += 24 * 60 * 60 * 1000 + 1; // just past 24 h
  await get(LIST_URL);
  expect(calls.length).toBe(2);
});

test("non-catalog URLs are never cached", async () => {
  const { impl, calls } = countingFetch();
  const get = makeVanguardGet(impl);
  await get(HOLDINGS_URL);
  await get(HOLDINGS_URL);
  expect(calls.length).toBe(2);
});

test("concurrent first catalog requests coalesce into a single fetch", async () => {
  const { impl, calls } = countingFetch();
  const get = makeVanguardGet(impl);
  await Promise.all([get(LIST_URL), get(LIST_URL), get(LIST_URL)]);
  expect(calls.length).toBe(1);
});

test("catalogCacheMs: 0 disables caching", async () => {
  const { impl, calls } = countingFetch();
  const get = makeVanguardGet(impl, { catalogCacheMs: 0 });
  await get(LIST_URL);
  await get(LIST_URL);
  expect(calls.length).toBe(2);
});

test("a failed catalog fetch is evicted so the next call retries", async () => {
  const calls: string[] = [];
  let failNext = true;
  const impl = (async (url: string) => {
    calls.push(url);
    if (failNext) {
      failNext = false;
      return { ok: false, status: 503, json: async () => ({}), text: async () => "down" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: 1 }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const get = makeVanguardGet(impl);
  await expect(get(LIST_URL)).rejects.toThrow(/HTTP 503/);
  const ok = await get(LIST_URL); // cache was evicted → retries and succeeds
  expect(ok).toEqual({ ok: 1 });
  expect(calls.length).toBe(2);
});
