import { createEconomicDayCloseResolver } from '../calendar/economic-day-close';
import { addDays, isoWeekday } from '../calendar/logical-date';
import { createBoard, createCheckIn, removeCheckIn } from '../domain/commands';
import type { BoardId, CheckInId, CommandId, LogicalDate } from '../domain/ids';
import type { Clock, Hashing, IdGenerator } from '../domain/ports';
import { claimReward, createReward } from '../domain/reward-commands';
import { listRewards } from '../domain/reward-queries';
import type { DomainError, DomainResult } from '../domain/result';
import { ok } from '../domain/result';
import type { SqlDatabase } from '../persistence/database';

const seed = 22092026;
const present = Date.UTC(2026, 8, 9, 16);
const zone = 'America/Toronto';
const habits = [
  ['Stretch for a minute', 'figure.mind.and.body', '#69B578'],
  ['Drink a glass of water', 'drop.fill', '#4C9ACB'],
  ['Read a page', 'book.fill', '#B482B8'],
  ['Plan the day', 'checklist', '#D29C52'],
  ['Take a walk', 'figure.walk', '#72A98F'],
  ['Make something', 'paintbrush.fill', '#CD7D8A'],
  ['Wind down', 'moon.stars.fill', '#7E86C4'],
  ['Focus sessions', 'timer', '#648EA5'],
] as const;
const rewards = [
  ['A favourite drink', 5, 'cup.and.saucer.fill'],
  ['An afternoon at a cafe', 15, 'book.fill'],
  ['A cinema visit', 40, 'play.rectangle.fill'],
  ['A day trip', 120, 'suitcase.fill'],
] as const;

class SampleCommandFailure {
  constructor(readonly error: DomainError) {}
}

async function completed<T>(result: Promise<DomainResult<T>>): Promise<T> {
  const outcome = await result;
  if (!outcome.ok) throw new SampleCommandFailure(outcome.error);
  return outcome.value;
}

export type SampleRuntime = {
  clock: Clock;
  ids: IdGenerator;
  populate(db: SqlDatabase, hashing: Hashing): Promise<DomainResult<void>>;
};

export function createSampleRuntime(): SampleRuntime {
  let now = present;
  let sequence = 0;
  const clock: Clock = { nowUtcMs: () => now, timeZoneId: () => zone };
  const ids: IdGenerator = { uuid: () =>
    `${seed.toString(16).padStart(8, '0')}-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}` };
  return {
    clock,
    ids,
    async populate(db, hashing) {
      const deps = { db, hashing, clock, ids };
      const commandId = () => ids.uuid() as CommandId;
      try {
        now = Date.UTC(2023, 8, 10, 9);
        const boards: BoardId[] = [];
        for (const [index, [title, symbol, accentHex]] of habits.entries()) {
          const count = index === 7;
          const result = await completed(createBoard(deps, {
            commandId: commandId(), title, symbol, accentHex, kind: count ? 'count' : 'daily',
            usesTintedBackground: false, tracksAmount: count, tracksTime: count,
            amountUnit: count ? 'minutes' : null, quickAmount: count ? 25 : 1,
            startOfDayMinute: 0, metricsEnabled: true, requiredInStack: index < 4,
            earnsCoins: true, coinCapPerDay: count ? 3 : 1,
            anchor: index === 0 ? { kind: 'preset', relation: 'after', preset: 'wake' }
              : index < 4 ? { kind: 'board', relation: 'after', boardId: boards[index - 1] } : null,
          }));
          boards.push(result.boardId);
          now += 60_000;
        }
        for (const [title, costCoins, symbol] of rewards) {
          await completed(createReward(deps, { commandId: commandId(), title, costCoins, symbol, accentHex: '#D29C52' }));
          now += 60_000;
        }
        const availableRewards = await completed(listRewards(deps));
        const noon = createEconomicDayCloseResolver(zone);
        let randomState = seed;
        const random = () => {
          randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
          return randomState / 4294967296;
        };
        let dayIndex = 0;
        for (let date = '2023-09-10' as LogicalDate; date <= '2026-09-09'; date = addDays(date, 1), dayIndex += 1) {
          const weekday = isoWeekday(date);
          const rolls = habits.map(() => random());
          const onBreak = (date >= '2024-07-13' && date <= '2024-07-24') ||
            (date >= '2025-03-08' && date <= '2025-03-16') ||
            (date >= '2025-12-22' && date <= '2026-01-02');
          if (onBreak) continue;
          // every recipe event is after toronto's overnight dst transition.
          // resolve each calendar label at noon, then use its same-day offset.
          const localNoon = noon(addDays(date, -1), 720);
          const atMinute = (minute: number) => localNoon + (minute - 720) * 60_000;
          const checks = new Map<number, CheckInId>();
          const check = async (boardIndex: number, minute: number, amount?: number) => {
            const instant = atMinute(minute);
            if (instant > present) return;
            now = instant;
            const result = await completed(createCheckIn(deps, {
              commandId: commandId(), boardId: boards[boardIndex], source: 'app', amount,
            }));
            checks.set(boardIndex, result.checkInId);
          };
          for (let index = 0; index < 4; index += 1) {
            const checked = date === '2024-02-29' || (date === '2026-09-09' ? index < 2
              : dayIndex === 0 || rolls[index] < (weekday <= 5 ? 0.9 : 0.55));
            if (checked) await check(index, 420 + index * 5);
          }
          if (date === '2024-02-29') {
            now = atMinute(440);
            await completed(removeCheckIn(deps, { commandId: commandId(), checkInId: checks.get(2)! }));
            await check(2, 445);
          }
          if ([1, 3, 5].includes(weekday) ? rolls[4] < 0.9 : weekday >= 6 && rolls[4] < 0.3) {
            await check(4, 480);
          }
          if (weekday <= 5) {
            const sessions = date === '2024-02-29' ? 4 : rolls[7] < 0.2 ? 0 : rolls[7] < 0.65 ? 1 : 2;
            for (let index = 0; index < sessions; index += 1) {
              await check(7, [600, 660, 840, 900][index], index % 2 === 0 ? 25 : 45);
            }
          }
          if ([2, 4, 6].includes(weekday) && rolls[5] < 0.8) await check(5, 1080);
          if (dayIndex > 0 && dayIndex % 90 === 0) {
            now = atMinute(1140);
            const reward = availableRewards[(dayIndex / 90 - 1) % availableRewards.length];
            await completed(claimReward(deps, {
              commandId: commandId(), rewardId: reward.id, expectedMutationStamp: reward.mutationStamp,
            }));
          }
          if (rolls[6] < 0.85) await check(6, 1290);
        }
        return ok(undefined);
      } catch (cause) {
        if (cause instanceof SampleCommandFailure) return { ok: false, error: cause.error };
        throw cause;
      } finally {
        now = present;
      }
    },
  };
}
