import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
    RateLimitPeriod,
    StatusJSON
} from '../types/StatusJSON';

import { withCacheLock } from './cache-lock';
import { getUsageFilePath } from './usage-fetch';
import { WEEKLY_MODEL_USAGE_BUCKETS } from './usage-types';

// Claude Code sends each session its own rate_limits, as of that session's
// last API response. Every session in a config directory runs under the same
// login, so the newest of them is the best stand-in for the usage API while it
// can't be reached (a 429 can hold it off for an hour). Each render keeps that
// newest snapshot here, per config directory, under the usage cache's name.

const SCHEMA_VERSION = 1 as const;
// One window's reset time differs by under a second between payloads
const SAME_WINDOW_MS = 60 * 1000;
// An unchanged percent moves its observation time at most this often, so busy
// sessions don't rewrite the file on every response
const OBSERVED_AT_WRITE_INTERVAL_MS = 60 * 1000;

const SHARED_WINDOW_KEYS: readonly string[] = [
    'five_hour',
    'seven_day',
    ...WEEKLY_MODEL_USAGE_BUCKETS.flatMap(bucket => bucket.apiBucketKey ? [bucket.apiBucketKey] : [])
];

export interface SharedRateLimitWindow {
    used_percentage: number;
    // Unix epoch seconds, as in the payload
    resets_at: number;
    // When the session that reported it got the API response it came with, in
    // ms; 0 when its transcript doesn't show that
    observedAtMs: number;
}

export type SharedRateLimits = Record<string, SharedRateLimitWindow>;

export interface SharedRateLimitsDeps {
    readFileSync: (path: string) => string;
    writeFileSync: (path: string, data: string) => void;
    renameSync: (from: string, to: string) => void;
    unlinkSync: (path: string) => void;
    mkdirSync: (path: string) => void;
    now: () => number;
    cachePath: string;
}

