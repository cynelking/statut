import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/manrope';
import '@fontsource-variable/sora';
import './globals.css';
import { I18n } from '@/lib/i18n';
import { PwaProvider } from '@/lib/pwa';

export const metadata: Metadata = {
  title: 'StatutPay',
  description: 'StatutPay met en relation annonceurs et diffuseurs pour promouvoir des campagnes sur les statuts WhatsApp.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'StatutPay', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  themeColor: '#2563EB',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <I18n><PwaProvider>{children}</PwaProvider></I18n>
      </body>
    </html>
  );
}
