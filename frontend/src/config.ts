// Configuración leída en el build (variables VITE_*, ver .env.example).
export const config = {
  apiUrl: import.meta.env.VITE_API_URL ?? "",
  wsUrl: import.meta.env.VITE_WS_URL ?? "",
  cognitoRegion: import.meta.env.VITE_COGNITO_REGION ?? "",
  cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
};

// Tiempos del informe.
export const IDLE_LOGOUT_MS = 10 * 60 * 1000; // sesión sin actividad: 10 min
export const OFFLINE_AFTER_MS = 5 * 1000; // sin conexión 5 s -> modo respaldo
export const POLL_EVERY_MS = 15 * 1000; // consulta de respaldo cada 15 s (RNF03)
export const WRITE_RESULT_TIMEOUT_MS = 15 * 1000; // espera del resultado de una escritura
