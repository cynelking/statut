'use client';
import { useEffect } from 'react';

const REVEAL_SELECTOR = '.card, .hero, .banner, .ad, .kpi, .stats, .chipsf';

export default function ScrollEffects() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const main = document.querySelector('main');
    if (!main) return;

    const root = document.documentElement;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in-view');
          observer.unobserve(entry.target);
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -24px 0px' });

    const reveal = () => {
      main.querySelectorAll<HTMLElement>(REVEAL_SELECTOR).forEach((element) => {
        if (element.dataset.scrollReveal) return;
        element.dataset.scrollReveal = 'true';
        element.classList.add('scroll-reveal');
        observer.observe(element);
      });
    };

    reveal();
    const mutations = new MutationObserver(reveal);
    mutations.observe(main, { childList: true, subtree: true });

    let frame = 0;
    const updateParallax = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const scene = main.querySelector<HTMLElement>('.scroll-scene');
        if (!scene) return;
        const rect = scene.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;
        const progress = Math.max(-1, Math.min(1,
          ((window.innerHeight - rect.top) / (window.innerHeight + rect.height)) * 2 - 1));
        scene.style.setProperty('--phone-y', `${(-progress * 10).toFixed(1)}px`);
        scene.style.setProperty('--ad-x', `${(progress * 9).toFixed(1)}px`);
        scene.style.setProperty('--coin-y', `${(progress * 14).toFixed(1)}px`);
        scene.style.setProperty('--icon-y', `${(-progress * 16).toFixed(1)}px`);
      });
    };

    root.classList.add('has-scroll-motion');
    window.addEventListener('scroll', updateParallax, { passive: true });
    window.addEventListener('resize', updateParallax);
    updateParallax();

    return () => {
      root.classList.remove('has-scroll-motion');
      mutations.disconnect();
      observer.disconnect();
      window.removeEventListener('scroll', updateParallax);
      window.removeEventListener('resize', updateParallax);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
