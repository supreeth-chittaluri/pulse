import { useEffect, useRef, useState } from 'react';
import { ApiError, api, setToken, type Role } from '../api.ts';

/**
 * Sign-in, plus the deliberately-refused signup.
 *
 * The signup path is not decorative: the server returns 403 with the
 * private-demo message and creates nothing. A form that appears to succeed and
 * silently does nothing would be worse than an honest refusal.
 */
export function AuthDialog({
  open,
  onClose,
  onSignedIn,
}: {
  open: boolean;
  onClose: () => void;
  onSignedIn: (role: Role, email: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('demo@pulse.local');
  const [password, setPassword] = useState('demo-read-only');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'signup') {
        await api.signup(email, password);
        setMessage('Signup unexpectedly succeeded.');
        return;
      }
      const result = await api.login(email, password);
      setToken(result.token);
      onSignedIn(result.role, result.email);
      onClose();
    } catch (error) {
      setMessage(
        error instanceof ApiError ? error.message : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-label="Sign in">
      <form onSubmit={submit}>
        <h2 style={{ margin: '0 0 0.15rem', fontSize: '1rem' }}>
          {mode === 'login' ? 'Sign in' : 'Create an account'}
        </h2>
        <p style={{ margin: '0 0 0.9rem', color: 'var(--ink-secondary)', fontSize: '0.82rem' }}>
          {mode === 'login'
            ? 'The demo account is read-only and pre-filled below.'
            : 'Public signup is disabled on this deployment.'}
        </p>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} required
                 onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} required
                 onChange={(e) => setPassword(e.target.value)} />
        </div>

        {message && (
          <p className={mode === 'signup' ? 'banner warn' : 'error'} style={{ marginTop: 0 }}>
            {message}
          </p>
        )}

        <div className="row" style={{ marginTop: '0.9rem' }}>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Sign up'}
          </button>
          <button type="button" onClick={onClose}>Cancel</button>
          <span className="spacer" />
          <button
            type="button"
            style={{ border: 0, background: 'none', color: 'var(--series)', padding: 0 }}
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setMessage(null);
            }}
          >
            {mode === 'login' ? 'Create account' : 'Back to sign in'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
