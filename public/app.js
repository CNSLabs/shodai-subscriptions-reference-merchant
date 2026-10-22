const main = document.querySelector('#app');
const state = { wallet: null, noteDirty: false, loading: false, request: 0 };
const columns = [
  ['wallet', 'Wallet'], ['accessPaid', 'Access now'], ['renewalEnabled', 'Renewal'],
  ['paidThrough', 'Paid through'], ['latestCollection', 'Latest collection'],
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function query() { return new URLSearchParams(location.search); }
function setQuery(updates, push = false) {
  const next = query();
  for (const [key, value] of Object.entries(updates)) value == null || value === '' ? next.delete(key) : next.set(key, value);
  history[push ? 'pushState' : 'replaceState'](null, '', `${location.pathname}${next.size ? `?${next}` : ''}`);
}
function stamp(value) { return value ? new Date(value).toLocaleString() : 'None'; }
function paidThrough(value) { return value == null ? 'Pending' : value !== '0' ? stamp(Number(value) * 1000) : 'Not paid'; }
function badge(label, tone = '') { return `<span class="badge ${tone}">${escapeHtml(label)}</span>`; }
function transaction(hash) {
  return /^0x[0-9a-fA-F]{64}$/.test(hash || '')
    ? `<a class="mono" href="https://sepolia.basescan.org/tx/${hash}" target="_blank" rel="noopener noreferrer">${escapeHtml(hash.slice(0, 10))}...</a>` : '';
}
async function read(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  if (!response.ok) throw new Error(response.status === 401 ? 'Operator sign-in required' : `Request failed (${response.status})`);
  return response.json();
}

function listShell() {
  main.innerHTML = `<div class="heading"><div><h1>Customers</h1><div class="subtle">Wallet subscriptions and paid access</div></div><div class="subtle" id="updated"></div></div>
    <div class="toolbar"><input class="search" id="search" type="search" placeholder="Search wallet address" aria-label="Search wallet address" value="${escapeHtml(query().get('q') || '')}"></div>
    <div class="table-wrap"><table><thead><tr>${columns.map(([key, label]) => `<th><button type="button" data-sort="${key}">${label}<span class="sort-indicator" data-indicator="${key}"></span></button></th>`).join('')}</tr></thead><tbody id="rows"></tbody></table></div>
    <div id="list-message" class="state" hidden></div>`;
  let timer;
  main.querySelector('#search').addEventListener('input', event => {
    setQuery({ q: event.target.value });
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  });
  main.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    const sort = button.dataset.sort;
    const ascending = query().get('sort') === sort && query().get('dir') === 'asc';
    setQuery({ sort, dir: ascending ? 'desc' : 'asc' });
    refresh();
  }));
  main.querySelector('#rows').addEventListener('click', event => {
    const row = event.target.closest('[data-wallet]');
    if (!row || event.target.closest('a')) return;
    openWallet(row.dataset.wallet);
  });
}

function sorted(rows) {
  const sort = query().get('sort') || 'createdAt';
  const direction = query().get('dir') === 'asc' ? 1 : -1;
  const value = row => sort === 'latestCollection' ? row.latestCollection?.attemptedAt || '' :
    sort === 'paidThrough' ? Number(row.paidThrough || 0) : row[sort];
  return rows.sort((a, b) => {
    const first = value(a), second = value(b);
    return (typeof first === 'number' && typeof second === 'number' ? first - second : String(first).localeCompare(String(second))) * direction;
  });
}

async function listData() {
  const number = ++state.request;
  const message = main.querySelector('#list-message');
  if (!main.querySelector('#rows').children.length) { message.hidden = false; message.textContent = 'Loading customers...'; }
  try {
    const data = await read(`/admin/customers?search=${encodeURIComponent(query().get('q') || '')}`);
    if (number !== state.request || state.wallet) return;
    const rows = sorted(data.customers);
    main.querySelector('#rows').innerHTML = rows.map(row => `<tr data-wallet="${escapeHtml(row.wallet)}">
      <td class="mono"><a href="?${new URLSearchParams({ ...Object.fromEntries(query()), wallet: row.wallet })}" data-wallet-link="${escapeHtml(row.wallet)}">${escapeHtml(row.wallet)}</a></td>
      <td>${badge(row.accessPaid == null ? 'Pending' : row.accessPaid ? 'Active' : 'No access', row.accessPaid ? 'active' : '')}</td>
      <td>${badge(row.renewalEnabled == null ? 'Pending' : row.renewalEnabled ? 'Enabled' : 'Stopped', row.renewalEnabled ? 'active' : '')}</td>
      <td>${paidThrough(row.paidThrough)}</td>
      <td>${row.latestCollection ? `${badge(row.latestCollection.outcome, row.latestCollection.outcome === 'failed' ? 'failed' : row.latestCollection.outcome === 'succeeded' ? 'active' : 'pending')} <span class="subtle">${stamp(row.latestCollection.attemptedAt)}</span>` : 'None'}</td>
    </tr>`).join('');
    main.querySelectorAll('[data-wallet-link]').forEach(link => link.addEventListener('click', event => {
      event.preventDefault(); openWallet(link.dataset.walletLink);
    }));
    message.hidden = rows.length > 0;
    if (!rows.length) message.textContent = query().get('q') ? 'No wallets match this search.' : 'No customers yet.';
    main.querySelector('#updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    main.querySelectorAll('[data-indicator]').forEach(indicator => {
      indicator.textContent = indicator.dataset.indicator === query().get('sort') ? ` (${query().get('dir') || 'desc'})` : '';
    });
  } catch (error) {
    if (number !== state.request || state.wallet) return;
    message.hidden = false; message.classList.add('error'); message.textContent = error.message;
  }
}

