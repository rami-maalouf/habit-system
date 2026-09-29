import { View } from 'react-native';

import type { HomeBoardCard } from '@/core/domain/queries';
import { getBoardHeatmap } from '@/core/domain/queries';
import { useProductQuery } from '../product-store';
import { InlineError, ProductPressable } from '../ui';
import { AppText } from '@/components/foundation/app-text';
import type { DerivedBoardColors } from './board-colors';
import { HeatmapView } from './heatmap-view';

export function BoardCardHistory({ card, colors, testID }: {
  card: HomeBoardCard; colors: DerivedBoardColors; testID?: string;
}) {
  const history = useProductQuery(core => getBoardHeatmap(core, card.board.id, { days: 140 }), [card.board.id, card.today]);
  if (history.status === 'error') return <View style={{ minHeight: 133 }}>
    <InlineError message="History could not be loaded." />
    <ProductPressable label="Retry history" onPress={history.refresh}><AppText>Retry</AppText></ProductPressable>
  </View>;
  if (history.status !== 'ready' || !history.value) return <View style={{ height: 133 }} />;
  return <HeatmapView kind={card.board.kind} weeks={history.value.weeks} colors={colors} preview testID={`${testID}-heatmap`} />;
}
