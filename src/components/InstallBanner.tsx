'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePwa } from '@/lib/pwa';
import { Icon } from './ui';

export default function InstallBanner() {
  const { t } = useI18n();
  const { canInstall, ios, install } = usePwa();
  const [hidden, setHidden] = useState(true);
  useEffect(() => { setHidden(localStorage.getItem('pwa-dismissed') === '1'); }, []);
  if (hidden || (!canInstall && !ios)) return null;
  return (
    <div className="banner" role="region" aria-label={t('ib_t')}>
      <i className="ic"><Icon n="dl" /></i>
      <div><b>{t('ib_t')}</b><span className="m">{canInstall ? t('ib_s') : t('ios_hint')}</span></div>
      {canInstall && <button className="p" onClick={() => install()}>{t('install')}</button>}
      <button className="s" onClick={() => { localStorage.setItem('pwa-dismissed', '1'); setHidden(true); }}>{t('ib_no')}</button>
    </div>
  );
}
