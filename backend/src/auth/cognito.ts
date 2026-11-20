import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Jwks } from "aws-jwt-verify/jwk";

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
}

// Verifica un token y devuelve el `sub` del usuario. Si el token no es válido,
// la promesa se rechaza (el middleware lo traduce a 401).
export type VerifyToken = (token: string) => Promise<{ sub: string }>;

// Contrato, sección 2: se acepta SOLO el access token de Cognito. La librería
// comprueba firma (contra las claves públicas del pool), emisor, vencimiento,
// que el token_use sea "access" y que el client_id sea el de nuestra app.
//
// `options.jwks` existe para las pruebas: permite darle claves locales y así
// no depender de internet ni de un User Pool real.
export function createCognitoVerifier(
  config: CognitoConfig,
  options: { jwks?: Jwks } = {},
): VerifyToken {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: "access",
    clientId: config.clientId,
  });

  if (options.jwks) verifier.cacheJwks(options.jwks);

  return async (token) => {
    const payload = await verifier.verify(token);
    return { sub: payload.sub };
  };
}
