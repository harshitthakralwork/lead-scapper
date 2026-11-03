/* Fieldlist's own same-origin endpoints only. No third-party data API or client key. */
'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = {
  result: null,
  jobId: null,
  busy: false,
  filter: 'missing',
  sort: 'default',
  timer: null,
  pollErrors: 0,
  status: null,
  searchQuery: '',
  selectedIds: new Set()
};
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
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(20000)
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The local server returned an unreadable response. Please try again.');
  }
  if (!response.ok) {
    const message = typeof data.detail === 'string'
      ? data.detail
      : Array.isArray(data.detail)
        ? data.detail.map(item => item.msg).join(' ')
        : 'The request could not be completed.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
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

function clearNotice() {
  $('#notice').hidden = true;
}

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
  } catch { /* History/status is non-blocking. */ }
}

async function refreshHistory() {
  try {
    const { searches } = await api('/api/history');
    const list = $('#recent-list');
    list.replaceChildren();
    $('#recent').hidden = searches.length === 0;
    for (const search of searches) {
      const button = node('button', 'recent-item');
      button.type = 'button';
      button.disabled = state.busy;
      button.append(icon('clock'));
      const body = node('div');
      body.append(node('strong', '', `${search.niche} in ${search.city}`));
      body.append(node('p', '', `${search.missing} without a website · ${dateLabel(search.cached_at)}`));
      button.append(body, icon('arrow'));
      button.addEventListener('click', () => {
        if (state.busy) return;
        $('#niche').value = search.niche;
        $('#city').value = search.city;
        $('#limit').value = search.limit;
        $('#only-missing').checked = true;
        $('#finder').scrollIntoView({ behavior: 'smooth' });
        $('#search-form').requestSubmit();
      });
      list.append(button);
    }
  } catch { /* Non-blocking */ }
}

function setBusy(busy) {
  state.busy = busy;
  $$('#search-form input, #search-form select, #search-button, [data-niche], .recent-item').forEach(element => {
    element.disabled = busy;
  });
  const button = $('#search-button');
  button.replaceChildren(
    icon(busy ? 'globe' : 'search', busy ? 'spinner' : ''),
    node('span', '', busy ? 'Searching Google Maps…' : 'Find businesses'),
    icon('arrow', 'button-arrow')
  );
  $('#progress-card').hidden = !busy;
  $('#cancel-search').disabled = false;
  $('#cancel-search').textContent = 'Cancel';
  if (busy) {
    $('#export-csv').disabled = true;
    $('#copy-all-phones').disabled = true;
    $('#table-container').hidden = true;
    $('#empty-state').hidden = false;
    $('#empty-state').classList.add('searching');
    $('#result-count').hidden = true;
  } else {
    $('#empty-state').classList.remove('searching');
  }
}

function updateProgress(job) {
  $('#progress-message').textContent = job.message || 'Reading public business profiles…';
  $('#progress-title').textContent = job.status === 'cancelling'
    ? 'Wrapping up safely…'
    : job.stage === 'inspecting'
      ? 'Inspecting Google Maps business details…'
      : 'Navigating local directory…';
  let percent = 4;
  if (job.stage === 'collecting') percent = Math.min(25, 5 + (job.found || 0) / job.limit * 20);
  if (job.stage === 'inspecting') percent = 25 + (job.checked || 0) / Math.max(job.total || job.limit, 1) * 73;
  percent = Math.min(99, Math.round(percent));
  $('#progress-fill').style.width = `${percent}%`;
  $('.progress-track').setAttribute('aria-valuenow', percent);
  $('#progress-count').textContent = job.stage === 'inspecting'
    ? `${job.checked || 0} / ${job.total || job.limit} profiles checked`
    : `${job.found || 0} listings located`;
  if (job.status === 'cancelling') {
    $('#cancel-search').disabled = true;
    $('#cancel-search').textContent = 'Stopping…';
  }
}

