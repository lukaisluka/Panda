import { useEffect } from 'react';
import { useToast } from '@astryxdesign/core/Toast';
import { Button } from '@astryxdesign/core/Button';
import { subscribeUserNotices } from '../userNotice';

/**
 * Bridges the non-React notice bus (#160) onto Astryx toasts. Mounted once
 * in the app shell; the toast viewport self-mounts (useToast works without
 * a provider). Errors stay until dismissed — an operation failure the user
 * cannot see again is the bug this component exists to fix.
 */
export function UserNoticeToasts() {
  const toast = useToast();
  useEffect(
    () =>
      subscribeUserNotices((notice) => {
        toast({
          body: notice.message,
          type: notice.kind === 'error' ? 'error' : 'info',
          // The recovery action (#217) rides the trailing slot: a failed
          // switch offers Retry right where the failure was announced.
          endContent: notice.action ? (
            <Button
              size="sm"
              variant="secondary"
              label={notice.action.label}
              clickAction={notice.action.run}
            />
          ) : undefined,
        });
      }),
    // useToast returns a stable imperative fn; the subscription must bind
    // exactly once or every notice would fan out to N stale closures.
    [toast],
  );
  return null;
}
