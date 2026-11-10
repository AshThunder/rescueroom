// Minimal toasts: polite live region, auto-dismiss, keyboard dismissible. Flat surfaces only.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

type Tone = 'ok' | 'err' | 'info';
interface Toast { id: number; tone: Tone; title: string; body?: ReactNode; ttl: number }
interface ToastApi { push: (t: { tone?: Tone; title: string; body?: ReactNode; ttl?: number }) => void }

const Ctx = createContext<ToastApi>({ push: () => {} });
export const useToast = () => useContext(Ctx);

let seq = 0;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const close = useCallback((id: number) => setList((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback<ToastApi['push']>(
    ({ tone = 'info', title, body, ttl = tone === 'err' ? 9000 : 5000 }) => {
      const id = ++seq;
      setList((l) => [...l.slice(-3), { id, tone, title, body, ttl }]);
      if (ttl > 0) setTimeout(() => close(id), ttl);
    },
    [close],
  );
  const api = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {list.map((t) => {
          const Icon = t.tone === 'ok' ? CircleCheck : t.tone === 'err' ? CircleAlert : Info;
          return (
            <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'err' ? 'alert' : 'status'}>
              <Icon className="ic" aria-hidden />
              <div className="grow">
                <div className="tt">{t.title}</div>
                {t.body && <div className="tb">{t.body}</div>}
              </div>
              <button className="tx" aria-label="Dismiss notification" onClick={() => close(t.id)}><X className="ic" /></button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