function detailShell(wallet) {
  main.innerHTML = `<button type="button" class="back" id="back">Back to customers</button>
    <div class="heading"><div><h1 class="mono">${escapeHtml(wallet)}</h1><div class="subtle">Customer detail</div></div><div class="subtle" id="updated"></div></div>
    <div id="detail-message" class="state">Loading customer...</div>
    <div id="detail-content" hidden><div class="facts" id="facts"></div><div class="detail-grid">
      <div><section class="detail-section"><h2 class="section-title">Subscriptions</h2><div id="agreements"></div></section>
      <section class="detail-section"><h2 class="section-title">Activity</h2><div id="events"></div></section></div>
      <section class="detail-section"><h2 class="section-title">Private note</h2><label for="note">Operator note</label><textarea id="note" maxlength="2000"></textarea>
      <div class="note-actions"><button class="button primary" type="button" id="save-note">Save note</button><span class="note-status" id="note-status"></span></div></section>
    </div></div>`;
  main.querySelector('#back').addEventListener('click', () => { setQuery({ wallet: null }, true); render(); });
  main.querySelector('#note').addEventListener('input', () => { state.noteDirty = true; main.querySelector('#note-status').textContent = 'Unsaved changes'; });
  main.querySelector('#save-note').addEventListener('click', async () => {
    const button = main.querySelector('#save-note'); button.disabled = true;
    const note = main.querySelector('#note').value;
    try {
      await read(`/admin/customers/${wallet}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) });
      state.noteDirty = false; main.querySelector('#note-status').textContent = 'Saved';
      await detailData(wallet);
    } catch (error) { main.querySelector('#note-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
}

async function detailData(wallet) {
  const number = ++state.request;
  try {
    const data = await read(`/admin/customers/${wallet}`);
    if (number !== state.request || state.wallet !== wallet) return;
    const message = main.querySelector('#detail-message'); message.hidden = true;
    main.querySelector('#detail-content').hidden = false;
    main.querySelector('#facts').innerHTML = [
      ['Current access', badge(data.accessPaid == null ? 'Pending' : data.accessPaid ? 'Active' : 'No access', data.accessPaid ? 'active' : '')],
      ['Renewal', badge(data.renewalEnabled == null ? 'Pending' : data.renewalEnabled ? 'Enabled' : 'Stopped', data.renewalEnabled ? 'active' : '')],
      ['Paid through', escapeHtml(paidThrough(data.paidThrough))],
    ].map(([label, value]) => `<div class="fact"><div class="fact-label">${label}</div><div class="fact-value">${value}</div></div>`).join('');
    main.querySelector('#agreements').innerHTML = data.subscriptions.length ? data.subscriptions.map(item => `<dl class="key-value" style="margin-bottom:22px">
      <dt>Subscription</dt><dd class="mono">${escapeHtml(item.id)}</dd>
      <dt>Plan</dt><dd class="mono">${escapeHtml(item.planId)}</dd>
      <dt>Agreement</dt><dd class="mono">${item.setup?.agreement ? `<a href="https://sepolia.basescan.org/address/${escapeHtml(item.setup.agreement)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.setup.agreement)}</a>` : 'Pending'}</dd>
      <dt>Payer</dt><dd class="mono">${escapeHtml(item.setup?.payer || 'Pending')}</dd>
      <dt>Created</dt><dd>${stamp(item.createdAt)}</dd>
      <dt>Cancellation recorded</dt><dd>${stamp(item.canceledAt)}</dd></dl>`).join('') : '<span class="subtle">No subscriptions yet.</span>';
    const events = [...data.payments.map(item => ({ title: item.kind === 'initial' ? 'Initial collection' : 'Renewal collection',
      at: item.attemptedAt, outcome: item.status, transaction: item.transactionHash, subscriptionId: item.subscriptionId,
      error: item.failureReason, paidThrough: item.coveredPeriod ? String(Math.floor(Date.parse(item.coveredPeriod.endsAt) / 1000)) : null })),
      ...data.subscriptions.filter(item => item.canceledAt).map(item => ({ at: item.canceledAt, title: 'Cancellation', outcome: 'Renewal stopped', transaction: null, subscriptionId: item.id }))]
      .sort((a, b) => new Date(b.at) - new Date(a.at));
    main.querySelector('#events').innerHTML = events.length ? events.map(item => `<div class="event"><time>${stamp(item.at)}</time>
      <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.error || item.outcome)}${item.paidThrough ? `; paid through ${escapeHtml(paidThrough(item.paidThrough))}` : ''}</small><small class="mono">Subscription ${escapeHtml(item.subscriptionId)}</small></div>
      <div>${transaction(item.transaction)}</div></div>`).join('') : '<span class="subtle">No payment or cancellation activity yet.</span>';
    const note = main.querySelector('#note');
    if (!state.noteDirty && document.activeElement !== note) note.value = data.note;
    main.querySelector('#updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    if (number !== state.request || state.wallet !== wallet) return;
    const message = main.querySelector('#detail-message'); message.hidden = false; message.classList.add('error'); message.textContent = error.message;
  }
}

function openWallet(wallet) { setQuery({ wallet }, true); render(); }
function refresh() { if (document.hidden) return; state.wallet ? detailData(state.wallet) : listData(); }
function render() {
  state.request++;
  state.wallet = query().get('wallet'); state.noteDirty = false;
  state.wallet ? detailShell(state.wallet) : listShell();
  refresh();
}
window.addEventListener('popstate', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(refresh, 5000);
render();
