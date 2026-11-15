'use client';
import { Lang, availableLangs, useI18n } from '@/lib/i18n';

export default function LangSelect() {
  const { lang, setLang, t } = useI18n();
  return (
    <select className="lang" aria-label={t('lang_l')} value={lang} onChange={(e) => setLang(e.target.value as Lang)} style={{ minHeight: 0, width: 'auto' }}>
      {availableLangs().map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
    </select>
  );
}
