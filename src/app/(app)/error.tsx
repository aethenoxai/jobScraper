'use client';

import { ErrorPanel } from '@/components/error-panel';

/** Errors in an app page: shown inside the app layout, with the menu still there. */
export default function ErrorPage(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorPanel {...props} />;
}
