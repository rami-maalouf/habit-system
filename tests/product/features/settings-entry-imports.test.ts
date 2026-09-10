jest.mock('@/platform/data-transfer', () => { throw new Error('transfer evaluated'); });
jest.mock('expo-web-browser', () => { throw new Error('browser evaluated'); });
jest.mock('@/platform/database/product-core', () => { throw new Error('real opener evaluated'); });
jest.mock('@/platform/notifications', () => { throw new Error('notifications evaluated'); });
jest.mock('@/platform/widgets', () => { throw new Error('widgets evaluated'); });

it('loads actual Settings without evaluating transfer, browser or real runtime modules', () => {
  expect(() => jest.requireActual('@/features/settings/settings-screen')).not.toThrow();
});
