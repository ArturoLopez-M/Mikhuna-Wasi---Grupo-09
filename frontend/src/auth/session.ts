import type { CognitoClient, Tokens } from "./cognito";

// Guarda la sesión y entrega siempre un access token vigente. El access token
// dura poco (5 min según el informe): se renueva solo cuando le queda menos de
// 1 minuto. Solo el refresh token se guarda en sessionStorage, para no perder
// la sesión al recargar la pestaña; se borra al cerrar la pestaña.
const REFRESH_KEY = "mikhuna.refresh";
const RENEW_BEFORE_MS = 60 * 1000;

export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createSession(
  cognito: CognitoClient,
  store: SessionStore | undefined,
  now: () => number = Date.now,
) {
  let tokens: Tokens | null = null;
  let renewing: Promise<Tokens> | null = null;

  const save = (t: Tokens) => {
    tokens = t;
    try {
      if (t.refreshToken) store?.setItem(REFRESH_KEY, t.refreshToken);
    } catch {
      // almacenamiento no disponible: la sesión dura lo que dure la página
    }
  };

  const clear = () => {
    tokens = null;
    try {
      store?.removeItem(REFRESH_KEY);
    } catch {
      // sin acción
    }
  };

  const savedRefresh = (): string | null => {
    try {
      return store?.getItem(REFRESH_KEY) ?? null;
    } catch {
      return null;
    }
  };

  return {
    start: save,

    // Hay sesión si hay tokens en memoria o un refresh token guardado.
    hasSession(): boolean {
      return tokens !== null || savedRefresh() !== null;
    },

    async getAccessToken(): Promise<string> {
      if (tokens && tokens.expiresAt - now() > RENEW_BEFORE_MS) return tokens.accessToken;

      const refreshToken = tokens?.refreshToken ?? savedRefresh();
      if (!refreshToken) throw new Error("Sin sesión");

      // Si varias peticiones piden el token a la vez, se renueva una sola vez.
      renewing ??= cognito.refresh(refreshToken).finally(() => {
        renewing = null;
      });
      try {
        const fresh = await renewing;
        save(fresh);
        return fresh.accessToken;
      } catch (err) {
        clear();
        throw err;
      }
    },

    async signOut(): Promise<void> {
      const access = tokens?.accessToken;
      clear();
      if (access) await cognito.signOut(access);
    },
  };
}

export type Session = ReturnType<typeof createSession>;
