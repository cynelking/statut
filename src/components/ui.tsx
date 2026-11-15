const PATHS: Record<string, string> = {
  d: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1"/>',
  a: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  m: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  p: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  x: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="M16 8l4 4-4 4M20 12H9"/>',
  img: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5-8 8"/>',
  vid: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  txt: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  f: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>',
  dl: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7"/><path d="M12 17h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
};

export function Icon({ n, fill = false }: { n: string; fill?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PATHS[n] ?? '' }} />
  );
}

export function Stats({ items }: { items: [string | number, string][] }) {
  return (
    <div className="stats">
      {items.map(([v, l]) => (
        <div className="stat" key={l}>
          <b>{v}</b>
          <span>{l}</span>
        </div>
      ))}
    </div>
  );
}

export function BarChart({ title, labels, values }: { title: string; labels: string[]; values: number[] }) {
  const w = 280, h = 90, bw = w / Math.max(values.length, 1), max = Math.max(1, ...values);
  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="m" style={{ marginBottom: 6 }}>{title}</figcaption>
      <svg viewBox={`0 0 ${w} ${h + 16}`} role="img" aria-label={title} style={{ width: '100%', height: 'auto' }}>
        {values.map((v, i) => {
          const bh = Math.round((v / max) * h);
          return (
            <rect key={i} x={i * bw + 2} y={h - (bh || 1)} width={bw - 4} height={bh || 1} rx={3} fill="var(--brand)" opacity={v ? 1 : 0.25}>
              <title>{labels[i]} : {v}</title>
            </rect>
          );
        })}
        <text x="0" y={h + 13} fontSize="9" fill="var(--mute)">{labels[0]}</text>
        <text x={w} y={h + 13} fontSize="9" textAnchor="end" fill="var(--mute)">{labels[labels.length - 1]}</text>
      </svg>
    </figure>
  );
}