async function pollJob() {
  if (!state.jobId || !state.busy) return;
  try {
    const job = await api(`/api/jobs/${state.jobId}`);
    state.pollErrors = 0;
    updateProgress(job);
    if (job.status === 'completed') {
      setBusy(false);
      state.jobId = null;
      renderResult(job.result);
      await Promise.all([refreshStatus(), refreshHistory()]);
      return;
    }
    if (job.status === 'failed') {
      setBusy(false);
      state.jobId = null;
      $('#empty-state').hidden = false;
      notice(job.error?.message || 'The search could not finish. Please try again later.', 'error');
      await refreshStatus();
      return;
    }
    if (job.status === 'cancelled') {
      setBusy(false);
      state.jobId = null;
      notice(job.message);
      await refreshStatus();
      return;
    }
  } catch (error) {
    state.pollErrors += 1;
    if (error.status === 404 || state.pollErrors >= 4) {
      setBusy(false);
      state.jobId = null;
      notice(error.message || 'The connection to the search was lost. A completed search may still be available in recent searches.', 'error');
      await refreshStatus();
      return;
    }
  }
  if (state.busy) state.timer = setTimeout(pollJob, 1300);
}

async function startSearch(event) {
  event.preventDefault();
  if (state.busy || !$('#search-form').reportValidity()) return;
  clearTimeout(state.timer);
  clearNotice();
  state.result = null;
  state.sort = 'default';
  state.filter = $('#only-missing').checked ? 'missing' : 'all';
  state.searchQuery = '';
  state.selectedIds.clear();
  if ($('#table-search')) $('#table-search').value = '';

  $('#results-subtitle').textContent = `Checking ${$('#niche').value.trim()} in ${$('#city').value.trim()}…`;
  setBusy(true);
  updateProgress({ stage: 'queued', message: 'Preparing your query…', limit: Number($('#limit').value) });
  try {
    const response = await api('/api/search', {
      method: 'POST',
      body: JSON.stringify({
        niche: $('#niche').value.trim(),
        city: $('#city').value.trim(),
        limit: Number($('#limit').value),
        only_missing: $('#only-missing').checked
      })
    });
    if (response.kind === 'cached') {
      setBusy(false);
      renderResult(response.result);
      toast('Loaded from cache instantly.');
      await refreshStatus();
    } else {
      state.jobId = response.job.id;
      state.pollErrors = 0;
      updateProgress(response.job);
      await refreshStatus();
      state.timer = setTimeout(pollJob, 1000);
    }
  } catch (error) {
    setBusy(false);
    state.jobId = null;
    notice(error.name === 'TimeoutError' ? 'The server took too long to respond. Please try again.' : error.message || 'Could not connect to the server.', 'error');
    await refreshStatus();
  }
}

function visibleRows() {
  if (!state.result) return [];
  let rows = state.result.businesses.filter(item => state.filter === 'all' || item.website_status === 'missing');
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase().trim();
    rows = rows.filter(item =>
      (item.name || '').toLowerCase().includes(q) ||
      (item.phone || '').toLowerCase().includes(q) ||
      (item.address || '').toLowerCase().includes(q) ||
      (item.category || '').toLowerCase().includes(q) ||
      (item.plus_code || '').toLowerCase().includes(q)
    );
  }
  if (state.sort !== 'default') {
    rows = [...rows].sort((a, b) => {
      if (a.rating == null) return 1;
      if (b.rating == null) return -1;
      return state.sort === 'desc' ? b.rating - a.rating : a.rating - b.rating;
    });
  }
  return rows;
}

function externalLink(url, className, text, iconName = 'external') {
  const anchor = node('a', className);
  anchor.href = safeLink(url);
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  if (text) anchor.append(document.createTextNode(text));
  anchor.append(icon(iconName));
  return anchor;
}

function websiteBadge(item) {
  const missing = item.website_status === 'missing';
  const badge = node('span', `website-badge ${missing ? 'missing' : 'linked'}`);
  badge.append(icon(missing ? 'spark' : 'check'), document.createTextNode(missing ? 'No website' : 'Linked'));
  return badge;
}

function updateExportButtonLabel() {
  const count = state.selectedIds.size;
  const exportBtn = $('#export-csv');
  const label = $('#export-csv-text') || exportBtn;
  if (count > 0) {
    label.textContent = `Export Selected (${count})`;
  } else {
    label.textContent = 'Download CSV';
  }
}

