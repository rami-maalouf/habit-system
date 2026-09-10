import { useFocusEffect, useNavigation, usePathname, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo } from 'react';

import { useProduct, type ProductScope } from '../product-store/context';
import { useProductActivity } from '../product-store/use-product-activity';

export function productHref(kind: ProductScope['kind'], href: Href): Href {
  if (kind === 'real') return href;
  const pathname = typeof href === 'string' ? href : href.pathname;
  const [, path, suffix] = /^([^?#]*)(.*)$/.exec(pathname)!;
  if (!path.startsWith('/') || path.startsWith('//') || path.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Product navigation requires an absolute app path.');
  }
  const scoped = path === '/sample' || path.startsWith('/sample/') ? pathname
    : `/sample${path === '/' ? '' : path}${suffix}`;
  return typeof href === 'string' ? scoped as Href : { ...href, pathname: scoped } as Href;
}

// every callback retains its original authority, including after resumption.
export function useProductRouter() {
  const router = useRouter();
  const navigation = useNavigation();
  const pathname = usePathname();
  const { scope, closeSample } = useProduct();
  const activity = useProductActivity(scope);
  return useMemo(() => {
    const go = (method: 'push' | 'navigate' | 'replace' | 'dismissTo', target: Href) => {
      if (activity.active) router[method](productHref(scope.kind, target));
    };
    return {
      href: (target: Href) => productHref(scope.kind, target),
      push: (target: Href) => go('push', target),
      navigate: (target: Href) => go('navigate', target),
      replace: (target: Href) => go('replace', target),
      dismissTo: (target: Href) => go('dismissTo', target),
      back: () => {
        if (!activity.active) return;
        if (scope.kind === 'sample' && (navigation.getState()?.index ?? 0) === 0) {
          if (pathname === '/sample' || pathname === '/sample/') void closeSample?.().catch(() => {});
          else router.replace(productHref('sample', '/'));
        } else router.back();
      },
    };
  }, [router, navigation, pathname, scope, closeSample, activity]);
}

export function ProductRedirect({ href }: { href: Href }) {
  const router = useProductRouter();
  useFocusEffect(useCallback(() => { router.replace(href); }, [router, href]));
  return null;
}
