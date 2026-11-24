import { type FormEvent, useState } from "react";
import { AuthError, type CognitoClient, type Tokens } from "./cognito";

interface Props {
  cognito: CognitoClient;
  onSignedIn: (tokens: Tokens) => void;
  notice?: string;
}

// Inicio de sesión con Cognito. Si el usuario entra con una contraseña
// temporal (lo crearon a mano), se le pide una nueva.
export function LoginPage({ cognito, onSignedIn, notice }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [challenge, setChallenge] = useState<{ session: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        onSignedIn(await cognito.completeNewPassword(username, newPassword, challenge.session));
        return;
      }
      const res = await cognito.signIn(username.trim(), password);
      if (res.kind === "new_password") setChallenge({ session: res.session });
      else onSignedIn(res.tokens);
    } catch (err) {
      setError(err instanceof AuthError ? err.message : "No se pudo iniciar sesión.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <h1>Mikhuna Wasi</h1>
        {notice && <p className="notice">{notice}</p>}
        {!challenge ? (
          <>
            <label>
              Usuario o correo
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
            </label>
            <label>
              Contraseña
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
          </>
        ) : (
          <>
            <p>Es tu primer ingreso: elige una contraseña nueva.</p>
            <label>
              Contraseña nueva
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Ingresando..." : challenge ? "Guardar contraseña" : "Ingresar"}
        </button>
      </form>
    </main>
  );
}