function renderTable() {
  const rows = visibleRows();
  const body = $('#results-body');
  body.replaceChildren();

  $('#result-count').textContent = rows.length;
  $('#result-count').hidden = false;
  $('#export-csv').disabled = rows.length === 0;
  $('#copy-all-phones').disabled = rows.length === 0;

  $('#table-summary').textContent = `${rows.length} ${state.filter === 'missing' ? 'leads' : 'businesses'} · ${state.result.inspected} profiles checked`;
  $('#table-footer-count').textContent = `${rows.length} listing${rows.length === 1 ? '' : 's'} in view`;
  $('#filter-control').hidden = false;
  $('#filter-control select').value = state.filter;

  $('#sort-rating').closest('th').setAttribute('aria-sort', state.sort === 'desc' ? 'descending' : state.sort === 'asc' ? 'ascending' : 'none');
  $('#sort-rating').title = state.sort === 'desc' ? 'Sort rating lowest first' : state.sort === 'asc' ? 'Restore default order' : 'Sort rating highest first';

  updateExportButtonLabel();

  const selectAllBox = $('#select-all');
  if (selectAllBox) {
    selectAllBox.checked = rows.length > 0 && rows.every(r => state.selectedIds.has(r.id || r.name));
    selectAllBox.indeterminate = rows.some(r => state.selectedIds.has(r.id || r.name)) && !selectAllBox.checked;
  }

  if (!rows.length) {
    const tr = node('tr');
    const td = node('td', 'no-matches');
    td.colSpan = 8;
    const hasProfiles = state.result.inspected > 0;
    td.append(node('strong', '', hasProfiles ? 'No listings match this filter.' : 'No listings found.'));
    td.append(document.createTextNode(hasProfiles ? 'Try clearing the search filter or switch to "All checked businesses".' : 'Try a broader niche or include a state/region.'));
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const item of rows) {
    const tr = node('tr');
    const itemId = item.id || item.name;

    // 1. Checkbox
    const tdCheck = node('td', 'td-checkbox');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedIds.has(itemId);
    checkbox.setAttribute('aria-label', `Select ${item.name}`);
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (checkbox.checked) state.selectedIds.add(itemId);
      else state.selectedIds.delete(itemId);
      updateExportButtonLabel();
      if (selectAllBox) {
        selectAllBox.checked = rows.every(r => state.selectedIds.has(r.id || r.name));
        selectAllBox.indeterminate = rows.some(r => state.selectedIds.has(r.id || r.name)) && !selectAllBox.checked;
      }
    });
    tdCheck.append(checkbox);

    // 2. Business name
    const business = node('td');
    business.dataset.label = 'Business';
    const button = node('button', 'business-button');
    button.type = 'button';
    button.setAttribute('aria-label', `View details for ${item.name}`);
    button.append(node('span', 'business-name', item.name), node('span', 'business-category', item.category || 'Local business'));
    button.addEventListener('click', () => openDetail(item));
    business.append(button);

    // 3. Phone with WhatsApp & Copy action buttons
    const phoneCell = node('td', 'phone-cell');
    phoneCell.dataset.label = 'Phone';
    if (item.phone) {
      const cleanDigits = item.phone.replace(/[^+\d]/g, '');
      const phoneBox = node('div', 'phone-box');
      phoneBox.append(node('span', 'phone-number', item.phone));

      const actions = node('div', 'cell-actions');
      // WhatsApp Direct Link
      if (cleanDigits.length >= 8) {
        const waNum = cleanDigits.startsWith('+') ? cleanDigits.slice(1) : (cleanDigits.length === 10 ? '91' + cleanDigits : cleanDigits);
        const waLink = node('a', 'action-chip wa-chip');
        waLink.href = `https://wa.me/${waNum}?text=${encodeURIComponent(`Hi ${item.name}, I found your business on Google Maps.`)}`;
        waLink.target = '_blank';
        waLink.rel = 'noopener noreferrer';
        waLink.title = 'Chat on WhatsApp';
        waLink.append(icon('whatsapp'));
        actions.append(waLink);
      }
      // Copy phone
      const copyBtn = node('button', 'action-chip copy-chip');
      copyBtn.type = 'button';
      copyBtn.title = 'Copy phone number';
      copyBtn.append(icon('copy'));
      copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copyText(item.phone); });
      actions.append(copyBtn);

      phoneBox.append(actions);
      phoneCell.append(phoneBox);
    } else {
      phoneCell.textContent = 'Not listed';
    }

    // 4. Rating
    const rating = node('td');
    rating.dataset.label = 'Rating';
    const ratingValue = node('span', 'rating-value');
    if (item.rating != null) {
      ratingValue.append(node('span', 'star', '★'), document.createTextNode(Number(item.rating).toFixed(1)));
    } else {
      ratingValue.textContent = '—';
    }
    rating.append(ratingValue);

    // 5. Reviews
    const reviews = node('td', 'reviews-cell', item.reviews == null ? '—' : Number(item.reviews).toLocaleString());
    reviews.dataset.label = 'Reviews';

    // 6. Address & Plus Code
    const address = node('td', 'address-cell');
    address.dataset.label = 'Address';
    address.append(node('div', 'address-text', item.address || 'Not listed'));
    if (item.plus_code) {
      address.append(node('div', 'plus-code-chip', item.plus_code));
    }
    if (item.hours) {
      const shortHours = item.hours.split(';')[0].replace(/Hours:\s*/i, '').trim();
      address.append(node('div', 'hours-chip', shortHours));
    }

    // 7. Website Badge
    const website = node('td');
    website.dataset.label = 'Website';
    website.append(websiteBadge(item));

    // 8. Actions / Maps link
    const actionsTd = node('td', 'actions-cell');
    actionsTd.dataset.label = 'Map';
    const link = externalLink(item.maps_url, 'map-link', '', 'external');
    link.setAttribute('aria-label', `Open ${item.name} on Google Maps`);
    link.title = 'Open Google Maps';
    actionsTd.append(link);

    tr.append(tdCheck, business, phoneCell, rating, reviews, address, website, actionsTd);
    body.append(tr);
  }
}

