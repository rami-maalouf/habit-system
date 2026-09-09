jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  SchedulableTriggerInputTypes: { WEEKLY: 'weekly', CALENDAR: 'calendar', DATE: 'date' },
}));

const native = jest.requireMock<{ setNotificationHandler: jest.Mock }>('expo-notifications');
const adapter = jest.requireActual<typeof import('../../../src/platform/notifications/index')>(
  '../../../src/platform/notifications/index');

it('does not install a native presentation handler merely by importing schedulers', () => {
  expect(native.setNotificationHandler).not.toHaveBeenCalled();
});

it('owns presentation until the last real registration retires and supports a later registration', async () => {
  const first = adapter.installNotificationHandler();
  const second = adapter.installNotificationHandler();
  expect(native.setNotificationHandler).toHaveBeenCalledTimes(1);
  const handler = native.setNotificationHandler.mock.calls[0][0];
  expect(await handler.handleNotification()).toEqual({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  });
  first(); first();
  expect(native.setNotificationHandler).toHaveBeenCalledTimes(1);
  second(); second();
  expect(native.setNotificationHandler).toHaveBeenLastCalledWith(null);
  expect(native.setNotificationHandler).toHaveBeenCalledTimes(2);
  const later = adapter.installNotificationHandler();
  first();
  expect(native.setNotificationHandler).toHaveBeenCalledTimes(3);
  later();
  expect(native.setNotificationHandler).toHaveBeenLastCalledWith(null);
  expect(native.setNotificationHandler).toHaveBeenCalledTimes(4);
});
