import { Stack } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { semanticColor, spacing } from '@/theme';
import { useScheme } from '../ui/primitives';

export function SampleDisabledScreen({ title, message }: { title: string; message: string }) {
  const scheme = useScheme();
  return <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
    <Stack.Screen options={{ title }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: spacing.lg }}>
      <AppText>{message}</AppText>
    </ScrollView>
  </View>;
}
