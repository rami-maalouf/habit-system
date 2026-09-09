import * as productContext from '@/features/product-store/context';
import type { ProductCore } from '@/platform/database/product-core';

// observe the real hook's value without replacing the context or its facade.
// ids identity distinguishes simultaneously rendered, independently owned cores.
export function observeProductCore() {
  const rendered = new WeakMap<ProductCore['ids'], ProductCore>();
  const useActualProduct = productContext.useProduct;
  const hook = jest.spyOn(productContext, 'useProduct').mockImplementation(function useObservedProduct() {
    const product = useActualProduct();
    rendered.set(product.core.ids, product.core);
    return product;
  });
  return {
    for(raw: ProductCore): ProductCore {
      const core = rendered.get(raw.ids);
      if (!core) throw new Error('No rendered product core matches these raw ports.');
      return core;
    },
    restore: () => hook.mockRestore(),
  };
}
