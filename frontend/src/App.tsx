import { useCallback, useMemo, useState } from "react";
import { createCognitoClient, type Tokens } from "./auth/cognito";
import { LoginPage } from "./auth/LoginPage";
import { createSession } from "./auth/session";
import { useIdleLogout } from "./auth/useIdleLogout";
import { config, IDLE_LOGOUT_MS } from "./config";
import { Shell } from "./Shell";

function safeSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function App() {
  const cognito = useMemo(
    () => createCognitoClient({ region: config.cognitoRegion, clientId: config.cognitoClientId }),
    [],
  );
  const session = useMemo(() => createSession(cognito, safeSessionStorage()), [cognito]);
  const [signedIn, setSignedIn] = useState(() => session.hasSession());
  const [notice, setNotice] = useState<string | undefined>();

  const signIn = (tokens: Tokens) => {
    session.start(tokens);
    setNotice(undefined);
    setSignedIn(true);
  };

  const signOut = useCallback(
    async (reason?: string) => {
      await session.signOut();
      setNotice(reason);
      setSignedIn(false);
    },
    [session],
  );

  const onIdle = useCallback(() => void signOut("Se cerró tu sesión por inactividad."), [signOut]);
  useIdleLogout(onIdle, IDLE_LOGOUT_MS, signedIn);

  if (!signedIn) return <LoginPage cognito={cognito} onSignedIn={signIn} notice={notice} />;
  return <Shell session={session} onSignOut={signOut} />;
}
