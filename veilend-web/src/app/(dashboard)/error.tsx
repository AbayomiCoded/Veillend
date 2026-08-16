'use client';

import ErrorFallback from '@/components/error/ErrorFallback';

interface DashboardGroupErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardGroupError({ error, reset }: DashboardGroupErrorProps) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      title="Dashboard Error"
      description="The dashboard could not be loaded. Please try again or return home."
    />
  );
}
