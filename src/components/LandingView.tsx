'use client';
import { useI18n } from '@/lib/i18n';
import { Icon } from './ui';

export default function LandingView() {
  const { t } = useI18n();

  return (
    <div className="landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-copy">
          <span className="landing-eyebrow">{t('landing_eyebrow')}</span>
          <h1 id="landing-title">{t('landing_title')}</h1>
          <p>{t('landing_intro')}</p>
          <div className="landing-actions">
            <a className="landing-primary" href="#auth">{t('landing_cta')}</a>
            <a className="landing-secondary" href="#how">{t('landing_how')}</a>
          </div>
          <div className="landing-highlights" role="group" aria-label={t('landing_highlights')}>
            <span><b>1 F</b> {t('landing_per_view')}</span>
            <span><b>500 F</b> {t('landing_min_withdrawal')}</span>
          </div>
        </div>

        <div className="landing-visual" aria-hidden="true">
          <div className="landing-orbit landing-orbit-one" />
          <div className="landing-orbit landing-orbit-two" />
          <div className="landing-phone">
            <div className="landing-phone-top"><span /><b>StatutPay</b><i>•••</i></div>
            <div className="landing-balance">
              <span>{t('bal')}</span>
              <b>1 250 F</b>
              <i>+120 F</i>
            </div>
            <div className="landing-activity">
              <span className="ic"><Icon n="a" /></span>
              <span><b>{t('landing_campaign')}</b><small>{t('st_active')}</small></span>
              <Icon n="share" />
            </div>
            <div className="landing-activity landing-activity-muted">
              <span className="ic"><Icon n="d" /></span>
              <span><b>{t('landing_view_approved')}</b><small>{t('views')}</small></span>
              <strong>+1 F</strong>
            </div>
          </div>
          <span className="landing-float landing-float-top">+1 F</span>
          <span className="landing-float landing-float-bottom"><i /> {t('st_active')}</span>
        </div>
      </section>

      <section className="landing-how" id="how" aria-labelledby="landing-how-title">
        <div className="landing-section-heading">
          <span className="landing-eyebrow landing-eyebrow-blue">{t('landing_how')}</span>
          <h2 id="landing-how-title">{t('landing_how_title')}</h2>
          <p>{t('landing_how_intro')}</p>
        </div>
        <div className="landing-roles">
          <article className="landing-role">
            <div className="landing-role-heading">
              <span className="ic"><Icon n="d" /></span>
              <h3>{t('landing_pub_title')}</h3>
            </div>
            <p>{t('landing_pub_intro')}</p>
            <ol>
              <li>{t('landing_pub_step1')}</li>
              <li>{t('landing_pub_step2')}</li>
              <li>{t('landing_pub_step3')}</li>
            </ol>
          </article>
          <article className="landing-role">
            <div className="landing-role-heading">
              <span className="ic"><Icon n="a" /></span>
              <h3>{t('landing_adv_title')}</h3>
            </div>
            <p>{t('landing_adv_intro')}</p>
            <ol>
              <li>{t('landing_adv_step1')}</li>
              <li>{t('landing_adv_step2')}</li>
              <li>{t('landing_adv_step3')}</li>
            </ol>
          </article>
        </div>
        <p className="landing-note">{t('landing_note')}</p>
      </section>

      <section className="landing-final" aria-labelledby="landing-final-title">
        <div>
          <h2 id="landing-final-title">{t('landing_final_title')}</h2>
          <p>{t('landing_final_text')}</p>
        </div>
        <a className="landing-primary" href="#auth">{t('landing_cta')}</a>
      </section>
    </div>
  );
}
