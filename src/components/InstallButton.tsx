'use client';
import { useI18n } from '@/lib/i18n';
import { usePwa } from '@/lib/pwa';

export default function InstallButton() {
  const { t } = useI18n();
  const { canInstall, ios, install } = usePwa();
  if (!canInstall && !ios) return null;
  return (
    <button className="lang" onClick={() => (canInstall ? install() : alert(t('ios_hint')))}>
      {t('install')}
    </button>
  );
}
