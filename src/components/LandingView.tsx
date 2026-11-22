'use client';
import Image from 'next/image';
import { useI18n } from '@/lib/i18n';
import { VIEW_RATE } from '@/lib/types';
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
            <span><b>{VIEW_RATE} F</b> {t('landing_per_view')}</span>
            <span><b>200 F</b> {t('landing_min_withdrawal')}</span>
          </div>
        </div>

        <div className="landing-visual">
          <Image
            src="/statutpay-gains.png"
            alt={t('landing_image_alt')}
            fill
            priority
            sizes="(max-width: 620px) 100vw, 40vw"
          />
        </div>
      </section>

      <section className="landing-benefits" aria-labelledby="landing-benefits-title">
        <div className="landing-benefits-copy">
          <span className="landing-eyebrow landing-eyebrow-blue">{t('landing_benefits_eyebrow')}</span>
          <h2 id="landing-benefits-title">{t('landing_benefits_title')}</h2>
          <p>{t('landing_benefits_intro')}</p>
          <ul className="landing-benefits-list">
            <li>{t('landing_benefits_item1')}</li>
            <li>{t('landing_benefits_item2')}</li>
            <li>{t('landing_benefits_item3')}</li>
          </ul>
          <a className="landing-benefits-cta" href="#auth">{t('landing_benefits_cta')}</a>
        </div>
        <div className="landing-benefits-visual">
          <Image
            src="/statutpay-annonceurs.png"
            alt={t('landing_benefits_image_alt')}
            fill
            sizes="(max-width: 620px) 100vw, 55vw"
          />
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

      <section className="landing-benefits landing-withdrawals" aria-labelledby="landing-withdrawals-title">
        <div className="landing-benefits-visual">
          <Image
            src="/statutpay-annonceurs.png"
            alt={t('landing_withdrawals_image_alt')}
            fill
            sizes="(max-width: 620px) 100vw, 55vw"
          />
        </div>
        <div className="landing-benefits-copy">
          <span className="landing-eyebrow landing-eyebrow-blue">{t('landing_withdrawals_eyebrow')}</span>
          <h2 id="landing-withdrawals-title">{t('landing_withdrawals_title')}</h2>
          <p>{t('landing_withdrawals_intro')}</p>
          <ul className="landing-benefits-list">
            <li>{t('landing_withdrawals_item1')}</li>
            <li>{t('landing_withdrawals_item2')}</li>
            <li>{t('landing_withdrawals_item3')}</li>
          </ul>
          <a className="landing-benefits-cta" href="#auth">{t('landing_withdrawals_cta')}</a>
        </div>
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
