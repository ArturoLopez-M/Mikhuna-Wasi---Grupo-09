import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCognitoVerifier } from "../src/auth/cognito";

// Pruebas del verificador REAL (aws-jwt-verify) con claves generadas aquí:
// no usan internet ni un User Pool de verdad.
const REGION = "us-east-2";
const POOL = `${REGION}_AbCdEf123`;
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;
const CLIENT = "cliente-de-la-app";
const KID = "clave-1";

function newKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { n, e } = publicKey.export({ format: "jwk" });
  // JWK explícito: así TypeScript sabe que `kty` es siempre un string.
  const jwk = { kty: "RSA", n: n!, e: e!, kid, alg: "RS256", use: "sig" };
  return { jwk, privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) as string };
}

const b64 = (o: object | Buffer) =>
  Buffer.from(o instanceof Buffer ? o : JSON.stringify(o)).toString("base64url");

function sign(claims: Record<string, unknown>, privateKeyPem: string, kid = KID) {
  const header = b64({ alg: "RS256", kid, typ: "JWT" });
  const body = b64(claims);
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${body}`)
    .sign(createPrivateKey(privateKeyPem));
  return `${header}.${body}.${b64(signature)}`;
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({
  sub: "sub-123",
  iss: ISSUER,
  token_use: "access",
  client_id: CLIENT,
  scope: "aws.cognito.signin.user.admin",
  exp: now() + 3600,
  iat: now(),
});

const key = newKey(KID);
const verify = createCognitoVerifier(
  { userPoolId: POOL, clientId: CLIENT },
  { jwks: { keys: [key.jwk] } },
);

describe("createCognitoVerifier", () => {
  it("acepta un access token válido y devuelve el sub", async () => {
    const token = sign(goodClaims(), key.privateKey);

    await expect(verify(token)).resolves.toEqual({ sub: "sub-123" });
  });

  it("rechaza un ID token (token_use = id)", async () => {
    const token = sign({ ...goodClaims(), token_use: "id", aud: CLIENT }, key.privateKey);

    await expect(verify(token)).rejects.toThrow();
  });

  it("rechaza un token vencido", async () => {
    const token = sign({ ...goodClaims(), exp: now() - 60 }, key.privateKey);

    await expect(verify(token)).rejects.toThrow();
  });

  it("rechaza un token de otro User Pool (emisor distinto)", async () => {
    const other = `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_OtroPool99`;
    const token = sign({ ...goodClaims(), iss: other }, key.privateKey);

    await expect(verify(token)).rejects.toThrow();
  });

  it("rechaza un token de otra aplicación (client_id distinto)", async () => {
    const token = sign({ ...goodClaims(), client_id: "otra-app" }, key.privateKey);

    await expect(verify(token)).rejects.toThrow();
  });

  it("rechaza un token firmado con una clave que no es del pool", async () => {
    const attacker = newKey(KID); // mismo kid, otra clave privada
    const token = sign(goodClaims(), attacker.privateKey);

    await expect(verify(token)).rejects.toThrow();
  });

  it("rechaza un token con un kid desconocido", async () => {
    const token = sign(goodClaims(), key.privateKey, "kid-que-no-existe");

    await expect(verify(token)).rejects.toThrow();
  });

  it("rechaza un token con el payload alterado después de firmar", async () => {
    const token = sign(goodClaims(), key.privateKey);
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64({ ...goodClaims(), sub: "otro-usuario" })}.${s}`;

    await expect(verify(forged)).rejects.toThrow();
  });

  it("rechaza un token sin firma (alg none)", async () => {
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64(goodClaims())}.`;

    await expect(verify(unsigned)).rejects.toThrow();
  });

  it("rechaza basura que no es un JWT", async () => {
    await expect(verify("esto-no-es-un-jwt")).rejects.toThrow();
  });
});
