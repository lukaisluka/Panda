import { useState } from 'react';
import { ChevronDown, PlayCircle } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { navigate } from '../routes';
import { useI18n } from '../i18n/context';
import './EmptyState.css';

/** First-run onboarding (#200): with no foreground live session the main
 * column shows the three ways in — the scripted demo (production-
 * reachable, #196), connecting your own agent (the core audience), and a
 * collapsed path for existing-agent users. Pure static chrome: no protocol
 * surface, nothing lazy-loaded. Doc links target GitHub (the Pages deploy
 * ships the app only); per-locale URLs pick the matching mirror. */
export function EmptyState() {
  const { t } = useI18n();
  const [existingOpen, setExistingOpen] = useState(false);
  return (
    <div className="empty-state">
      <section className="empty-state-card">
        <div className="empty-state-intro">
          <h1 className="empty-state-title">{t('empty.title')}</h1>
          <p className="empty-state-lead">{t('empty.lead')}</p>
          <Button
            variant="primary"
            icon={<PlayCircle size={16} />}
            label={t('empty.watchDemo')}
            clickAction={() => navigate('demo')}
          />
        </div>
        <div className="empty-state-section">
          <h2 className="empty-state-heading">{t('empty.connectHeading')}</h2>
          <div className="empty-state-step">
            <p className="empty-state-step-kicker">{t('empty.desktopKicker')}</p>
            <p className="empty-state-step-body">
              {t('empty.desktopBody')}{' '}
              <a href={t('empty.quickstartUrl')} target="_blank" rel="noreferrer">
                {t('empty.quickstartLink')}
              </a>
            </p>
          </div>
          <div className="empty-state-step">
            <p className="empty-state-step-kicker">{t('empty.webKicker')}</p>
            <p className="empty-state-step-body">
              {t('empty.webBody')}{' '}
              <a href={t('empty.bridgeUrl')} target="_blank" rel="noreferrer">
                {t('empty.bridgeLink')}
              </a>
            </p>
          </div>
        </div>
        <div className="empty-state-more">
          <button
            type="button"
            className="empty-state-more-toggle"
            aria-expanded={existingOpen}
            onClick={() => setExistingOpen((open) => !open)}
          >
            {t('empty.existingToggle')}
            <ChevronDown
              size={14}
              className={existingOpen ? 'empty-state-chevron empty-state-chevron--open' : 'empty-state-chevron'}
            />
          </button>
          {existingOpen && (
            <p className="empty-state-step-body">
              {t('empty.existingBody')}{' '}
              <a href={t('empty.userGuideUrl')} target="_blank" rel="noreferrer">
                {t('empty.userGuideLink')}
              </a>
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
