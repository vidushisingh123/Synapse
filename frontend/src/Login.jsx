import { useState } from 'react';

// Sign-in screen. It only collects credentials and hands them to `onSignIn` (App), which calls the
// existing POST /api/auth/login. There is no registration, no "forgot password" and no sample account:
// accounts are created by an administrator with the backend CLI scripts.
export default function Login({ onSignIn, notice }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSignIn(username, password);
    } catch (err) {
      setError(err?.message || 'Sign-in failed. Please try again.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const message = error || notice;

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit} aria-label="Sign in to Synapse">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" />
              <path d="M8 7.6l8 -1M7.2 8.8l3.6 7.2M16.8 8l-3.6 8" />
            </svg>
          </span>
          <div>
            <strong>Synapse</strong>
            <small>Sign in to continue</small>
          </div>
        </div>

        {message && (
          <div className={`banner ${error ? 'error' : 'warn'}`} role={error ? 'alert' : 'status'}>{message}</div>
        )}

        <label className="field">
          <span>Username</span>
          <input type="text" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
            maxLength={64} value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" name="password" autoComplete="current-password"
            maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        </label>

        <button type="submit" className="primary" disabled={busy}>{busy ? 'Signing in\u2026' : 'Sign in'}</button>
        <p className="muted auth-help">Accounts are created by an administrator.</p>
      </form>
    </main>
  );
}
