import { transformFileSync } from '@babel/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import type { RipplesWidgetProps, WidgetRowProps } from '@/features/widgets/widget-props';

type Node = {
  type: string;
  props: {
    children?: Node | Node[];
    modifiers?: { $type: string; label?: string; value?: number }[];
    destination?: string;
    systemName?: string;
    text?: string;
  };
};

// use expo's compiler and extension runtime, so external closure references
// fail here just as they would in the widget process.
const caller = { name: 'metro', platform: 'ios', isDev: true };
const compiled = transformFileSync(resolve('src/platform/widgets/ripples-boards-widget.tsx'), {
  presets: ['babel-preset-expo'],
  caller,
})?.code;
if (!compiled) throw new Error('widget compilation failed');
const moduleContext = createContext({
  exports: {} as { default?: string },
  require: (name: string) => name === 'expo-widgets'
    ? { createWidget: (_name: string, layout: string) => layout }
    : {},
});
runInContext(compiled, moduleContext);
const runtime = createContext({});
runInContext(readFileSync(resolve('node_modules/expo-widgets/bundle/build/ExpoWidgets.bundle'), 'utf8'), runtime);
runInContext(`globalThis.__expoWidgetLayout = (${moduleContext.exports.default})`, runtime);

const row: WidgetRowProps = {
  boardId: 'a', kind: 'daily', title: 'Reading', symbol: 'star.fill', accentHex: '#70A7FF',
  strip: [0, 1, 3, 0, 0, 0, 2], checkedToday: true,
};

function render(rows: WidgetRowProps[], stale = false, widgetFamily = 'systemSmall'): Node[] {
  const props: RipplesWidgetProps = { rows, stale };
  const tree = runtime.__expoWidgetRender(props, { widgetFamily }) as Node;
  const flatten = (node: Node): Node[] => [node, ...[node.props.children ?? []].flat().flatMap(flatten)];
  return flatten(tree);
}

function label(node: Node) {
  return node.props.modifiers?.find((modifier) => modifier.$type === 'accessibilityLabel')?.label;
}

describe('serialized widget layout', () => {
  it('renders Daily completion as binary and opens an explicit fresh-state action', () => {
    const nodes = render([row]);
    const circles = nodes.filter((node) => node.type === 'CircleView');
    expect(circles).toHaveLength(7);
    expect(circles.map((node) => node.props.modifiers?.find((item) => item.$type === 'opacity')?.value)).toEqual([0.25, 1, 1, 0.25, 0.25, 0.25, 1]);
    expect(nodes.find((node) => label(node) === 'Uncheck Reading')?.props.destination).toBe('habitsystem://boards/a/quick-action');
    expect(nodes.some((node) => node.props.systemName === 'checkmark.circle.fill')).toBe(true);
  });

  it('offers Check for an unchecked Daily and accepts older timeline rows without checkedToday', () => {
    expect(render([{ ...row, checkedToday: false }]).some((node) => label(node) === 'Check Reading')).toBe(true);
    const legacy = { ...row } as Partial<WidgetRowProps>;
    delete legacy.checkedToday;
    expect(render([legacy as WidgetRowProps]).some((node) => label(node) === 'Uncheck Reading')).toBe(true);
  });

  it('makes expired Daily state a neutral review action rather than an authoritative toggle', () => {
    const nodes = render([row], true);
    expect(nodes.find((node) => label(node) === 'Review Reading in Habit System')?.props.destination).toBe('habitsystem://boards/a/quick-action');
    expect(nodes.some((node) => node.props.systemName === 'arrow.clockwise')).toBe(true);
    expect(nodes.some((node) => node.props.systemName === 'checkmark.circle.fill')).toBe(false);
    expect(nodes.some((node) => label(node)?.startsWith('Saved history:'))).toBe(true);
  });

  it('preserves Count intensity and its Add Check-In fallback with widget provenance', () => {
    const nodes = render([{ ...row, kind: 'count' }]);
    const opacities = nodes.filter((node) => node.type === 'CircleView').map((node) => node.props.modifiers?.find((item) => item.$type === 'opacity')?.value);
    expect(opacities[1]).toBeCloseTo(0.6);
    expect(opacities[2]).toBe(1);
    expect(nodes.find((node) => label(node) === 'Check in to Reading')?.props.destination).toBe('habitsystem://boards/a/check-ins/new?source=widget');
  });

  it.each([['systemSmall', 1], ['systemMedium', 3], ['systemLarge', 7], ['systemExtraLarge', 12]] as const)('keeps ordered row budget for %s', (family, limit) => {
    const nodes = render(Array.from({ length: 15 }, (_, index) => ({ ...row, boardId: String(index) })), false, family);
    const destinations = nodes.filter((node) => node.type === 'LinkView' && label(node) === 'Reading').map((node) => node.props.destination);
    expect(destinations).toEqual(Array.from({ length: limit }, (_, index) => `habitsystem://boards/${index}`));
  });
});
