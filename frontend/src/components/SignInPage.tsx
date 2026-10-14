// Sign-in (D-022). The password goes only to the same-origin /auth/login; the session is an HttpOnly cookie that
// this code never sees or stores.
import { useState, type FormEvent } from "react";
import { ApiError, api, type AuthSession } from "../api/client";
import { DisclaimerFooter } from "./Chrome";

export function SignInPage({ accountsConfigured, onSignedIn }: {
  accountsConfigured: boolean; onSignedIn: (session: AuthSession) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(username, password));
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null;
      setError(body?.error_code === "RATE_LIMITED" ? "Too many failed attempts. Wait a minute and try again."
        : body?.error_code === "INVALID_CREDENTIALS" ? "Wrong username or password."
          : "Sign-in is unavailable right now. Check that the backend is running.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">
      <main className="flex flex-1 items-center justify-center p-4">
        <form onSubmit={(e) => void submit(e)} data-testid="sign-in"
              className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="text-center">
            <p className="text-2xl font-extrabold tracking-[0.25em]">NOVARION</p>
            <p className="mt-1 text-sm font-medium text-slate-600">Coronary case review</p>
            <p className="mt-3 text-sm text-slate-700">
              Estimates CAD and LAD, LCX and RCA stenosis from routine clinical measurements and shows them on a 3D heart,
              with the reasons. An educational research prototype.
            </p>
          </div>
          {!accountsConfigured && (
            <p role="alert" className="rounded bg-amber-50 p-2 text-sm text-amber-900">
              No accounts exist yet. Create one with <code>uv run python scripts/users.py add NAME</code> and restart the backend.
            </p>
          )}
          <label className="block text-sm font-semibold">
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required
                   autoFocus data-testid="sign-in-username"
                   className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" />
          </label>
          <label className="block text-sm font-semibold">
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
                   autoComplete="current-password" data-testid="sign-in-password"
                   className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" />
          </label>
          {error && <p role="alert" className="text-sm font-medium text-red-700" data-testid="sign-in-error">{error}</p>}
          <button type="submit" disabled={busy} data-testid="sign-in-submit"
                  className="w-full rounded-lg bg-slate-900 py-2.5 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
      <DisclaimerFooter />
    </div>
  );
}
