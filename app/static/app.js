/* Fieldlist's own same-origin endpoints only. No third-party data API or client key. */
'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { result: null, jobId: null, busy: false, filter: 'missing', sort: 'default', timer: null, pollErrors: 0, status: null };
const SVG_NS = 'http://www.w3.org/2000/svg';

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}
function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function safeLink(url) {
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : ''; }
  catch { return ''; }
}
function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(20000) });
  let data;
  try { data = await response.json(); } catch { throw new Error('The local server returned an unreadable response. Please try again.'); }
  if (!response.ok) {
    const message = typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map(item => item.msg).join(' ') : 'The request could not be completed.';
    const error = new Error(message); error.status = response.status; throw error;
  }
  return data;
}
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast span').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3800);
}
function notice(message, type = 'info') {
  $('#notice-text').textContent = message;
  $('#notice').className = `notice ${type}`;
  $('#notice').setAttribute('role', type === 'error' ? 'alert' : 'status');
  $('#notice').hidden = false;
}
function clearNotice() { $('#notice').hidden = true; }

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    state.status = status;
    $('#allowance-text').textContent = 'Unlimited searches';
    $('#allowance-fill').style.width = '100%';
    $('.allowance-meta span:last-child').textContent = '';
    $('#quota-note').textContent = 'Unlimited searches enabled';
    if ($('#kpi-allowance')) $('#kpi-allowance').textContent = 'Unlimited';
    $('#cache-days-note').textContent = status.cache_days;
    $$('.cache-days-copy').forEach(element => { element.textContent = status.cache_days; });
  } catch { /* The search endpoint provides a useful error if the server is unavailable. */ }
}
async function refreshHistory() {
  try {
    const { searches } = await api('/api/history');
    const list = $('#recent-list'); list.replaceChildren();
    $('#recent').hidden = searches.length === 0;
    for (const search of searches) {
      const button = node('button', 'recent-item'); button.type = 'button'; button.disabled = state.busy;
      button.append(icon('clock'));
      const body = node('div');
      body.append(node('strong', '', `${search.niche} in ${search.city}`));
      body.append(node('p', '', `${search.missing} without a website · ${dateLabel(search.cached_at)}`));
      button.append(body, icon('arrow'));
      button.addEventListener('click', () => {
        if (state.busy) return;
        $('#niche').value = search.niche; $('#city').value = search.city; $('#limit').value = search.limit;
        $('#only-missing').checked = true;
        $('#finder').scrollIntoView({ behavior: 'smooth' });
        $('#search-form').requestSubmit();
      });
      list.append(button);
    }
  } catch { /* History is optional; never block a search on it. */ }
}
function setBusy(busy) {
  state.busy = busy;
  $$('#search-form input, #search-form select, #search-button, [data-niche], .recent-item').forEach(element => { element.disabled = busy; });
  const button = $('#search-button');
  button.replaceChildren(icon(busy ? 'globe' : 'search', busy ? 'spinner' : ''), node('span', '', busy ? 'Searching Google Maps…' : 'Find businesses'), icon('arrow', 'button-arrow'));
  $('#progress-card').hidden = !busy;
  $('#cancel-search').disabled = false; $('#cancel-search').textContent = 'Cancel';
  if (busy) { $('#export-csv').disabled = true; $('#stats-grid').hidden = true; $('#table-container').hidden = true; $('#empty-state').hidden = false; $('#empty-state').classList.add('searching'); $('#result-count').hidden = true; }
  else { $('#empty-state').classList.remove('searching'); }
}
function updateProgress(job) {
  $('#progress-message').textContent = job.message || 'Reading public business profiles…';
  $('#progress-title').textContent = job.status === 'cancelling' ? 'Wrapping up safely…' : job.stage === 'inspecting' ? 'Getting to know the local businesses…' : 'Looking around the neighborhood…';
  let percent = 4;
  if (job.stage === 'collecting') percent = Math.min(25, 5 + (job.found || 0) / job.limit * 20);
  if (job.stage === 'inspecting') percent = 25 + (job.checked || 0) / Math.max(job.total || job.limit, 1) * 73;
  percent = Math.min(99, Math.round(percent));
  $('#progress-fill').style.width = `${percent}%`;
  $('.progress-track').setAttribute('aria-valuenow', percent);
  $('#progress-count').textContent = job.stage === 'inspecting' ? `${job.checked || 0} / ${job.total || job.limit} profiles` : `${job.found || 0} listings found`;
  if (job.status === 'cancelling') { $('#cancel-search').disabled = true; $('#cancel-search').textContent = 'Stopping…'; }
}
async function pollJob() {
  if (!state.jobId || !state.busy) return;
  try {
    const job = await api(`/api/jobs/${state.jobId}`);
    state.pollErrors = 0;
    updateProgress(job);
    if (job.status === 'completed') {
      setBusy(false); state.jobId = null; renderResult(job.result);
      await Promise.all([refreshStatus(), refreshHistory()]);
      return;
    }
    if (job.status === 'failed') {
      setBusy(false); state.jobId = null; $('#empty-state').hidden = false;
      notice(job.error?.message || 'The search could not finish. Please try again later.', 'error');
      await refreshStatus(); return;
    }
    if (job.status === 'cancelled') {
      setBusy(false); state.jobId = null; notice(job.message);
      await refreshStatus(); return;
    }
  } catch (error) {
    state.pollErrors += 1;
    if (error.status === 404 || state.pollErrors >= 4) {
      setBusy(false); state.jobId = null;
      notice(error.message || 'The connection to the search was lost. A completed search may still be available in recent searches.', 'error');
      await refreshStatus(); return;
    }
  }
  if (state.busy) state.timer = setTimeout(pollJob, 1300);
}
async function startSearch(event) {
  event.preventDefault();
  if (state.busy || !$('#search-form').reportValidity()) return;
  clearTimeout(state.timer); clearNotice();
  state.result = null; state.sort = 'default'; state.filter = $('#only-missing').checked ? 'missing' : 'all';
  $('#results-subtitle').textContent = `Checking ${$('#niche').value.trim()} in ${$('#city').value.trim()}…`;
  setBusy(true); updateProgress({ stage: 'queued', message: 'Preparing your search…', limit: Number($('#limit').value) });
  try {
    const response = await api('/api/search', { method: 'POST', body: JSON.stringify({ niche: $('#niche').value.trim(), city: $('#city').value.trim(), limit: Number($('#limit').value), only_missing: $('#only-missing').checked }) });
    if (response.kind === 'cached') {
      setBusy(false); renderResult(response.result); toast('Loaded from cache. No fresh search used.');
      await refreshStatus();
    } else {
      state.jobId = response.job.id; state.pollErrors = 0; updateProgress(response.job);
      await refreshStatus(); state.timer = setTimeout(pollJob, 1000);
    }
  } catch (error) {
    setBusy(false); state.jobId = null;
    notice(error.name === 'TimeoutError' ? 'The local server took too long to respond. Please try again.' : error.message || 'Could not connect to the local server.', 'error');
    await refreshStatus();
  }
}
function visibleRows() {
  if (!state.result) return [];
  let rows = state.result.businesses.filter(item => state.filter === 'all' || item.website_status === 'missing');
  if (state.sort !== 'default') rows = [...rows].sort((a, b) => {
    if (a.rating == null) return 1;
    if (b.rating == null) return -1;
    return state.sort === 'desc' ? b.rating - a.rating : a.rating - b.rating;
  });
  return rows;
}
function externalLink(url, className, text, iconName = 'external') {
  const anchor = node('a', className); anchor.href = safeLink(url); anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
  if (text) anchor.append(document.createTextNode(text)); anchor.append(icon(iconName)); return anchor;
}
function websiteBadge(item) {
  const missing = item.website_status === 'missing';
  const badge = node('span', `website-badge${missing ? '' : 'linked'}`);
  badge.append(icon(missing ? 'globe' : 'check'), document.createTextNode(missing ? 'Not linked' : 'Linked'));
  return badge;
}
function renderTable() {
  const rows = visibleRows(); const body = $('#results-body'); body.replaceChildren();
  $('#result-count').textContent = rows.length; $('#result-count').hidden = false;
  $('#export-csv').disabled = rows.length === 0;
  $('#table-summary').textContent = `${rows.length} ${state.filter === 'missing' ? 'opportunities' : 'businesses'} shown · ${state.result.inspected} profiles checked`;
  $('#table-footer-count').textContent = `${rows.length} business${rows.length === 1 ? '' : 'es'} in this view`;
  $('#filter-control').hidden = false; $('#filter-control select').value = state.filter;
  $('#sort-rating').closest('th').setAttribute('aria-sort', state.sort === 'desc' ? 'descending' : state.sort === 'asc' ? 'ascending' : 'none');
  $('#sort-rating').title = state.sort === 'desc' ? 'Sort rating lowest first' : state.sort === 'asc' ? 'Restore Google Maps order' : 'Sort rating highest first';
  if (!rows.length) {
    const tr = node('tr'); const td = node('td', 'no-matches'); td.colSpan = 7;
    const hasProfiles = state.result.inspected > 0;
    td.append(node('strong', '', hasProfiles ? 'Every checked business has a website link.' : 'No matching listings found.'));
    td.append(document.createTextNode(hasProfiles ? 'Try another niche or city, or switch to “All checked businesses”.' : 'Try a broader niche and include a state, region, or country.'));
    tr.append(td); body.append(tr); return;
  }
  for (const item of rows) {
    const tr = node('tr');
    const business = node('td'); business.dataset.label = 'Business';
    const button = node('button', 'business-button'); button.type = 'button'; button.setAttribute('aria-label', `View details for ${item.name}`);
    button.append(node('span', 'business-name', item.name), node('span', 'business-category', item.category || 'Local business'));
    button.addEventListener('click', () => openDetail(item)); business.append(button);
    const phone = node('td', 'phone-cell', item.phone || 'Not listed'); phone.dataset.label = 'Phone';
    const rating = node('td'); rating.dataset.label = 'Rating';
    const ratingValue = node('span', 'rating-value');
    if (item.rating != null) ratingValue.append(node('span', 'star', '★'), document.createTextNode(Number(item.rating).toFixed(1)));
    else ratingValue.textContent = '—';
    rating.append(ratingValue);
    const reviews = node('td', '', item.reviews == null ? '—' : Number(item.reviews).toLocaleString()); reviews.dataset.label = 'Reviews';
    const address = node('td', 'address-cell', item.address || 'Not listed'); address.dataset.label = 'Address';
    const website = node('td'); website.dataset.label = 'Website'; website.append(websiteBadge(item));
    const maps = node('td'); maps.dataset.label = 'Map';
    const link = externalLink(item.maps_url, 'map-link', '', 'external'); link.setAttribute('aria-label', `Open ${item.name} on Google Maps`); link.title = 'Open Google Maps'; maps.append(link);
    tr.append(business, phone, rating, reviews, address, website, maps); body.append(tr);
  }
}
function renderResult(result) {
  state.result = result; state.filter = result.only_missing ? 'missing' : 'all';
  $('#empty-state').hidden = true; $('#table-container').hidden = false; $('#stats-grid').hidden = false;
  $('#results-subtitle').textContent = `${result.niche} in ${result.city} · Public details from Google Maps`;
  $('#stat-inspected').textContent = result.inspected;
  $('#stat-missing').replaceChildren(document.createTextNode(result.missing), node('span', 'stat-tag', 'OPPORTUNITIES'));
  const share = result.inspected ? Math.round(result.missing / result.inspected * 100) : 0;
  $('#stat-share').replaceChildren(document.createTextNode(share), node('span', 'stat-percent', '%'));
  $('#cache-label').textContent = `${result.complete ? '' : 'Partial · '}${result.cached ? 'Cached' : 'Checked'} ${dateLabel(result.cached_at)}`;
  if (result.notice) notice(result.notice);
  renderTable();
}
function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Prevent spreadsheet formula execution when a public business field starts with =, +, -, or @.
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function exportCsv() {
  const rows = visibleRows(); if (!rows.length || !state.result) return;
  const headers = ['Business name', 'Category', 'Business phone', 'Address', 'Rating', 'Review count', 'Website URL', 'Website status', 'Google Maps URL', 'Observed at (UTC)', 'Niche', 'City'];
  const records = rows.map(item => [item.name, item.category, item.phone, item.address, item.rating, item.reviews, item.website, item.website_status === 'missing' ? 'No website linked' : 'Website linked', item.maps_url, item.observed_at, state.result.niche, state.result.city]);
  const csv = '\uFEFF' + [headers, ...records].map(record => record.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const slug = value => value.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 55);
  const link = node('a'); link.href = url; link.download = `fieldlist-${slug(state.result.niche)}-${slug(state.result.city)}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(`${rows.length} business${rows.length === 1 ? '' : 'es'} exported to CSV.`);
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const area = node('textarea'); area.value = value; area.style.position = 'fixed'; area.style.opacity = '0';
    ($('#detail-dialog').open ? $('#detail-dialog') : document.body).append(area); area.select();
    const copied = document.execCommand('copy'); area.remove();
    if (!copied) { toast('Copy is unavailable. Select the phone number to copy it.'); return; }
  }
  toast('Business phone number copied.');
}
function openDetail(item) {
  $('#detail-title').textContent = item.name;
  $('#detail-category').textContent = item.category || 'LOCAL BUSINESS';
  $('#detail-status').replaceChildren(websiteBadge(item));
  const fields = $('#detail-fields'); fields.replaceChildren();
  const add = (label, content) => { const row = node('div'); row.append(node('dt', '', label), node('dd', '', typeof content === 'string' ? content : '')); if (typeof content !== 'string') row.lastChild.append(content); fields.append(row); };
  if (item.phone) {
    const phone = node('div', 'detail-phone'); const link = node('a', '', item.phone); link.href = `tel:${item.phone.replace(/[^+\d]/g, '')}`;
    const copy = node('button', 'icon-button'); copy.type = 'button'; copy.title = 'Copy phone number'; copy.setAttribute('aria-label', 'Copy phone number'); copy.append(icon('copy')); copy.addEventListener('click', () => copyText(item.phone));
    phone.append(link, copy); add('Phone', phone);
  } else add('Phone', 'Not listed / not available');
  add('Address', item.address || 'Not listed / not available');
  add('Rating', item.rating == null ? 'Not available' : `${Number(item.rating).toFixed(1)} out of 5`);
  add('Reviews', item.reviews == null ? 'Not available' : Number(item.reviews).toLocaleString());
  if (item.website) { const hostname = new URL(item.website).hostname; add('Website', externalLink(item.website, '', hostname)); }
  else add('Website', 'No website link on this Maps profile');
  $('#detail-observed').textContent = `Read from Google Maps · ${dateLabel(item.observed_at)}. Verify details before outreach.`;
  $('#detail-map').href = safeLink(item.maps_url);
  $('#detail-website').hidden = !item.website;
  if (item.website) $('#detail-website').href = safeLink(item.website);
  $('#detail-dialog').showModal();
}

$('#search-form').addEventListener('submit', startSearch);
$('#dismiss-notice').addEventListener('click', clearNotice);
$('#export-csv').addEventListener('click', exportCsv);
$('#result-filter').addEventListener('change', event => { state.filter = event.target.value; renderTable(); });
$('#sort-rating').addEventListener('click', () => { state.sort = state.sort === 'default' ? 'desc' : state.sort === 'desc' ? 'asc' : 'default'; renderTable(); });
$('#cancel-search').addEventListener('click', async () => {
  if (!state.jobId) return;
  $('#cancel-search').disabled = true; $('#cancel-search').textContent = 'Stopping…';
  try { await api(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' }); }
  catch (error) { notice(error.message, 'error'); $('#cancel-search').disabled = false; }
});
$$('[data-niche]').forEach(button => button.addEventListener('click', () => {
  if (state.busy) return;
  $('#niche').value = button.dataset.niche; $('#city').value = button.dataset.city;
  $('#niche').focus(); toast('Search filled in. Hit “Find businesses” when you’re ready.');
}));
$$('[data-open-help]').forEach(button => button.addEventListener('click', () => $('#help-dialog').showModal()));
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
refreshStatus(); refreshHistory();
