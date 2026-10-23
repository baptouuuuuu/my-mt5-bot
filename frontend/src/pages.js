import { api } from './api.js';
import { csv, esc, guard, money, pnlClass } from './util.js';

const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const fmt = (n, d = 5) => (n ? Number(n).toFixed(d).replace(/0+$/, '').replace(/\.$/, '') : '—');

/** Re-render helper that keeps focus on forms only when the page is not auto-refreshing. */
function on(view, selector, event, handler) {
  view.querySelectorAll(selector).forEach((el) => el.addEventListener(event, handler));
}

async function settingsBanner() {
  const s = await api.get('/settings');
  return {
    s,
    html: `${s.killSwitch ? '<div class="banner bad">Kill switch ACTIF : toutes les automatisations (BE, TP/SL auto, copy) sont suspendues.</div>' : ''}
      ${!s.killSwitch && s.dryRun ? '<div class="banner">Mode dry-run : les automatisations sont uniquement journalisées, aucun ordre n\'est envoyé.</div>' : ''}`,
  };
}

function settingsControls(s) {
  return `<div class="row">
    <label class="check"><input type="checkbox" id="kill" ${s.killSwitch ? 'checked' : ''} /> Kill switch</label>
    <label class="check"><input type="checkbox" id="dry" ${s.dryRun ? 'checked' : ''} /> Dry-run</label></div>`;
}

function bindSettings(view, rerender) {
  const send = (body, msg) => async () => {
    if (body.confirm && !confirm(body.confirm)) return rerender();
    delete body.confirm;
    await guard(() => api.put('/settings', body), msg);
    rerender();
  };
  view
    .querySelector('#kill')
    ?.addEventListener('change', (e) =>
      send(
        { killSwitch: e.target.checked, confirm: e.target.checked ? 'Activer le kill switch ?' : 'Réactiver les automatisations ?' },
        'Paramètres mis à jour',
      )(),
    );
  view
    .querySelector('#dry')
    ?.addEventListener('change', (e) =>
      send(
        { dryRun: e.target.checked, confirm: e.target.checked ? '' : 'Désactiver le dry-run ? Les règles enverront de VRAIS ordres.' },
        'Paramètres mis à jour',
      )(),
    );
}

