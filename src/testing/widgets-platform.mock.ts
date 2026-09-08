// jest replacement for @/platform/widgets: records refreshes and lets tests
// emit widget quick actions
import type { WidgetProjectionSnapshot } from '@/core/domain/widget-projection';

export const widgetsPlatformMock = {
  refreshCalls: 0,
  snapshots: [] as WidgetProjectionSnapshot[],
  quickHandlers: new Set<(boardId: string) => void>(),
  reset() {
    this.refreshCalls = 0;
    this.snapshots = [];
    this.quickHandlers = new Set();
  },
  emitQuickAction(boardId: string) {
    for (const handler of this.quickHandlers) {
      handler(boardId);
    }
  },
};

export async function refreshWidgets(snapshot: WidgetProjectionSnapshot): Promise<void> {
  widgetsPlatformMock.refreshCalls += 1;
  widgetsPlatformMock.snapshots.push(snapshot);
}

export function addWidgetQuickActionListener(handler: (boardId: string) => void): () => void {
  widgetsPlatformMock.quickHandlers.add(handler);
  return () => widgetsPlatformMock.quickHandlers.delete(handler);
}
