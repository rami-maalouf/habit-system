import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { Reward } from '@/core/domain/entities';
import { reorderReward } from '@/core/domain/reward-commands';
import { listRewards } from '@/core/domain/reward-queries';
import { spacing } from '@/theme';

import { coinAmountLabel } from '../coins/history-presentation';
import { useProductRouter } from '../sample/navigation';
import { useProduct, useProductQuery } from '../product-store';
import { InlineError, PrimaryButton, ProductPressable } from '../ui';
import { RewardRow } from './reward-row';
import { useRewardClaim } from './use-reward-claim';
import { useRewardActivity } from './use-reward-activity';

export function RewardsList({ header, onLayout }: { header: ReactElement; onLayout: () => void }) {
  const router = useProductRouter();
  const { invalidate, nextCommandId } = useProduct();
  const { scope, isCurrent } = useRewardActivity();
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const mounted = useRef(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const claim = useRewardClaim();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const result = useProductQuery(async c => {
    const value = await listRewards(c, { archived });
    return value.ok ? { ok: true as const, value: { archived, rows: value.value } } : value;
  }, [archived]);
  const rows = result.status === 'ready' && result.value.archived === archived ? result.value.rows : [];
  const loaded = result.status === 'ready' && result.value.archived === archived;
  const move = async (index: number, direction: -1 | 1) => {
    if (!isCurrent() || movingRef.current || !rows[index + direction]) return;
    movingRef.current = true; setMoving(true); setMoveError(null);
    const ordered = [...rows]; const [reward] = ordered.splice(index, 1); const target = index + direction;
    await scope.run(async ({ core }) => {
      try {
        const response = await reorderReward(core, { commandId: nextCommandId(), rewardId: reward.id,
          previousRewardId: ordered[target - 1]?.id ?? null, nextRewardId: ordered[target]?.id ?? null });
        if (mounted.current && isCurrent() && !response.ok) setMoveError(response.error.message);
      } catch { if (mounted.current && isCurrent()) setMoveError('The reward could not be moved. Try again.'); }
      finally { movingRef.current = false; if (mounted.current) setMoving(false); invalidate(); }
    });
  };
  const filter = (value: boolean) => {
    if (!isCurrent() || movingRef.current) return;
    setArchived(value); setEditing(false); setMoveError(null);
  };
  return <FlatList<Reward> testID="coins-screen" data={rows} keyExtractor={item => item.id}
    onLayout={onLayout} contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl, flexGrow: 1 }}
    ListHeaderComponent={<View style={{ gap: spacing.lg, paddingBottom: spacing.md }}>
      {header}
      <View style={{ gap: spacing.sm }}>
        <AppText variant="title2" accessibilityRole="header">{archived ? 'Archived Rewards' : 'Rewards'}</AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
          <ProductPressable label="Create Reward" testID="create-reward" onPress={() => { if (isCurrent()) router.push('/coins/rewards/new'); }}>
            <AppText variant="headline" selectable={false}>Create Reward</AppText>
          </ProductPressable>
          <ProductPressable label={archived ? 'Active rewards' : 'Archived rewards'} testID={archived ? 'rewards-active' : 'rewards-archived'}
            disabled={moving} onPress={() => filter(!archived)}><AppText selectable={false}>{archived ? 'Active' : 'Archived'}</AppText></ProductPressable>
          {!archived && rows.length > 0 ? <ProductPressable label={editing ? 'Done reordering rewards' : 'Reorder rewards'} testID="rewards-edit"
            disabled={moving || claim.blocked} onPress={() => { if (isCurrent()) setEditing(value => !value); }}><AppText selectable={false}>{editing ? 'Done' : 'Reorder'}</AppText></ProductPressable> : null}
        </View>
      </View>
      {claim.error ? <InlineError testID="reward-claim-error" message={claim.error.message} /> : null}
      {claim.phase === 'running' ? <AppText testID="reward-claim-pending" accessibilityLiveRegion="polite">Completing your claim...</AppText> : null}
      {claim.phase === 'uncertain' ? <PrimaryButton title="Retry claim" testID="reward-claim-retry" onPress={claim.retry} /> : null}
      {claim.result ? <AppText testID="reward-claim-success" accessibilityLiveRegion="polite">Claimed {claim.result.titleSnapshot} for {coinAmountLabel(claim.result.costCoins)}. Balance: {coinAmountLabel(claim.result.balance)}.</AppText> : null}
      {moveError ? <InlineError testID="reward-order-error" message={moveError} /> : null}
    </View>}
    ListEmptyComponent={result.status === 'error' ? <View style={{ gap: spacing.md }}>
      <InlineError testID="rewards-error" message={result.error.message} />
      <PrimaryButton title="Try again" testID="rewards-retry" onPress={() => { if (isCurrent()) result.refresh(); }} />
    </View> : !loaded ? <AppText testID="rewards-loading">Loading rewards...</AppText>
      : <AppText testID={archived ? 'rewards-archived-empty' : 'rewards-empty'}>{archived ? 'Archived rewards stay here until you restore or delete them.' : 'Choose something to look forward to and give it a coin price.'}</AppText>}
    renderItem={({ item, index }) => <RewardRow reward={item} archived={archived} editing={editing} moving={moving}
      claimDisabled={claim.blocked} canMoveUp={index > 0} canMoveDown={index < rows.length - 1}
      onClaim={() => { void claim.claim(item.id); }} onMove={direction => { void move(index, direction); }} />}
  />;
}