const overview = {
  title: "Vue d'ensemble",
  live: true,
  async render(view) {
    const [o, { s, html }] = await Promise.all([api.get('/overview'), settingsBanner()]);
    view.innerHTML = `<h2>Vue d'ensemble</h2>${html}
      <div class="panel">${settingsControls(s)}</div>
      <div class="cards">
        ${[
          ['Comptes', o.accounts],
          ['Connectés', o.connected],
          ['En erreur', o.errors],
          ['Positions', o.openPositions],
          ['Ordres en attente', o.pendingOrders],
          ['Balance', money(o.balance)],
          ['Equity', money(o.equity)],
        ]
          .map(([l, v]) => `<div class="card"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`)
          .join('')}
        <div class="card"><div class="v ${pnlClass(o.floatingPnl)}">${money(o.floatingPnl)}</div><div class="l">PnL flottant</div></div>
      </div>
      <div class="panel scroll"><table><thead><tr><th>Compte</th><th>Statut</th><th>Balance</th><th>Equity</th><th>Positions</th><th>PnL</th><th>Dernière synchro</th><th>Erreur</th></tr></thead><tbody>
        ${o.perAccount.map((a) => `<tr><td>${esc(a.name)} <span class="muted">#${esc(a.login)}</span></td><td>${badge(a.status)}</td><td>${money(a.info?.balance)}</td><td>${money(a.info?.equity)}</td><td>${a.positions}</td><td class="${pnlClass(a.pnl)}">${money(a.pnl)}</td><td>${esc(a.lastSyncAt || '—')}</td><td class="neg">${esc(a.lastError || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucun compte</td></tr>'}
      </tbody></table></div>`;
    bindSettings(view, () => this.render(view));
  },
};

const accounts = {
  title: 'Comptes MT5',
  live: false,
  async render(view) {
    const list = await api.get('/accounts');
    view.innerHTML = `<h2>Comptes MT5</h2>
      <form class="panel" id="add"><h3>Ajouter un compte</h3><div class="form">
        <label>Nom<input name="name" required maxlength="60" /></label>
        <label>Login<input name="login" required /></label>
        <label>Serveur<input name="server" required /></label>
        <label>Mot de passe MT5<input name="password" type="password" autocomplete="new-password" /></label>
        <label>Provider<select name="provider"><option value="mock">mock (simulateur)</option><option value="bridge">bridge (MT5 réel)</option></select></label>
      </div><button>Ajouter</button> <span class="muted">Le mot de passe est chiffré côté serveur et jamais renvoyé.</span></form>
      <div class="panel scroll"><table><thead><tr><th>Nom</th><th>Login</th><th>Serveur</th><th>Provider</th><th>Statut</th><th>Erreur</th><th></th></tr></thead><tbody>
      ${
        list
          .map(
            (
              a,
            ) => `<tr><td>${esc(a.name)}</td><td>${esc(a.login)}</td><td>${esc(a.server)}</td><td>${esc(a.provider)}</td><td>${badge(a.status)}</td><td class="neg">${esc(a.lastError || '')}</td>
        <td class="row"><button class="small secondary" data-act="toggle" data-id="${a.id}" data-active="${a.active}">${a.active ? 'Désactiver' : 'Activer'}</button>
        <button class="small secondary" data-act="sync" data-id="${a.id}">Sync</button>
        <button class="small secondary" data-act="pwd" data-id="${a.id}">Mot de passe</button>
        <button class="small danger" data-act="del" data-id="${a.id}" data-name="${esc(a.name)}">Supprimer</button></td></tr>`,
          )
          .join('') || '<tr><td colspan="7" class="muted">Aucun compte</td></tr>'
      }
      </tbody></table></div>`;
    view.querySelector('#add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (!body.password) delete body.password;
      if (await guard(() => api.post('/accounts', body), 'Compte ajouté')) this.render(view);
    });
    on(view, '[data-act]', 'click', async (e) => {
      const { act, id, name, active } = e.currentTarget.dataset;
      let ok;
      if (act === 'toggle') ok = await guard(() => api.patch(`/accounts/${id}`, { active: active !== 'true' }), 'Compte mis à jour');
      else if (act === 'sync') ok = await guard(() => api.post(`/accounts/${id}/sync`), 'Synchronisé');
      else if (act === 'pwd') {
        const password = prompt('Nouveau mot de passe MT5 :');
        if (password) ok = await guard(() => api.patch(`/accounts/${id}`, { password }), 'Mot de passe mis à jour');
      } else if (act === 'del' && confirm(`Supprimer le compte « ${name} » et ses configurations ?`))
        ok = await guard(() => api.del(`/accounts/${id}`), 'Compte supprimé');
      this.render(view);
      return ok;
    });
  },
};

const trades = {
  title: 'Trades',
  live: true,
  async render(view) {
    // avoid wiping a prompt/confirm in progress: dialogs are blocking, so re-render is safe
    const [positions, orders] = await Promise.all([api.get('/positions'), api.get('/orders')]);
    view.innerHTML = `<h2>Positions ouvertes</h2><div class="panel scroll"><table><thead><tr><th>Compte</th><th>Ticket</th><th>Symbole</th><th>Sens</th><th>Vol.</th><th>Ouverture</th><th>Actuel</th><th>SL</th><th>TP</th><th>Profit</th><th>Magic</th><th>Commentaire</th><th></th></tr></thead><tbody>
      ${
        positions
          .map(
            (
              p,
            ) => `<tr><td>${esc(p.accountName)}</td><td>${esc(p.ticket)}</td><td>${esc(p.symbol)}</td><td>${esc(p.type)}</td><td>${p.volume}</td><td>${fmt(p.openPrice)}</td><td>${fmt(p.currentPrice)}</td><td>${fmt(p.sl)}</td><td>${fmt(p.tp)}</td><td class="${pnlClass(p.profit)}">${money(p.profit)}</td><td>${esc(p.magic)}</td><td>${esc(p.comment)}</td>
        <td class="row" data-acc="${p.accountId}" data-t="${esc(p.ticket)}" data-vol="${p.volume}" data-sym="${esc(p.symbol)}">
          <button class="small danger" data-act="close">Fermer</button><button class="small secondary" data-act="partial">Partiel</button>
          <button class="small secondary" data-act="sltp">SL/TP</button><button class="small secondary" data-act="be">BE</button></td></tr>`,
          )
          .join('') || '<tr><td colspan="13" class="muted">Aucune position</td></tr>'
      }
      </tbody></table></div>
      <h2>Ordres en attente</h2><div class="panel scroll"><table><thead><tr><th>Compte</th><th>Ticket</th><th>Symbole</th><th>Type</th><th>Vol.</th><th>Prix</th></tr></thead><tbody>
      ${orders.map((o) => `<tr><td>${esc(o.accountName)}</td><td>${esc(o.ticket)}</td><td>${esc(o.symbol)}</td><td>${esc(o.type)}</td><td>${esc(o.volume)}</td><td>${esc(o.price)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucun ordre</td></tr>'}
      </tbody></table></div>`;
    on(view, '[data-act]', 'click', async (e) => {
      const cell = e.currentTarget.closest('td');
      const { acc, t, vol, sym } = cell.dataset;
      const base = `/accounts/${acc}/positions/${t}`;
      const num = (s) => (s === '' ? undefined : Number(s));
      let r;
      switch (e.currentTarget.dataset.act) {
        case 'close':
          if (confirm(`Fermer entièrement #${t} (${sym}) ?`)) r = await guard(() => api.post(`${base}/close`, {}), 'Position fermée');
          break;
        case 'partial': {
          const v = prompt(`Volume à fermer (max ${vol}) :`);
          if (v && confirm(`Fermer ${v} lot(s) de #${t} ?`))
            r = await guard(() => api.post(`${base}/close`, { volume: Number(v) }), 'Fermeture partielle effectuée');
          break;
        }
        case 'sltp': {
          const sl = prompt('Nouveau SL (vide = inchangé, 0 = supprimer) :');
          const tp = prompt('Nouveau TP (vide = inchangé, 0 = supprimer) :');
          const body = {};
          if (num(sl ?? '') !== undefined) body.sl = num(sl);
          if (num(tp ?? '') !== undefined) body.tp = num(tp);
          if (Object.keys(body).length && confirm(`Modifier #${t} : ${JSON.stringify(body)} ?`))
            r = await guard(() => api.post(`${base}/modify`, body), 'SL/TP modifiés');
          break;
        }
        case 'be':
          if (confirm(`Déplacer le SL de #${t} au break-even ?`))
            r = await guard(() => api.post(`${base}/breakeven`, {}), 'SL déplacé au BE');
          break;
      }
      if (r) this.render(view);
    });
  },
};

const copy = {
  title: 'Copy trading',
  live: false,
  async render(view) {
    const [links, accs] = await Promise.all([api.get('/copy-links'), api.get('/accounts')]);
    const name = (id) => accs.find((a) => a.id === id)?.name || `#${id}`;
    const opts = accs.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    view.innerHTML = `<h2>Copy trading</h2>
      <p class="muted">Anti-boucle : un compte déjà destination d'une chaîne ne peut pas redevenir source, et les trades copiés ne sont jamais recopiés. Chaque trade n'est copié qu'une seule fois.</p>
      <form class="panel" id="add"><h3>Nouvelle relation</h3><div class="form">
        <label>Source<select name="source">${opts}</select></label><label>Destination<select name="dest">${opts}</select></label>
        <label>Multiplicateur de lot<input name="multiplier" type="number" step="0.01" min="0.01" value="1" /></label>
        <label>Lot min<input name="minLot" type="number" step="0.01" min="0.01" value="0.01" /></label>
        <label>Lot max<input name="maxLot" type="number" step="0.01" min="0.01" value="100" /></label>
        <label>Symboles (CSV, vide = tous)<input name="symbols" /></label>
        <label class="check"><input name="inverse" type="checkbox" /> Inverser (buy ↔ sell)</label></div><button>Créer</button></form>
      <div class="panel scroll"><table><thead><tr><th>Source</th><th>Destination</th><th>Multiplicateur</th><th>Lots</th><th>Symboles</th><th>Inverse</th><th>Actif</th><th></th></tr></thead><tbody>
      ${
        links
          .map(
            (
              l,
            ) => `<tr><td>${esc(name(l.sourceAccountId))}</td><td>${esc(name(l.destAccountId))}</td><td>×${l.config.multiplier}</td><td>${l.config.minLot} – ${l.config.maxLot}</td><td>${esc(l.config.symbols.join(', ') || 'tous')}</td><td>${l.config.inverse ? 'oui' : 'non'}</td><td>${badge(l.enabled ? 'ok' : 'disabled')}</td>
        <td class="row"><button class="small secondary" data-act="toggle" data-id="${l.id}" data-en="${l.enabled}">${l.enabled ? 'Pause' : 'Activer'}</button><button class="small danger" data-act="del" data-id="${l.id}">Supprimer</button></td></tr>`,
          )
          .join('') || '<tr><td colspan="8" class="muted">Aucune relation</td></tr>'
      }
      </tbody></table></div>`;
    view.querySelector('#add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = {
        sourceAccountId: Number(f.get('source')),
        destAccountId: Number(f.get('dest')),
        config: {
          multiplier: Number(f.get('multiplier')),
          minLot: Number(f.get('minLot')),
          maxLot: Number(f.get('maxLot')),
          symbols: csv(f.get('symbols')),
          inverse: f.get('inverse') === 'on',
        },
      };
      if (await guard(() => api.post('/copy-links', body), 'Relation créée')) this.render(view);
    });
    on(view, '[data-act]', 'click', async (e) => {
      const { act, id, en } = e.currentTarget.dataset;
      if (act === 'toggle') await guard(() => api.patch(`/copy-links/${id}`, { enabled: en !== 'true' }));
      else if (confirm('Supprimer cette relation ?')) await guard(() => api.del(`/copy-links/${id}`));
      this.render(view);
    });
  },
};

