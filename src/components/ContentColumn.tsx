import type { PropsWithChildren } from 'react';
import './ContentColumn.css';

/** Shared horizontal rhythm for the transcript and composer surfaces. */
export function ContentColumn({ children, className = '' }: PropsWithChildren<{
  className?: string;
}>) {
  return (
    <div className={`content-column ${className}`}>
      {children}
    </div>
  );
}
