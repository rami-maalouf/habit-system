import { useEffect, useRef, useState } from 'react';

import { readBoardLayout, writeBoardLayout, type BoardLayout } from '@/platform/board-layout';
import { useProduct } from '../product-store';

export type { BoardLayout } from '@/platform/board-layout';
const sampleLayouts = new WeakMap<object, BoardLayout>();

export function useBoardLayout() {
  const { core, scope } = useProduct();
  const [layout, setLayout] = useState<BoardLayout>('compact');
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const read = scope.kind === 'sample' ? Promise.resolve(sampleLayouts.get(core) ?? 'compact') : readBoardLayout();
    void read.then(value => {
      if (cancelled) return;
      setLayout(value === 'cards' || value === 'grid' || value === 'summary' ? value : 'compact');
      setReady(true);
    }, () => {
      if (!cancelled) { setError('Could not load your layout. Choose a layout to try again.'); setReady(true); }
    });
    return () => { cancelled = true; };
  }, [core, scope.kind]);

  async function select(next: BoardLayout) {
    if (!ready || saving.current || !scope.isCurrent() || (next === layout && error === null)) return;
    saving.current = true;
    setPending(true); setError(null);
    const previous = layout;
    setLayout(next);
    try {
      if (scope.kind === 'sample') sampleLayouts.set(core, next);
      else await writeBoardLayout(next);
    } catch {
      if (mounted.current) { setLayout(previous); setError('Could not save your layout. Try again.'); }
    } finally {
      saving.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return { layout, select, ready, pending, error };
}
