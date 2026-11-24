// Cliente mínimo de Amazon Cognito (API de User Pools) con fetch, sin
// librerías. Usa el flujo USER_PASSWORD_AUTH (la contraseña viaja por HTTPS
// directo a Cognito, nunca a nuestro backend) y REFRESH_TOKEN_AUTH.
// El App Client debe tener habilitados ALLOW_USER_PASSWORD_AUTH y
// ALLOW_REFRESH_TOKEN_AUTH, y no tener secreto (cliente público).

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  // Momento (ms) en que vence el access token.
  expiresAt: number;
}

export type SignInResult =
  | { kind: "ok"; tokens: Tokens }
  // Usuario creado a mano en Cognito: debe cambiar la contraseña temporal.
  | { kind: "new_password"; session: string; username: string };

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

interface AuthenticationResult {
  AccessToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
}

interface CognitoResponse {
  AuthenticationResult?: AuthenticationResult;
  ChallengeName?: string;
  Session?: string;
}

// Mensajes en español. No se distingue "usuario no existe" de "contraseña
// incorrecta" para no revelar qué usuarios existen.
function toAuthError(type: string, message: string): AuthError {
  const code = type.split("#").pop() ?? type;
  if (code === "NotAuthorizedException" && /attempts exceeded/i.test(message)) {
    return new AuthError(code, "Demasiados intentos fallidos. Espera un momento y vuelve a intentar.");
  }
  if (code === "NotAuthorizedException" || code === "UserNotFoundException") {
    return new AuthError(code, "Usuario o contraseña incorrectos.");
  }
  if (code === "InvalidPasswordException") {
    return new AuthError(code, "La contraseña nueva no cumple la política de seguridad.");
  }
  if (code === "PasswordResetRequiredException") {
    return new AuthError(code, "Debes restablecer tu contraseña. Pide ayuda al administrador.");
  }
  return new AuthError(code, "No se pudo iniciar sesión. Intenta de nuevo.");
}

function toTokens(r: AuthenticationResult, now: number, refreshToken?: string): Tokens {
  return {
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken ?? refreshToken,
    expiresAt: now + r.ExpiresIn * 1000,
  };
}

export interface CognitoClientOptions {
  region: string;
  clientId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createCognitoClient(opts: CognitoClientOptions) {
  const doFetch = opts.fetch ?? fetch.bind(globalThis);
  const now = opts.now ?? Date.now;
  const endpoint = `https://cognito-idp.${opts.region}.amazonaws.com/`;

  async function call(target: string, body: unknown): Promise<CognitoResponse> {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AuthError("NetworkError", "Sin conexión con el servicio de inicio de sesión.");
    }
    const data = (await res.json().catch(() => ({}))) as CognitoResponse & {
      __type?: string;
      message?: string;
    };
    if (!res.ok) throw toAuthError(data.__type ?? "Unknown", data.message ?? "");
    return data;
  }

  return {
    async signIn(username: string, password: string): Promise<SignInResult> {
      const data = await call("InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: opts.clientId,
        AuthParameters: { USERNAME: username, PASSWORD: password },
      });
      if (data.ChallengeName === "NEW_PASSWORD_REQUIRED" && data.Session) {
        return { kind: "new_password", session: data.Session, username };
      }
      if (!data.AuthenticationResult) {
        throw new AuthError("UnsupportedChallenge", "Este tipo de inicio de sesión no está soportado.");
      }
      return { kind: "ok", tokens: toTokens(data.AuthenticationResult, now()) };
    },

    async completeNewPassword(username: string, newPassword: string, session: string): Promise<Tokens> {
      const data = await call("RespondToAuthChallenge", {
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: opts.clientId,
        Session: session,
        ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword },
      });
      if (!data.AuthenticationResult) {
        throw new AuthError("UnsupportedChallenge", "No se pudo cambiar la contraseña.");
      }
      return toTokens(data.AuthenticationResult, now());
    },

    // Cognito no devuelve un refresh token nuevo: se conserva el anterior.
    async refresh(refreshToken: string): Promise<Tokens> {
      const data = await call("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: opts.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });
      return toTokens(data.AuthenticationResult!, now(), refreshToken);
    },

    // Invalida los tokens en Cognito. Si falla (sin red), igual se cierra la
    // sesión en el navegador.
    async signOut(accessToken: string): Promise<void> {
      try {
        await call("GlobalSignOut", { AccessToken: accessToken });
      } catch {
        // sin acción
      }
    },
  };
}

export type CognitoClient = ReturnType<typeof createCognitoClient>;
