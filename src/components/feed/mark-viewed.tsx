'use client';

import { useEffect } from 'react';
import { markMatchViewed } from '@/app/feed/actions';

/** Marks a match as seen once it is actually shown (never during server rendering or prefetching). */
export function MarkViewed({ matchId }: { matchId: number }) {
  useEffect(() => {
    void markMatchViewed(matchId);
  }, [matchId]);
  return null;
}
