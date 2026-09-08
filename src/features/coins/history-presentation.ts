import type { CoinHistoryItem } from '@/core/domain/coin-queries';

export function coinAmountLabel(value: number) {
  return `${value < 0 ? 'minus ' : ''}${Math.abs(value)} ${Math.abs(value) === 1 ? 'coin' : 'coins'}`;
}

export function coinHistoryPresentation(item: CoinHistoryItem) {
  const reference = item.reference;
  let subtitle: string;
  if (reference.kind === 'reward') subtitle = reference.title;
  else {
    subtitle = !reference.title?.trim() ? `Unavailable ${reference.kind === 'habit' ? 'habit' : 'stack'}`
      : reference.kind === 'stack' ? `Stack rooted at ${reference.title}` : reference.title;
    if (reference.status === 'archived') subtitle += ' (Archived)';
    if (reference.status === 'deleted') subtitle += ' (Deleted)';
  }
  let title: string;
  let explanation: string | null = null;
  if (item.kind === 'check') title = 'Habit check-in';
  else if (item.kind === 'run_bonus') title = 'Stack completion bonus';
  else if (item.kind === 'claim') title = 'Reward claimed';
  else if (item.kind === 'reversal') title = reference.kind === 'stack' ? 'Stack bonus reversed' : 'Check-in reward reversed';
  else if (item.adjustment === 'cancellation') {
    title = 'Earlier balance adjustment undone';
    explanation = 'New activity replaced an earlier balance correction.';
  } else {
    title = item.delta > 0 ? 'Coins restored' : 'Balance corrected';
    explanation = 'Your balance was corrected after conflicting activity.';
  }
  const delta = `${item.delta > 0 ? '+' : ''}${item.delta}`;
  const label = [title, coinAmountLabel(item.delta), subtitle, item.logicalDate, explanation].filter(Boolean).join(', ');
  return { title, subtitle, explanation, delta, label };
}

// format the stored civil date directly, without timezone or early-year remapping.
export function coinDateLabel(date: string) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8))}, ${date.slice(0, 4)}`;
}
