import { Platform } from 'react-native';
import { offsetMinutesAt } from '@/core/calendar/logical-date';
import { reconcileMissAlerts } from '@/core/domain/miss-alert-reconciliation';
import { reconcileReminderSchedules } from '@/core/domain/reminder-commands';
import type { CommandId } from '@/core/domain/ids';
import type { MissAlertScheduler, ReminderScheduler } from '@/core/domain/ports';
import type { ProductCore } from '@/platform/database/product-core';

export class NotificationCoordinator {
  private disposed = false;
  private revision = 0;
  private running: Promise<void> | null = null;
  private requested = false;
  private remindersRequested = false;
  private countDirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private core: ProductCore, private miss: MissAlertScheduler, private reminders: ReminderScheduler,
    private active: boolean, private refreshCount: () => void, private remindersChanged: () => void) {
    this.watchClock();
  }

  request(reminders = true) {
    if (this.disposed || !this.active) return;
    this.revision += 1;
    this.requested = true;
    this.remindersRequested ||= reminders;
    this.clearDeadline();
    if (!this.running) this.running = this.run().finally(() => {
      this.running = null;
      // a publication can queue a request after the loop's final check.
      if (this.requested) this.request(false);
    });
  }

  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.revision += 1;
    this.clearDeadline();
    this.watchClock();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.revision += 1;
    this.clearDeadline();
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    return this.running ?? Promise.resolve();
  }

  private clearDeadline() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private watchClock() {
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (!this.active || this.disposed || Platform.OS !== 'android') return;
    const sample = () => {
      const utc = this.core.clock.nowUtcMs(), zone = this.core.clock.timeZoneId();
      return { utc, zone, offset: offsetMinutesAt(utc, zone), elapsed: performance.now() };
    };
    let previous = sample();
    this.clockTimer = setInterval(() => {
      const current = sample();
      if (current.zone !== previous.zone || current.offset !== previous.offset ||
        Math.abs((current.utc - previous.utc) - (current.elapsed - previous.elapsed)) > 1000) this.request();
      previous = current;
    }, 60_000);
  }

  private async run() {
    while (this.requested && this.active && !this.disposed) {
      this.requested = false;
      const revision = this.revision;
      const isCurrent = () => !this.disposed && this.active && this.revision === revision;
      const reminders = this.remindersRequested;
      this.remindersRequested = false;
      if (reminders) {
        const result = await reconcileReminderSchedules({ ...this.core, scheduler: this.reminders },
          { commandId: this.core.ids.uuid() as CommandId }).catch(() => null);
        if (isCurrent() && result?.ok && result.value.updated > 0) this.remindersChanged();
      }
      if (!isCurrent()) continue;
      const result = await reconcileMissAlerts({ db: this.core.db, clock: this.core.clock, scheduler: this.miss },
        { isCurrent, isForeground: () => this.active && !this.disposed });
      this.countDirty ||= result.localChanged || result.refreshPendingCount;
      if (!isCurrent()) continue;
      if (this.countDirty) { this.countDirty = false; this.refreshCount(); }
      if (result.nextRunAtUtcMs !== null) {
        const delay = result.nextRunAtUtcMs - this.core.clock.nowUtcMs();
        if (delay > 0) this.timer = setTimeout(() => {
          // native expiry changes the count even when no delivery callback arrives.
          this.countDirty = true;
          this.request(false);
        }, delay);
      }
    }
  }
}