// Built per call: the path follows CLAUDE_CONFIG_DIR at render time
export function getDefaultSharedRateLimitsDeps(): SharedRateLimitsDeps {
    return {
        readFileSync: (p: string) => fs.readFileSync(p, 'utf-8'),
        writeFileSync: (p: string, data: string) => { fs.writeFileSync(p, data, 'utf-8'); },
        renameSync: (from: string, to: string) => { fs.renameSync(from, to); },
        unlinkSync: (p: string) => { fs.unlinkSync(p); },
        mkdirSync: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
        now: () => Date.now(),
        cachePath: getUsageFilePath('rate-limits.json')
    };
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

interface RateLimitReading {
    used_percentage: number;
    resets_at: number;
}

// A window counts only with both a percent and a reset time that hasn't
// passed: without the reset there is no telling which window the percent is from.
function toCurrentReading(usedPercentage: unknown, resetsAt: unknown, nowMs: number): RateLimitReading | null {
    return isFiniteNumber(usedPercentage) && isFiniteNumber(resetsAt) && resetsAt * 1000 > nowMs
        ? { used_percentage: usedPercentage, resets_at: resetsAt }
        : null;
}

function readWindows(deps: SharedRateLimitsDeps, nowMs: number): SharedRateLimits {
    const windows: SharedRateLimits = {};
    try {
        const parsed = JSON.parse(deps.readFileSync(deps.cachePath)) as unknown;
        if (typeof parsed !== 'object' || parsed === null) {
            return windows;
        }

        const file = parsed as { version?: unknown; windows?: unknown };
        if (file.version !== SCHEMA_VERSION || typeof file.windows !== 'object' || file.windows === null) {
            return windows;
        }

        const stored = file.windows as Record<string, unknown>;
        for (const key of SHARED_WINDOW_KEYS) {
            const entry = stored[key] as Partial<SharedRateLimitWindow> | null | undefined;
            const reading = entry ? toCurrentReading(entry.used_percentage, entry.resets_at, nowMs) : null;
            if (entry && reading) {
                windows[key] = { ...reading, observedAtMs: isFiniteNumber(entry.observedAtMs) ? entry.observedAtMs : 0 };
            }
        }
    } catch {
        // A missing or corrupt file holds no windows
    }

    return windows;
}

/**
 * The newest rate_limits windows any session in this config directory has
 * reported, leaving out windows that have since reset. Null when there are none.
 */
export function readSharedRateLimits(deps: SharedRateLimitsDeps = getDefaultSharedRateLimitsDeps()): SharedRateLimits | null {
    const windows = readWindows(deps, deps.now());
    return Object.keys(windows).length > 0 ? windows : null;
}

// Whether the incoming reading is newer than the stored one. Within one
// window usage only goes up, so a higher percent is newer whenever it was
// seen. A different window that hasn't reset either is another login's (after
// /login): only a reading known to be newer replaces it.
function mergeWindow(
    stored: SharedRateLimitWindow | undefined,
    incoming: RateLimitReading,
    getObservedAtMs: () => number
): SharedRateLimitWindow | null {
    if (!stored) {
        return { ...incoming, observedAtMs: getObservedAtMs() };
    }

    const isSameWindow = Math.abs(stored.resets_at - incoming.resets_at) * 1000 <= SAME_WINDOW_MS;
    if (isSameWindow) {
        if (incoming.used_percentage > stored.used_percentage) {
            return { ...incoming, observedAtMs: Math.max(stored.observedAtMs, getObservedAtMs()) };
        }

        const observedAtMs = incoming.used_percentage === stored.used_percentage ? getObservedAtMs() : 0;
        return observedAtMs - stored.observedAtMs >= OBSERVED_AT_WRITE_INTERVAL_MS
            ? { ...stored, observedAtMs }
            : null;
    }

    const observedAtMs = getObservedAtMs();
    return observedAtMs > stored.observedAtMs ? { ...incoming, observedAtMs } : null;
}

function mergeWindows(
    stored: SharedRateLimits,
    rateLimits: NonNullable<StatusJSON['rate_limits']>,
    getObservedAtMs: () => number,
    nowMs: number
): SharedRateLimits | null {
    const buckets = rateLimits as unknown as Record<string, RateLimitPeriod | null | undefined>;
    const merged: SharedRateLimits = { ...stored };
    let changed = false;

    for (const key of SHARED_WINDOW_KEYS) {
        const bucket = buckets[key];
        const reading = bucket ? toCurrentReading(bucket.used_percentage, bucket.resets_at, nowMs) : null;
        if (!reading) {
            continue;
        }

        const window = mergeWindow(stored[key], reading, getObservedAtMs);
        if (window) {
            merged[key] = window;
            changed = true;
        }
    }

    return changed ? merged : null;
}

/**
 * Keeps this payload's rate_limits windows where they are newer than the
 * stored ones. observedAtMs says when the session got the API response they
 * came with (its transcript's last response), and is only asked for when a
 * window is about to be written. Best-effort: it never throws, and a write
 * that loses the lock to another render is skipped, since the next render
 * reports the same windows again.
 */
export function recordSharedRateLimits(
    rateLimits: StatusJSON['rate_limits'],
    observedAtMs: () => number | undefined,
    deps: SharedRateLimitsDeps = getDefaultSharedRateLimitsDeps()
): void {
    if (!rateLimits) {
        return;
    }

    try {
        let cachedObservedAtMs: number | undefined;
        const getObservedAtMs = (): number => {
            if (cachedObservedAtMs === undefined) {
                const value = observedAtMs();
                cachedObservedAtMs = isFiniteNumber(value) ? value : 0;
            }
            return cachedObservedAtMs;
        };

        const nowMs = deps.now();
        // Most renders change nothing, so look before taking the lock
        if (!mergeWindows(readWindows(deps, nowMs), rateLimits, getObservedAtMs, nowMs)) {
            return;
        }

        deps.mkdirSync(path.dirname(deps.cachePath));
        withCacheLock(deps.cachePath, () => {
            // Another render may have written newer windows since the look above
            const merged = mergeWindows(readWindows(deps, nowMs), rateLimits, getObservedAtMs, nowMs);
            if (!merged) {
                return;
            }

            // Stable temp name, as in terminal-width-cache.ts: writers use it
            // under the lock, and a name per process would leave an orphan per
            // failed rename. Malformed JSON from an unlocked writer reads as no windows.
            const tempPath = `${deps.cachePath}.tmp`;
            try {
                deps.writeFileSync(tempPath, JSON.stringify({ version: SCHEMA_VERSION, windows: merged }));
                deps.renameSync(tempPath, deps.cachePath);
            } catch {
                try {
                    deps.unlinkSync(tempPath);
                } catch {
                    // Never written, or still held; nothing more to do
                }
            }
        });
    } catch {
        // Best-effort cache; the status line must render regardless
    }
}
