import type { ReactNode } from 'react';
import { AlertTriangle, Inbox } from 'lucide-react';

export function Card({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title !== undefined && (
        <header className="chead">
          <h3>{title}</h3>
          {aside && <div className="row gap8 small t3">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

type Tone = 'a' | 'g' | 'r' | undefined;
export function Tag({ tone, children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`tag ${tone || ''}`}>
      {dot && <span className={`dot ${tone || ''}`} />}
      {children}
    </span>
  );
}

export function Mock({ children = 'sample data' }: { children?: ReactNode }) {
  return <span className="mock" title="Not wired to the testnet contract yet">{children}</span>;
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="state" role="status">
      {icon || <Inbox className="ic" aria-hidden />}
      <div className="h3" style={{ color: 'var(--t1)' }}>{title}</div>
      {children && <div className="cap">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="state err" role="alert">
      <AlertTriangle className="ic" aria-hidden />
      <div className="h3" style={{ color: 'var(--t1)' }}>Could not reach NEAR testnet</div>
      <div className="cap mono">{error}</div>
      {onRetry && <button className="btn sm mt8" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skel" style={{ height: h, width: w }} aria-hidden />;
}

export function LoadingCards({ n = 3 }: { n?: number }) {
  return (
    <div className="grid g3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="card pad stack g12">
          <Skeleton w="40%" />
          <Skeleton h={32} w="60%" />
          <Skeleton h={8} />
        </div>
      ))}
    </div>
  );
}

export function Bar({ frac, tone = 'var(--t2)' }: { frac: number; tone?: string }) {
  const f = Math.max(0, Math.min(1, frac));
  return (
    <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)}>
      <i style={{ width: `${f * 100}%`, background: tone }} />
    </div>
  );
}

export function Kv({ k, children, tight }: { k: ReactNode; children: ReactNode; tight?: boolean }) {
  return (
    <div className={`kv ${tight ? 'tight' : ''}`}>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="link" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** One header for every page: optional breadcrumb and eyebrow, title, one-line summary, actions on the right. */
export function PageHeader({ title, sub, actions, crumb, eyebrow }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; crumb?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="phead-wrap">
      {crumb && <nav className="crumb small" aria-label="Breadcrumb">{crumb}</nav>}
      <div className="phead">
        <div className="phead-txt">
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h1 className="ptitle">{title}</h1>
          {sub && <p className="psub">{sub}</p>}
        </div>
        {actions && <div className="phead-act">{actions}</div>}
      </div>
    </header>
  );
}
