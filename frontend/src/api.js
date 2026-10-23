const DEFAULT_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const TOKEN_KEY = 'mt5bot.token';
const URL_KEY = 'mt5bot.apiUrl';

export const getApiUrl = () => (localStorage.getItem(URL_KEY) || DEFAULT_URL).replace(/\/$/, '');
export const setApiUrl = (u) => localStorage.setItem(URL_KEY, u);
export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function request(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = ['Bearer', token].join(' ');
  let res;
  try {
    res = await fetch(`${getApiUrl()}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(`Backend injoignable (${getApiUrl()})`, 0, 'NETWORK');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    const e = data.error || {};
    const detail = e.details?.map((d) => `${d.path}: ${d.message}`).join(', ');
    throw new ApiError([e.message || `HTTP ${res.status}`, detail].filter(Boolean).join(' — '), res.status, e.code, e.details);
  }
  return data;
}

export const api = {
  login: (password) => request('POST', '/auth/login', { password }),
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};
