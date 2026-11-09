import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    getDefaultSharedRateLimitsDeps,
    readSharedRateLimits,
    recordSharedRateLimits,
    type SharedRateLimitsDeps
} from '../shared-rate-limits';

const NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const FIVE_HOUR_RESET = NOW_S + 2 * 3600;
const SEVEN_DAY_RESET = NOW_S + 3 * 86400;

describe('shared rate limits', () => {
    let tempDir: string;
    let deps: SharedRateLimitsDeps;
    let nowMs: number;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-shared-rate-limits-'));
        nowMs = NOW_MS;
        deps = {
            ...getDefaultSharedRateLimitsDeps(),
            now: () => nowMs,
            cachePath: path.join(tempDir, 'cache', 'usage-test.rate-limits.json')
        };
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function record(fiveHour: number | null, sevenDay: number | null, observedAtMs: number | undefined, fiveHourReset = FIVE_HOUR_RESET): void {
        recordSharedRateLimits({
            ...(fiveHour === null ? {} : { five_hour: { used_percentage: fiveHour, resets_at: fiveHourReset } }),
            ...(sevenDay === null ? {} : { seven_day: { used_percentage: sevenDay, resets_at: SEVEN_DAY_RESET } })
        }, () => observedAtMs, deps);
    }

    it('reads nothing before any session has reported', () => {
        expect(readSharedRateLimits(deps)).toBeNull();
    });

    it('keeps the windows a payload reports, with when they were observed', () => {
        record(42, 15, NOW_MS - 1000);

        expect(readSharedRateLimits(deps)).toEqual({
            five_hour: { used_percentage: 42, resets_at: FIVE_HOUR_RESET, observedAtMs: NOW_MS - 1000 },
            seven_day: { used_percentage: 15, resets_at: SEVEN_DAY_RESET, observedAtMs: NOW_MS - 1000 }
        });
        expect(fs.readdirSync(path.dirname(deps.cachePath)).sort()).toEqual(['usage-test.rate-limits.json']);
    });

    it('takes a higher percent in the same window and ignores a lower one from an idle session', () => {
        record(40, 15, NOW_MS - 60_000);
        record(45, 16, NOW_MS - 10_000);
        // An idle session re-renders the percents from its last response
        record(30, 12, NOW_MS - 3_600_000);

        expect(readSharedRateLimits(deps)).toEqual({
            five_hour: { used_percentage: 45, resets_at: FIVE_HOUR_RESET, observedAtMs: NOW_MS - 10_000 },
            seven_day: { used_percentage: 16, resets_at: SEVEN_DAY_RESET, observedAtMs: NOW_MS - 10_000 }
        });
    });

    it('keeps a window the newer payload lacks', () => {
        record(40, 15, NOW_MS - 60_000);
        record(41, null, NOW_MS - 1000);

        const shared = readSharedRateLimits(deps);
        expect(shared?.five_hour?.used_percentage).toBe(41);
        expect(shared?.seven_day?.used_percentage).toBe(15);
    });

    it('does not rewrite the file when nothing changed', () => {
        record(40, 15, NOW_MS - 1000);
        const mtimeBefore = fs.statSync(deps.cachePath).mtimeMs;
        let observedAtAsked = 0;
        deps.writeFileSync = () => { throw new Error('unexpected write'); };

        recordSharedRateLimits({ five_hour: { used_percentage: 39, resets_at: FIVE_HOUR_RESET } }, () => {
            observedAtAsked++;
            return NOW_MS;
        }, deps);
        record(40, 15, NOW_MS - 1000);

        expect(observedAtAsked).toBe(0);
        expect(fs.statSync(deps.cachePath).mtimeMs).toBe(mtimeBefore);
        expect(readSharedRateLimits(deps)?.five_hour?.used_percentage).toBe(40);
    });

    it('moves the observation time of an unchanged percent at most once a minute', () => {
        record(40, null, NOW_MS - 120_000);
        record(40, null, NOW_MS - 90_000);
        expect(readSharedRateLimits(deps)?.five_hour?.observedAtMs).toBe(NOW_MS - 120_000);

        record(40, null, NOW_MS - 30_000);
        expect(readSharedRateLimits(deps)?.five_hour?.observedAtMs).toBe(NOW_MS - 30_000);
    });

    it('replaces another window only with a reading known to be newer', () => {
        record(80, null, NOW_MS - 60_000);
        const otherLoginReset = FIVE_HOUR_RESET + 3600;

        // Undated (no response in the transcript): the stored window stands
        record(5, null, undefined, otherLoginReset);
        expect(readSharedRateLimits(deps)?.five_hour?.used_percentage).toBe(80);

        // Older than the stored one: it stands
        record(5, null, NOW_MS - 120_000, otherLoginReset);
        expect(readSharedRateLimits(deps)?.five_hour?.used_percentage).toBe(80);

        record(5, null, NOW_MS - 1000, otherLoginReset);
        expect(readSharedRateLimits(deps)?.five_hour).toEqual({ used_percentage: 5, resets_at: otherLoginReset, observedAtMs: NOW_MS - 1000 });
    });

    it('drops windows whose reset has passed, on read and on record', () => {
        record(90, 15, NOW_MS - 1000);

        nowMs = (FIVE_HOUR_RESET + 1) * 1000;
        expect(readSharedRateLimits(deps)).toEqual({ seven_day: { used_percentage: 15, resets_at: SEVEN_DAY_RESET, observedAtMs: NOW_MS - 1000 } });

        // An idle session still reporting the reset window doesn't bring it back
        record(90, null, NOW_MS - 1000);
        expect(readSharedRateLimits(deps)?.five_hour).toBeUndefined();

        // The new window replaces the reset one
        record(3, null, nowMs - 1000, FIVE_HOUR_RESET + 5 * 3600);
        expect(readSharedRateLimits(deps)?.five_hour?.used_percentage).toBe(3);
    });

    it('ignores windows without a reset time, and payloads without rate_limits', () => {
        recordSharedRateLimits({ five_hour: { used_percentage: 42 } }, () => NOW_MS, deps);
        recordSharedRateLimits(undefined, () => NOW_MS, deps);
        recordSharedRateLimits(null, () => NOW_MS, deps);

        expect(fs.existsSync(deps.cachePath)).toBe(false);
    });

    it('reads a corrupt or foreign file as empty and replaces it', () => {
        fs.mkdirSync(path.dirname(deps.cachePath), { recursive: true });
        fs.writeFileSync(deps.cachePath, '{"version":99,"windows":{"five_hour":{"used_percentage":99,"resets_at":1}}}');
        expect(readSharedRateLimits(deps)).toBeNull();

        fs.writeFileSync(deps.cachePath, 'not json');
        expect(readSharedRateLimits(deps)).toBeNull();

        record(42, null, NOW_MS);
        expect(readSharedRateLimits(deps)?.five_hour?.used_percentage).toBe(42);
    });

    it('never throws when the cache cannot be written', () => {
        deps.renameSync = () => { throw new Error('EPERM'); };

        expect(() => { record(42, 15, NOW_MS); }).not.toThrow();
        expect(readSharedRateLimits(deps)).toBeNull();
        expect(fs.readdirSync(path.dirname(deps.cachePath))).toEqual([]);
    });
});
