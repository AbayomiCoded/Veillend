'use client';

import ErrorFallback from '@/components/error/ErrorFallback';

interface RootErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RootError({ error, reset }: RootErrorProps) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      title="Something went wrong"
      description="We encountered an unexpected error. Try again, or report the issue if it keeps happening."
    />
  );
}
