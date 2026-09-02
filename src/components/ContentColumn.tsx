import type { PropsWithChildren } from 'react';

/** Shared horizontal rhythm for the transcript and composer surfaces. */
export function ContentColumn({ children, className = '' }: PropsWithChildren<{
  className?: string;
}>) {
  return (
    <div className={`mx-auto w-full max-w-3xl px-3 sm:px-6 ${className}`}>
      {children}
    </div>
  );
}
