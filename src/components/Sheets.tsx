'use client';
import { useEffect } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { FAQ } from '@/lib/faq';
import { ADMIN, Profile } from '@/lib/types';

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sh"><h2 style={{ margin: 0, fontSize: 20 }}>{title}</h2><button className="s" onClick={onClose}>{t('close')}</button></div>
        {children}
      </div>
    </div>
  );
}

export function HelpSheet({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const { t, lang } = useI18n();
  const msg = t('help_msg') + (profile ? ' ' + profile.phone : '');
  return (
    <Sheet title={t('help')} onClose={onClose}>
      <a className="p" style={{ marginTop: 0, display: 'block' }} href={`https://wa.me/${ADMIN.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener noreferrer">{t('contact')}</a>
      <h2 style={{ marginTop: 18 }}>{t('faq_t')}</h2>
      {(FAQ[lang] ?? FAQ.fr).map((x) => (
        <details className="faq" key={x.q}><summary>{x.q}</summary><p>{x.a}</p></details>
      ))}
    </Sheet>
  );
}
