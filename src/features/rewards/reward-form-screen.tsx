import { Stack, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Alert, Keyboard, ScrollView, TextInput, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { boardPalette, type Reward } from '@/core/domain/entities';
import type { CommandId, RewardId } from '@/core/domain/ids';
import { archiveReward, createReward, deleteReward, restoreReward, updateReward } from '@/core/domain/reward-commands';
import { getReward } from '@/core/domain/reward-queries';
import { validateRewardFields, type RewardFields } from '@/core/domain/reward-validation';
import type { DomainError } from '@/core/domain/result';
import { validateAccentHex } from '@/core/domain/validation';
import { minimumTouchTarget } from '@/foundation/accessibility';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { BoardIconPicker } from '../board-configuration/board-icon-picker';
import { BoardSymbol, deriveBoardColors } from '../boards';
import { getBoardIcon } from '../boards/board-icon-catalog';
import { coinAmountLabel } from '../coins/history-presentation';
import { useProduct, useProductQuery } from '../product-store';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { claimError } from './claim-store';

type Draft = { title: string; costText: string; symbol: string; accentHex: string; expectedMutationStamp: string };
type Attempt =
  | { kind: 'create'; input: RewardFields & { commandId: CommandId } }
  | { kind: 'update'; input: RewardFields & { commandId: CommandId; rewardId: RewardId; expectedMutationStamp: string } }
  | { kind: 'archive' | 'restore' | 'delete'; input: { commandId: CommandId; rewardId: RewardId } };
function draftFrom(reward: Reward | null): Draft {
  return { title: reward?.title ?? '', costText: String(reward?.costCoins ?? 1), symbol: reward?.symbol ?? 'star.fill',
    accentHex: reward?.accentHex ?? '#70A7FF', expectedMutationStamp: reward?.mutationStamp ?? '' };
}

function FormGroup({ children }: { children: ReactNode }) {
  const scheme = useScheme();
  return <View style={{ padding: spacing.lg, gap: spacing.md, borderRadius: radius.lg, borderCurve: radiusCurve,
    backgroundColor: semanticColor('secondaryGroupedBackground', scheme) }}>{children}</View>;
}

export function RewardFormScreen({ rewardId }: { rewardId: RewardId | null }) {
  const router = useRouter();
  const existing = useProductQuery(c => rewardId ? getReward(c, rewardId) : Promise.resolve({ ok: true as const, value: null }), [rewardId]);
  const [lastReward, setLastReward] = useState<Reward | null>(null);
  // retain the editor and its draft when a later read fails; query cancellation still owns freshness.
  if (existing.status === 'ready' && existing.value !== lastReward) setLastReward(existing.value);
  const reward = existing.status === 'ready' ? existing.value : lastReward?.id === rewardId ? lastReward : null;
  const loadError = existing.status === 'error' ? existing.error : null;
  if (rewardId && loadError && !reward) return <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
    <Stack.Screen options={{ title: 'Reward' }} />
    <AppText variant="title2">This reward is not available.</AppText>
    <InlineError message={loadError.message} testID="reward-load-error" />
    {loadError.retryable ? <PrimaryButton title="Try again" testID="reward-load-retry" onPress={existing.refresh} /> : null}
    <PrimaryButton title="Back to Coins" onPress={() => router.dismissTo('/coins')} />
  </View>;
  if (rewardId && reward?.id !== rewardId) return <View testID="reward-form-loading" />;
  return <RewardEditor key={rewardId ?? 'new'} reward={reward} loadError={loadError} retryLoad={existing.refresh} />;
}

function RewardEditor({ reward, loadError, retryLoad }: { reward: Reward | null; loadError: DomainError | null; retryLoad: () => void }) {
  const router = useRouter();
  const navigation = useNavigation();
  const scheme = useScheme();
  const { core, invalidate, nextCommandId } = useProduct();
  const [draft, setDraft] = useState(() => draftFrom(reward));
  const [savedDraft, setSavedDraft] = useState(() => draftFrom(reward));
  const [error, setError] = useState<DomainError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [symbolOpen, setSymbolOpen] = useState(false);
  const [customColorOpen, setCustomColorOpen] = useState(false);
  const busyRef = useRef(false);
  const attemptRef = useRef<Attempt | null>(null);
  const mounted = useRef(false);
  const deliberateExit = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const archived = reward?.archivedAt != null;
  const unavailable = loadError !== null && !loadError.retryable;
  const locked = busy || attempt !== null;
  const previewAccent = validateAccentHex(archived ? reward!.accentHex : draft.accentHex);
  const colors = deriveBoardColors(previewAccent.ok ? previewAccent.value : savedDraft.accentHex, scheme);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  usePreventRemove(dirty || busy || attempt !== null, ({ data }) => {
    if (deliberateExit.current) { navigation.dispatch(data.action); return; }
    if (busyRef.current || attemptRef.current) return;
    let decided = false;
    Alert.alert('Discard changes?', 'Your edits to this reward are not saved.', [
      { text: 'Keep Editing', style: 'cancel', onPress: () => { decided = true; } },
      { text: 'Discard', style: 'destructive', onPress: () => {
        if (decided || !mounted.current || busyRef.current || attemptRef.current) return;
        decided = true; deliberateExit.current = true; navigation.dispatch(data.action);
      } },
    ]);
  });

  const change = (patch: Partial<Draft>) => {
    if (busyRef.current || attemptRef.current || archived || unavailable) return;
    setDraft(current => ({ ...current, ...patch }));
  };
  const execute = async (current: Attempt) => {
    attemptRef.current = current; setAttempt(current); setError(null);
    try {
      const result = current.kind === 'create' ? await createReward(core, current.input)
        : current.kind === 'update' ? await updateReward(core, current.input)
          : current.kind === 'archive' ? await archiveReward(core, current.input)
            : current.kind === 'restore' ? await restoreReward(core, current.input)
              : await deleteReward(core, current.input);
      if (result.ok) {
        attemptRef.current = null;
        invalidate();
        if (mounted.current) { setAttempt(null); deliberateExit.current = true; router.dismissTo('/coins'); }
      } else if (mounted.current) {
        setError(result.error);
        if (!result.error.retryable) {
          attemptRef.current = null; setAttempt(null);
          if (result.error.code === 'conflict') setConflict(true);
          else if (result.error.code === 'not_found' || result.error.code === 'archived') invalidate();
        }
      }
    } catch (cause) { if (mounted.current) setError(claimError(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const retry = () => {
    if (busyRef.current || !attemptRef.current) return;
    busyRef.current = true; setBusy(true); void execute(attemptRef.current);
  };
  const save = () => {
    if (busyRef.current || archived || conflict || loadError) return;
    if (attemptRef.current) { retry(); return; }
    if (!/^\d+$/.test(draft.costText)) {
      setError({ code: 'validation', message: 'Enter a whole-number cost from 1 to 100,000 coins.', field: 'costCoins', retryable: false });
      return;
    }
    const fields = validateRewardFields({ title: draft.title, costCoins: Number(draft.costText), symbol: draft.symbol, accentHex: draft.accentHex });
    if (!fields.ok) { setError(fields.error); return; }
    busyRef.current = true; setBusy(true); setConflict(false); Keyboard.dismiss();
    try {
      const commandId = nextCommandId();
      const current: Attempt = reward
        ? { kind: 'update', input: { ...fields.value, commandId, rewardId: reward.id, expectedMutationStamp: draft.expectedMutationStamp } }
        : { kind: 'create', input: { ...fields.value, commandId } };
      void execute(current);
    } catch (cause) { busyRef.current = false; setBusy(false); setError(claimError(cause)); }
  };
  const targetAction = (kind: 'archive' | 'restore' | 'delete') => {
    if (!reward || busyRef.current || attemptRef.current || loadError) return;
    busyRef.current = true; setBusy(true); Keyboard.dismiss();
    let decided = false;
    const decide = (confirmed: boolean) => {
      if (decided) return;
      decided = true;
      if (!confirmed || !mounted.current) { busyRef.current = false; if (mounted.current) setBusy(false); return; }
      try { void execute({ kind, input: { commandId: nextCommandId(), rewardId: reward.id } }); }
      catch (cause) { busyRef.current = false; setBusy(false); setError(claimError(cause)); }
    };
    if (kind === 'restore') { decide(true); return; }
    Alert.alert(kind === 'delete' ? 'Delete reward?' : 'Archive reward?', kind === 'delete'
      ? 'This reward will be deleted. Past claims and their recorded titles remain in Coin History.'
      : 'This reward moves to Archived Rewards. Past claims stay in Coin History.', [
      { text: 'Cancel', style: 'cancel', onPress: () => decide(false) },
      { text: kind === 'delete' ? 'Delete' : 'Archive', style: kind === 'delete' ? 'destructive' : 'default', onPress: () => decide(true) },
    ], { cancelable: true, onDismiss: () => decide(false) });
  };
  const reload = async () => {
    if (!reward || busyRef.current || attemptRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const result = await getReward(core, reward.id);
      if (!mounted.current) return;
      if (result.ok) { const next = draftFrom(result.value); setDraft(next); setSavedDraft(next); setConflict(false); setError(null); invalidate(); }
      else { setError(result.error); if (!result.error.retryable) invalidate(); }
    } catch (cause) { if (mounted.current) setError(claimError(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const inputStyle = { minHeight: minimumTouchTarget, fontSize: 17, color: semanticColor('label', scheme) as string };

  return <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
    <Stack.Screen options={{ title: archived ? 'Archived Reward' : reward ? 'Edit Reward' : 'Create Reward',
      headerLeft: () => <ProductPressable label="Cancel" testID="reward-form-cancel" disabled={locked} onPress={() => router.back()}><AppText selectable={false}>Cancel</AppText></ProductPressable>,
      headerRight: () => archived || unavailable ? null : <ProductPressable label="Save reward" testID="reward-form-save" disabled={busy || conflict || loadError !== null || (attempt !== null && !['create', 'update'].includes(attempt.kind))} onPress={save}>
        <AppText variant="headline" selectable={false}>{attempt ? 'Retry' : 'Save'}</AppText></ProductPressable>,
    }} />
    <ScrollView testID="reward-form" contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.md }}>
      {loadError ? <View style={{ gap: spacing.sm }}><InlineError testID="reward-load-error" message={loadError.message} />
        {loadError.retryable ? <PrimaryButton title="Try again" testID="reward-load-retry" onPress={retryLoad} /> : null}</View> : null}
      {error ? <InlineError testID="reward-form-error" message={error.message} /> : null}
      {attempt && !busy ? <View style={{ gap: spacing.sm }}>
        <AppText>Retry this action to confirm its saved result before making more changes.</AppText>
        <PrimaryButton title="Retry" testID="reward-form-retry" onPress={retry} />
      </View> : null}
      {busy ? <AppText accessibilityLiveRegion="polite" testID="reward-form-pending">Please wait...</AppText> : null}
      {conflict && !unavailable ? <FormGroup><AppText testID="reward-form-conflict">This reward changed elsewhere. Your draft is still here. Reload the latest values before saving again.</AppText>
        <PrimaryButton title="Reload latest" testID="reward-form-reload" onPress={() => { void reload(); }} disabled={busy} /></FormGroup> : null}
      {unavailable ? <AppText>This reward is not available.</AppText> : <>
      <FormGroup><View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <View testID="reward-symbol-preview-tile" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
          borderRadius: radius.md, borderCurve: radiusCurve, backgroundColor: colors.accent }}>
          <BoardSymbol symbol={archived ? reward!.symbol : draft.symbol} color={colors.onAccent} size={28} testID="reward-symbol-preview" />
        </View>
        <View style={{ flex: 1, gap: spacing.xs }}><AppText variant="headline">{archived ? reward!.title : draft.title.trim() || 'New reward'}</AppText>
          <AppText variant="subheadline">{archived ? coinAmountLabel(reward!.costCoins) : `${draft.costText || '0'} ${Number(draft.costText) === 1 ? 'coin' : 'coins'}`}</AppText></View>
      </View></FormGroup>
      {archived ? <>
        <AppText>This reward is archived. Restore it to edit or claim it.</AppText>
        <PrimaryButton title="Restore Reward" testID="restore-reward" disabled={locked} onPress={() => targetAction('restore')} />
      </> : <>
        <FormGroup><View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <ProductPressable label={`Choose icon, ${getBoardIcon(draft.symbol)?.label ?? 'current icon'}`} hint="Opens the icon picker" testID="open-symbol-picker" disabled={locked}
            onPress={() => { if (!busyRef.current && !attemptRef.current) { Keyboard.dismiss(); setSymbolOpen(true); } }}>
            <View testID="reward-symbol-picker-tile" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
              borderRadius: radius.md, borderCurve: radiusCurve, backgroundColor: colors.accent }}>
              <BoardSymbol symbol={draft.symbol} color={colors.onAccent} size={28} />
            </View>
          </ProductPressable>
          <TextInput accessibilityLabel="Reward name" placeholder="Reward name" placeholderTextColor={semanticColor('secondaryLabel', scheme) as string}
            testID="reward-title-input" value={draft.title} editable={!locked} onChangeText={title => change({ title })} style={{ ...inputStyle, flex: 1 }} />
        </View></FormGroup>
        <FormGroup><AppText variant="subheadline">Cost in coins</AppText>
          <TextInput accessibilityLabel="Cost in coins" testID="reward-cost-input" value={draft.costText} keyboardType="number-pad"
            editable={!locked} onChangeText={costText => change({ costText })} style={inputStyle} />
          <AppText variant="footnote">Choose a whole number from 1 to 100,000.</AppText>
        </FormGroup>
        <FormGroup><AppText variant="subheadline">Color</AppText><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          <ProductPressable label="Custom color" testID="custom-color" disabled={locked} onPress={() => { if (!busyRef.current && !attemptRef.current) setCustomColorOpen(value => !value); }}><AppText selectable={false}>Custom</AppText></ProductPressable>
          {boardPalette.map(entry => <ProductPressable key={entry.name} label={`Color ${entry.name}`} selected={draft.accentHex.toUpperCase() === entry.hex}
            testID={`color-${entry.name}`} disabled={locked} onPress={() => change({ accentHex: entry.hex })}>
            <View style={{ width: 32, height: 32, borderRadius: radius.capsule, backgroundColor: entry.hex,
              borderWidth: draft.accentHex.toUpperCase() === entry.hex ? 3 : 0, borderColor: semanticColor('label', scheme) }} />
          </ProductPressable>)}
        </View>{customColorOpen ? <TextInput accessibilityLabel="Custom color hex" testID="custom-color-input" placeholder="#RRGGBB" value={draft.accentHex}
          autoCapitalize="characters" editable={!locked} onChangeText={accentHex => change({ accentHex })} style={inputStyle} /> : null}</FormGroup>
        {reward ? <PrimaryButton title="Archive Reward" testID="archive-reward" disabled={locked} onPress={() => targetAction('archive')} /> : null}
      </>}
      {reward ? <PrimaryButton title="Delete Reward" testID="delete-reward" destructive disabled={locked} onPress={() => targetAction('delete')} /> : null}
      </>}
    </ScrollView>
    <BoardIconPicker isPresented={symbolOpen} symbol={draft.symbol} accent={colors.accent}
      onSelect={symbol => { change({ symbol }); if (!busyRef.current && !attemptRef.current) setSymbolOpen(false); }} onDismiss={() => setSymbolOpen(false)} />
  </View>;
}