function renderResult(result) {
  state.result = result;
  state.filter = result.only_missing ? 'missing' : 'all';
  state.searchQuery = '';
  state.selectedIds.clear();
  if ($('#table-search')) $('#table-search').value = '';

  $('#empty-state').hidden = true;
  $('#table-container').hidden = false;
  $('#results-subtitle').textContent = `${result.niche} in ${result.city} · Extracted from Google Maps`;

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
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  let rows = visibleRows();
  if (!rows.length || !state.result) return;

  // If items are specifically selected, export only selected
  if (state.selectedIds.size > 0) {
    rows = rows.filter(item => state.selectedIds.has(item.id || item.name));
  }

  const headers = [
    'Business name',
    'Category',
    'Business phone',
    'Address',
    'Plus code',
    'Operating hours',
    'Rating',
    'Review count',
    'Website URL',
    'Website status',
    'Google Maps URL',
    'Observed at (UTC)',
    'Niche',
    'City'
  ];

  const records = rows.map(item => [
    item.name,
    item.category,
    item.phone,
    item.address,
    item.plus_code || '',
    item.hours || '',
    item.rating,
    item.reviews,
    item.website,
    item.website_status === 'missing' ? 'No website linked' : 'Website linked',
    item.maps_url,
    item.observed_at,
    state.result.niche,
    state.result.city
  ]);

  const csv = '\uFEFF' + [headers, ...records].map(record => record.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const slug = value => value.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 55);
  const link = node('a');
  link.href = url;
  link.download = `leads-${slug(state.result.niche)}-${slug(state.result.city)}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(`${rows.length} lead${rows.length === 1 ? '' : 's'} exported to CSV.`);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = node('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    ($('#detail-dialog').open ? $('#detail-dialog') : document.body).append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) {
      toast('Copy unavailable. Please select text manually.');
      return;
    }
  }
  toast('Copied to clipboard.');
}

function openDetail(item) {
  $('#detail-title').textContent = item.name;
  $('#detail-category').textContent = item.category || 'LOCAL BUSINESS';
  $('#detail-status').replaceChildren(websiteBadge(item));
  const fields = $('#detail-fields');
  fields.replaceChildren();

  const add = (label, content) => {
    const row = node('div');
    row.append(node('dt', '', label), node('dd', '', typeof content === 'string' ? content : ''));
    if (typeof content !== 'string') row.lastChild.append(content);
    fields.append(row);
  };

  if (item.phone) {
    const phoneWrap = node('div', 'detail-phone');
    const link = node('a', '', item.phone);
    link.href = `tel:${item.phone.replace(/[^+\d]/g, '')}`;

    const copy = node('button', 'icon-button');
    copy.type = 'button';
    copy.title = 'Copy phone number';
    copy.append(icon('copy'));
    copy.addEventListener('click', () => copyText(item.phone));

    phoneWrap.append(link, copy);
    add('Phone', phoneWrap);
  } else {
    add('Phone', 'Not listed on Google Maps');
  }

  add('Address', item.address || 'Not listed');
  if (item.plus_code) add('Plus Code', item.plus_code);
  if (item.hours) add('Hours', item.hours);
  add('Rating', item.rating == null ? 'Not available' : `${Number(item.rating).toFixed(1)} out of 5`);
  add('Reviews', item.reviews == null ? 'Not available' : Number(item.reviews).toLocaleString());

  if (item.website) {
    const hostname = new URL(item.website).hostname;
    add('Website', externalLink(item.website, '', hostname));
  } else {
    add('Website', 'No website link on this Maps profile (Opportunity)');
  }

  if (item.appointment_url) {
    add('Appointments', externalLink(item.appointment_url, '', 'Booking / Reserve Link'));
  }

  $('#detail-observed').textContent = `Read from Google Maps · ${dateLabel(item.observed_at)}. Verify details before outreach.`;
  $('#detail-map').href = safeLink(item.maps_url);

  // WhatsApp Button in Modal
  if (item.phone) {
    const digits = item.phone.replace(/[^+\d]/g, '');
    const waNum = digits.startsWith('+') ? digits.slice(1) : (digits.length === 10 ? '91' + digits : digits);
    $('#detail-whatsapp').href = `https://wa.me/${waNum}?text=${encodeURIComponent(`Hi ${item.name}, I came across your business on Google Maps.`)}`;
    $('#detail-whatsapp').hidden = false;
  } else {
    $('#detail-whatsapp').hidden = true;
  }

  $('#detail-website').hidden = !item.website;
  if (item.website) $('#detail-website').href = safeLink(item.website);
  $('#detail-dialog').showModal();
}

