import { parseMissAlertIdentifier } from '@/core/domain/miss-alerts';
import type { MissAlertContent } from '@/core/domain/ports';

export function readMissContent(identifier: string, value: unknown): MissAlertContent | null {
  const pair = parseMissAlertIdentifier(identifier);
  if (!pair || !value || typeof value !== 'object') return null;
  const { title, body, data } = value as Record<string, unknown>;
  if (typeof title !== 'string' || body !== `${title} was missed twice. Fix the environment before anything else today.` ||
    !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 2 || keys.some(key => key !== 'boardId' && key !== 'secondMissedDate') ||
    fields.boardId !== pair.boardId || fields.secondMissedDate !== pair.secondMissedDate) return null;
  return { identifier, ...pair, title, body };
}

export function missNotificationContent(content: MissAlertContent) {
  return { title: content.title, body: content.body, sound: 'default',
    data: { boardId: content.boardId, secondMissedDate: content.secondMissedDate } };
}
