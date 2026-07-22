/**
 * Persistent store for pending threads.
 * Uses Redis when REDIS_URL is set, falls back to an in-memory Map.
 */

import Redis from "ioredis";

const REDIS_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const KEY_PREFIX = "bugsniffer:pending:";
const MERGED_KEY_PREFIX = "bugsniffer:merged:";

// ── Redis client (lazy init) ─────────────────────────────────────────────────

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: false });
    redis.on("error", (err) => console.error("[store] Redis error:", err));
  }
  return redis;
}

// ── In-memory fallback ───────────────────────────────────────────────────────

const memStore = new Map<string, string>();
// Bug page IDs we've already posted a "merged" congratulation for.
const mergedMemStore = new Set<string>();

// ── Public API ───────────────────────────────────────────────────────────────

export async function hasPendingThread(threadTs: string): Promise<boolean> {
  const r = getRedis();
  if (r) return (await r.exists(KEY_PREFIX + threadTs)) === 1;
  return memStore.has(threadTs);
}

export async function getPendingThread(threadTs: string): Promise<string | null> {
  const r = getRedis();
  if (r) return r.get(KEY_PREFIX + threadTs);
  return memStore.get(threadTs) ?? null;
}

export async function setPendingThread(threadTs: string, text: string): Promise<void> {
  const r = getRedis();
  if (r) {
    await r.set(KEY_PREFIX + threadTs, text, "EX", REDIS_TTL_SECONDS);
  } else {
    memStore.set(threadTs, text);
  }
}

export async function deletePendingThread(threadTs: string): Promise<void> {
  const r = getRedis();
  if (r) await r.del(KEY_PREFIX + threadTs);
  else memStore.delete(threadTs);
}

// ── Merge-notified markers ─────────────────────────────────────────────────

/** True if we've already congratulated the thread for this bug being merged. */
export async function hasNotifiedMerge(bugId: string): Promise<boolean> {
  const r = getRedis();
  if (r) return (await r.exists(MERGED_KEY_PREFIX + bugId)) === 1;
  return mergedMemStore.has(bugId);
}

/** Record that this bug's "merged" congratulation has been posted (fire once). */
export async function markNotifiedMerge(bugId: string): Promise<void> {
  const r = getRedis();
  if (r) await r.set(MERGED_KEY_PREFIX + bugId, "1", "EX", REDIS_TTL_SECONDS);
  else mergedMemStore.add(bugId);
}
