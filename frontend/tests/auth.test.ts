import { describe, expect, it, vi } from "vitest";
import { AuthError, createCognitoClient } from "../src/auth/cognito";
import { createSession } from "../src/auth/session";

// Respuesta falsa de Cognito.
const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, now = () => 1_000) {
  return createCognitoClient({ region: "us-east-2", clientId: "cliente", fetch: fetchImpl as typeof fetch, now });
}

describe("cliente de Cognito", () => {
  it("inicia sesión con USER_PASSWORD_AUTH y calcula el vencimiento", async () => {
    const f = vi.fn((_url: string, _init: RequestInit) =>
      reply(200, { AuthenticationResult: { AccessToken: "a", RefreshToken: "r", ExpiresIn: 300 } }),
    );
    const res = await client(f).signIn("ana", "secreta");

    expect(res).toEqual({ kind: "ok", tokens: { accessToken: "a", refreshToken: "r", expiresAt: 301_000 } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://cognito-idp.us-east-2.amazonaws.com/");
    expect((init.headers as Record<string, string>)["X-Amz-Target"]).toBe(
      "AWSCognitoIdentityProviderService.InitiateAuth",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "cliente",
      AuthParameters: { USERNAME: "ana", PASSWORD: "secreta" },
    });
  });

  it("primer ingreso: pide contraseña nueva y luego responde el desafío", async () => {
    const f = vi
      .fn()
      .mockReturnValueOnce(reply(200, { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s1" }))
      .mockReturnValueOnce(reply(200, { AuthenticationResult: { AccessToken: "a2", ExpiresIn: 300 } }));
    const c = client(f);

    expect(await c.signIn("ana", "temporal")).toEqual({ kind: "new_password", session: "s1", username: "ana" });
    const tokens = await c.completeNewPassword("ana", "Nueva-123", "s1");

    expect(tokens.accessToken).toBe("a2");
    expect(JSON.parse(String(f.mock.calls[1]![1].body))).toMatchObject({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: "s1",
      ChallengeResponses: { USERNAME: "ana", NEW_PASSWORD: "Nueva-123" },
    });
  });

  it.each([
    ["NotAuthorizedException", "Incorrect username or password.", "Usuario o contraseña incorrectos."],
    ["UserNotFoundException", "User does not exist.", "Usuario o contraseña incorrectos."],
    ["NotAuthorizedException", "Password attempts exceeded", "Demasiados intentos fallidos. Espera un momento y vuelve a intentar."],
  ])("%s se muestra en español sin revelar si el usuario existe", async (type, message, expected) => {
    const c = client(() => reply(400, { __type: type, message }));
    await expect(c.signIn("x", "y")).rejects.toThrow(new AuthError(type, expected));
  });

  it("sin red da un error claro", async () => {
    const c = client(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(c.signIn("x", "y")).rejects.toThrow("Sin conexión con el servicio de inicio de sesión.");
  });

  it("al renovar conserva el refresh token anterior", async () => {
    const c = client(() => reply(200, { AuthenticationResult: { AccessToken: "nuevo", ExpiresIn: 300 } }));
    expect((await c.refresh("r-viejo")).refreshToken).toBe("r-viejo");
  });
});

describe("sesión", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it("usa el access token mientras le quede más de 1 minuto", async () => {
    let t = 0;
    const refresh = vi.fn();
    const s = createSession({ refresh } as never, memory(), () => t);
    s.start({ accessToken: "a", refreshToken: "r", expiresAt: 300_000 });

    t = 200_000;
    expect(await s.getAccessToken()).toBe("a");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("lo renueva cuando está por vencer, una sola vez aunque lo pidan varios", async () => {
    let t = 0;
    const refresh = vi.fn(async () => ({ accessToken: "b", refreshToken: "r", expiresAt: 900_000 }));
    const s = createSession({ refresh } as never, memory(), () => t);
    s.start({ accessToken: "a", refreshToken: "r", expiresAt: 300_000 });

    t = 260_000;
    const tokens = await Promise.all([s.getAccessToken(), s.getAccessToken(), s.getAccessToken()]);
    expect(tokens).toEqual(["b", "b", "b"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("al recargar la página recupera la sesión con el refresh token guardado", async () => {
    const store = memory();
    store.setItem("mikhuna.refresh", "r-guardado");
    const refresh = vi.fn(async () => ({ accessToken: "c", refreshToken: "r-guardado", expiresAt: 9e12 }));
    const s = createSession({ refresh } as never, store);

    expect(s.hasSession()).toBe(true);
    expect(await s.getAccessToken()).toBe("c");
    expect(refresh).toHaveBeenCalledWith("r-guardado");
  });

  it("si la renovación falla, borra la sesión", async () => {
    const store = memory();
    const s = createSession({ refresh: vi.fn(async () => Promise.reject(new Error("vencido"))) } as never, store, () => 0);
    s.start({ accessToken: "a", refreshToken: "r", expiresAt: 10 });

    await expect(s.getAccessToken()).rejects.toThrow("vencido");
    expect(s.hasSession()).toBe(false);
  });

  it("cerrar sesión borra todo y la invalida en Cognito", async () => {
    const store = memory();
    const signOut = vi.fn(async () => {});
    const s = createSession({ signOut } as never, store);
    s.start({ accessToken: "a", refreshToken: "r", expiresAt: 9e12 });

    await s.signOut();
    expect(signOut).toHaveBeenCalledWith("a");
    expect(store.m.size).toBe(0);
    expect(s.hasSession()).toBe(false);
  });
});