const rules = {
  title: 'Règles BE / TP-SL',
  live: false,
  scope: '',
  async render(view) {
    const accs = await api.get('/accounts');
    const scope = this.scope;
    const base = scope ? `/accounts/${scope}/rules` : '/rules';
    const [r, { s, html }] = await Promise.all([api.get(base), settingsBanner()]);
    const be = r.be?.config || {
      mode: 'points',
      threshold: 100,
      offsetPoints: 0,
      symbols: [],
      magics: [],
      commentContains: '',
      cooldownSec: 60,
    };
    const sl = r.autosltp?.config || {
      unit: 'pips',
      slDistance: 20,
      tpDistance: 40,
      riskPercent: 0,
      overwrite: false,
      symbols: [],
      magics: [],
      commentContains: '',
      session: null,
    };
    const filters = (c) => `<label>Symboles (CSV)<input name="symbols" value="${esc(c.symbols.join(','))}" /></label>
      <label>Magic (CSV)<input name="magics" value="${esc(c.magics.join(','))}" /></label>
      <label>Commentaire contient<input name="commentContains" value="${esc(c.commentContains)}" /></label>`;
    view.innerHTML = `<h2>Règles automatiques</h2>${html}<div class="panel">${settingsControls(s)}</div>
      <div class="panel"><label>Portée<select id="scope"><option value="">Globale</option>${accs.map((a) => `<option value="${a.id}" ${String(a.id) === scope ? 'selected' : ''}>Compte : ${esc(a.name)}</option>`).join('')}</select></label>
        ${scope ? '<p class="muted">La configuration du compte remplace la configuration globale pour ce compte.</p>' : ''}</div>
      <form class="panel" id="be"><h3>Break-even automatique</h3><div class="form">
        <label class="check"><input type="checkbox" name="enabled" ${r.be?.enabled ? 'checked' : ''} /> Activée</label>
        <label>Mode<select name="mode">${['points', 'pips', 'money'].map((m) => `<option ${be.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>Seuil<input name="threshold" type="number" step="any" min="0" value="${be.threshold}" /></label>
        <label>Offset BE+X (points)<input name="offsetPoints" type="number" step="any" min="0" value="${be.offsetPoints}" /></label>
        <label>Cooldown (s)<input name="cooldownSec" type="number" min="5" value="${be.cooldownSec}" /></label>${filters(be)}</div>
        <button>Enregistrer</button> ${scope ? '<button type="button" class="secondary" data-reset="be">Revenir au global</button>' : ''}</form>
      <form class="panel" id="autosltp"><h3>TP/SL automatiques (positions sans protection)</h3><div class="form">
        <label class="check"><input type="checkbox" name="enabled" ${r.autosltp?.enabled ? 'checked' : ''} /> Activée</label>
        <label>Unité<select name="unit">${['pips', 'points'].map((m) => `<option ${sl.unit === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>Distance SL<input name="slDistance" type="number" step="any" min="0" value="${sl.slDistance}" /></label>
        <label>Distance TP<input name="tpDistance" type="number" step="any" min="0" value="${sl.tpDistance}" /></label>
        <label>Risque % (remplace SL si &gt; 0)<input name="riskPercent" type="number" step="any" min="0" max="100" value="${sl.riskPercent}" /></label>
        <label>Session UTC début<input name="startHour" type="number" min="0" max="23" value="${sl.session?.startHour ?? ''}" /></label>
        <label>Session UTC fin<input name="endHour" type="number" min="0" max="24" value="${sl.session?.endHour ?? ''}" /></label>
        <label class="check"><input type="checkbox" name="overwrite" ${sl.overwrite ? 'checked' : ''} /> Écraser SL/TP existants</label>${filters(sl)}</div>
        <button>Enregistrer</button> ${scope ? '<button type="button" class="secondary" data-reset="autosltp">Revenir au global</button>' : ''}</form>`;
    bindSettings(view, () => this.render(view));
    view.querySelector('#scope').addEventListener('change', (e) => ((this.scope = e.target.value), this.render(view)));
    const common = (f) => ({
      symbols: csv(f.get('symbols')),
      magics: csv(f.get('magics')).map(Number),
      commentContains: String(f.get('commentContains') || ''),
    });
    view.querySelector('#be').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const config = {
        mode: f.get('mode'),
        threshold: Number(f.get('threshold')),
        offsetPoints: Number(f.get('offsetPoints')),
        cooldownSec: Number(f.get('cooldownSec')),
        ...common(f),
      };
      await guard(() => api.put(`${base}/be`, { enabled: f.get('enabled') === 'on', config }), 'Règle BE enregistrée');
    });
    view.querySelector('#autosltp').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const sh = f.get('startHour');
      const eh = f.get('endHour');
      const config = {
        unit: f.get('unit'),
        slDistance: Number(f.get('slDistance')),
        tpDistance: Number(f.get('tpDistance')),
        riskPercent: Number(f.get('riskPercent')),
        overwrite: f.get('overwrite') === 'on',
        session: sh !== '' && eh !== '' ? { startHour: Number(sh), endHour: Number(eh) } : null,
        ...common(f),
      };
      if (config.overwrite && !confirm('Écraser les SL/TP existants peut modifier des protections que vous avez posées. Continuer ?'))
        return;
      await guard(() => api.put(`${base}/autosltp`, { enabled: f.get('enabled') === 'on', config }), 'Règle TP/SL enregistrée');
    });
    on(view, '[data-reset]', 'click', async (e) => {
      await guard(() => api.del(`${base}/${e.currentTarget.dataset.reset}`), 'Surcharge supprimée');
      this.render(view);
    });
  },
};

