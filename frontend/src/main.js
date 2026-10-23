import './style.css';
import { api, getApiUrl, getToken, setApiUrl, setToken, setUnauthorizedHandler } from './api.js';
import { esc, guard } from './util.js';
import { pages } from './pages.js';

const app = document.getElementById('app');
let cleanup = null;
let timer = null;

function stop() {
  clearInterval(timer);
  cleanup?.();
  cleanup = null;
}

function logout() {
  stop();
  setToken(null);
  renderLogin();
}

setUnauthorizedHandler(logout);

function renderLogin(message = '') {
  stop();
  app.innerHTML = `
    <form class="panel login" id="login">
      <h2>MT5 Bot</h2>
      ${message ? `<div class="banner bad">${esc(message)}</div>` : ''}
      <div class="form">
        <label>Mot de passe<input type="password" name="password" required autofocus autocomplete="current-password" /></label>
        <label>URL de l'API<input type="url" name="apiUrl" required value="${esc(getApiUrl())}" /></label>
      </div>
      <button type="submit">Se connecter</button>
    </form>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    setApiUrl(String(f.get('apiUrl')));
    try {
      const r = await api.login(String(f.get('password')));
      setToken(r.token);
      renderShell();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function renderShell() {
  app.innerHTML = `
    <header>
      <h1>MT5 Bot</h1>
      <nav>${Object.entries(pages)
        .map(([k, p]) => `<a href="#/${k}" data-route="${k}">${esc(p.title)}</a>`)
        .join('')}</nav>
      <span class="spacer"></span>
      <button class="secondary small" id="logout">Déconnexion</button>
    </header>
    <main id="view"></main>`;
  document.getElementById('logout').addEventListener('click', logout);
  route();
}

async function route() {
  if (!getToken()) return renderLogin();
  stop();
  const key = location.hash.replace(/^#\//, '') || 'overview';
  const page = pages[key] || pages.overview;
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (pages[key] ? key : 'overview')));
  const view = document.getElementById('view');
  if (!view) return;
  const refresh = () => guard(() => page.render(view));
  await refresh();
  if (page.live) timer = setInterval(() => !document.hidden && refresh(), 5000);
}

window.addEventListener('hashchange', route);
if (getToken()) renderShell();
else renderLogin();
