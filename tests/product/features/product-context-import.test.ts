jest.mock('@/platform/database/product-core', () => { throw new Error('real opener evaluated'); });
jest.mock('@/platform/notifications', () => { throw new Error('native notifications evaluated'); });
jest.mock('@/platform/widgets', () => { throw new Error('widget publisher evaluated'); });
jest.mock('@/platform/data-transfer', () => { throw new Error('file transfer evaluated'); });
jest.mock('@/platform/alternate-icons', () => { throw new Error('native icon adapter evaluated'); });
jest.mock('@/platform/sync', () => { throw new Error('native sync evaluated'); });

it('imports shared context and operation authority without evaluating real effects', () => {
  expect(context.ProductContext).toBeDefined();
  expect(context.useProduct).toBeInstanceOf(Function);
  expect(context.useProductQuery).toBeInstanceOf(Function);
  expect(authority.createOperationOwner).toBeInstanceOf(Function);
});
import * as context from '@/features/product-store/context';
import * as authority from '@/features/product-store/operation-scope';
