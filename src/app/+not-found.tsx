import { Link, Stack, usePathname } from 'expo-router';
import { Text, View } from 'react-native';

export default function NotFoundScreen() {
  const pathname = usePathname();
  const sample = pathname === '/sample' || pathname.startsWith('/sample/');
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <Text selectable>This screen does not exist.</Text>
        <Link replace={!sample} dismissTo={sample} href={sample ? '/sample' : '/'}>
          <Text>{sample ? 'Go to the sample screen' : 'Go to the home screen'}</Text>
        </Link>
      </View>
    </>
  );
}
