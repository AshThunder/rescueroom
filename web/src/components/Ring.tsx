// Timelock dial: tick ring that fills as a hold elapses. SVG, no gradients.
const TONES = { amber: '#e3a33b', green: '#4cc38a', red: '#e5484d', muted: '#80868f' } as const;

export function Ring({ size = 200, frac, ticks = 60, tone = 'amber', marker = true, children }: {
  size?: number; frac: number; ticks?: number; tone?: keyof typeof TONES; marker?: boolean; children?: React.ReactNode;
}) {
  const c = size / 2, ro = c - 1, w = Math.max(1.25, size / 140), lmin = size * 0.045, lmaj = size * 0.085;
  const col = TONES[tone];
  const on = Math.round(Math.max(0, Math.min(1, frac)) * ticks);
  const lines = Array.from({ length: ticks }, (_, i) => {
    const a = (i / ticks) * Math.PI * 2 - Math.PI / 2;
    const maj = i % 5 === 0, l = maj ? lmaj : lmin;
    return (
      <line key={i}
        x1={c + ro * Math.cos(a)} y1={c + ro * Math.sin(a)} x2={c + (ro - l) * Math.cos(a)} y2={c + (ro - l) * Math.sin(a)}
        stroke={i < on ? col : `rgba(232,234,238,${maj ? 0.22 : 0.12})`} strokeWidth={maj ? w * 1.3 : w} strokeLinecap="round" />
    );
  });
  const ri = ro - lmaj - size * 0.04;
  const a = frac * Math.PI * 2 - Math.PI / 2;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {lines}
        <circle cx={c} cy={c} r={ri} fill="none" stroke="rgba(232,234,238,.08)" />
        {marker && <circle cx={c + ri * Math.cos(a)} cy={c + ri * Math.sin(a)} r={Math.max(2, size / 70)} fill={col} />}
      </svg>
      <div className="in">{children}</div>
    </div>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 22 22" aria-hidden>
      <circle cx="11" cy="11" r="9" fill="none" stroke="#e8eaee" strokeWidth="1.5" />
      <path d="M11 2v4.5" stroke="#e3a33b" strokeWidth="2" strokeLinecap="round" />
      <circle cx="11" cy="11" r="2" fill="#e8eaee" />
    </svg>
  );
}