// Event Listeners
$('#search-form').addEventListener('submit', startSearch);
$('#dismiss-notice').addEventListener('click', clearNotice);
$('#export-csv').addEventListener('click', exportCsv);
$('#result-filter').addEventListener('change', event => { state.filter = event.target.value; renderTable(); });
$('#sort-rating').addEventListener('click', () => {
  state.sort = state.sort === 'default' ? 'desc' : state.sort === 'desc' ? 'asc' : 'default';
  renderTable();
});

// Copy all phones button
$('#copy-all-phones').addEventListener('click', () => {
  const rows = visibleRows();
  const phones = rows.map(r => r.phone).filter(p => p && p !== 'Not listed');
  if (!phones.length) {
    toast('No phone numbers found in current view.');
    return;
  }
  const uniquePhones = [...new Set(phones)];
  copyText(uniquePhones.join('\n'));
  toast(`${uniquePhones.length} phone numbers copied to clipboard!`);
});

// Select all checkbox
$('#select-all')?.addEventListener('change', (e) => {
  const rows = visibleRows();
  if (e.target.checked) {
    rows.forEach(r => state.selectedIds.add(r.id || r.name));
  } else {
    state.selectedIds.clear();
  }
  renderTable();
});

// Instant live search filter
$('#table-search')?.addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  renderTable();
});

$('#cancel-search').addEventListener('click', async () => {
  if (!state.jobId) return;
  $('#cancel-search').disabled = true;
  $('#cancel-search').textContent = 'Stopping…';
  try {
    await api(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' });
  } catch (error) {
    notice(error.message, 'error');
    $('#cancel-search').disabled = false;
  }
});

$$('[data-niche]').forEach(button => button.addEventListener('click', () => {
  if (state.busy) return;
  $('#niche').value = button.dataset.niche;
  $('#city').value = button.dataset.city;
  $('#niche').focus();
  toast('Filled in. Hit "Find businesses" to start.');
}));

$$('[data-open-help]').forEach(button => button.addEventListener('click', () => $('#help-dialog').showModal()));
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
    dialog.close();
  }
}));

// Quick keyboard shortcut "/" to focus niche search input
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    $('#niche')?.focus();
  }
});

async function initApp() {
  await Promise.all([refreshStatus(), refreshHistory()]);
  if (!state.result && !state.busy) {
    try {
      const { searches } = await api('/api/history');
      if (searches && searches.length > 0) {
        const item = searches[0];
        $('#niche').value = item.niche;
        $('#city').value = item.city;
        $('#limit').value = item.limit;
        const res = await api('/api/search', {
          method: 'POST',
          body: JSON.stringify({ niche: item.niche, city: item.city, limit: item.limit, only_missing: true })
        });
        if (res.kind === 'cached' && res.result) {
          renderResult(res.result);
        }
      }
    } catch { /* Fallback */ }
  }
}

initApp();
