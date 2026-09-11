import axios from 'axios';

let authRedirectInProgress = false;

// Default request timeout so a wedged/slow request can't hang a UI flow
// forever (the backend runs synchronous better-sqlite3 on its event loop, so a
// heavy query elsewhere can stall responses under load). Applied per-request in
// the interceptor below.
const DEFAULT_TIMEOUT_MS = 30_000;

// Endpoints that legitimately run longer than the default — large database
// backups/imports/restores, CSV menu imports, and cloud (Google Drive) uploads.
// These keep their previous no-timeout behavior so a big or slow operation is
// never aborted mid-flight.
const NO_TIMEOUT_PATH = /(?:\/db\/(?:backup|import|restore)\b|\/db-tools\/|\/menu-csv\/import\b|\/settings\/google-drive\/)/;

// Derived from the page's own origin (not a build-time env var) so LAN
// clients that load the app via the server's IP — e.g. http://192.168.1.5:3001 —
// talk back to that same host instead of a hardcoded "localhost", which would
// resolve to the client's own machine and fail. Matches the pattern already
// used by the standalone KDS client (kds-standalone/page.tsx), which works
// correctly over LAN today for the same reason.
const api = axios.create({
  baseURL: typeof window !== 'undefined' ? `${window.location.origin}/api` : '/api',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  // Apply the default timeout unless the caller set one explicitly, exempting
  // the known long-running endpoints. (0/undefined both mean "no timeout" to
  // axios; no current caller passes an explicit timeout through this client.)
  if (!config.timeout) {
    config.timeout = NO_TIMEOUT_PATH.test(config.url || '') ? 0 : DEFAULT_TIMEOUT_MS;
  }
  return config;
});

// Handle 401 responses
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      // KDS routes render inline login; avoid redirecting away to /auth/login.
      const isKdsPath = window.location.pathname.startsWith('/kds');
      localStorage.removeItem('token');
      if (isKdsPath) return Promise.reject(error);
      // Don't redirect when already on the login page — let the login handler show the error
      if (!window.location.pathname.includes('/auth/login') && !authRedirectInProgress) {
        authRedirectInProgress = true;
        localStorage.removeItem('tenant');
        window.location.href = '/auth/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;
