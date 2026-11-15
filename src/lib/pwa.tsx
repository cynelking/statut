'use client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
interface Value { canInstall: boolean; ios: boolean; install: () => Promise<void> }

const Ctx = createContext<Value>({ canInstall: false, ios: false, install: async () => {} });

export function PwaProvider({ children }: { children: ReactNode }) {
  const [ev, setEv] = useState<InstallEvent | null>(null);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const onPrompt = (e: Event) => { e.preventDefault(); setEv(e as InstallEvent); };
    const onInstalled = () => { setEv(null); setIos(false); };
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone;
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!ev) return;
    await ev.prompt();
    await ev.userChoice;
    setEv(null);
  }, [ev]);

  return <Ctx.Provider value={{ canInstall: ev !== null, ios, install }}>{children}</Ctx.Provider>;
}

export const usePwa = () => useContext(Ctx);