const logs = {
  title: 'Logs',
  live: true,
  level: '',
  async render(view) {
    const events = await api.get(`/events?limit=200${this.level ? `&level=${this.level}` : ''}`);
    view.innerHTML = `<h2>Logs & événements</h2><div class="panel row"><label>Niveau<select id="lvl">${['', 'info', 'warn', 'error'].map((l) => `<option value="${l}" ${l === this.level ? 'selected' : ''}>${l || 'tous'}</option>`).join('')}</select></label></div>
      <div class="panel scroll"><table><thead><tr><th>Date</th><th>Niveau</th><th>Type</th><th>Compte</th><th>Message</th><th>Corrélation</th></tr></thead><tbody>
      ${events.map((e) => `<tr><td>${esc(e.ts)}</td><td>${badge(e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'ok')} ${esc(e.level)}</td><td>${esc(e.type)}</td><td>${esc(e.account_id ?? '')}</td><td>${esc(e.message)}</td><td class="muted">${esc((e.correlation_id || '').slice(0, 8))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucun événement</td></tr>'}
      </tbody></table></div>`;
    view.querySelector('#lvl').addEventListener('change', (e) => ((this.level = e.target.value), this.render(view)));
  },
};

export const pages = { overview, accounts, trades, copy, rules, logs };
