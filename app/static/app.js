/* SparkXFlow Prospecting & Lead Intelligence Platform
   Full-Stack Architecture: Playwright Headless Automation + SQLite CRM + Diagnostic Audit Studio */
'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  currentView: 'overview',
  result: null,
  jobId: null,
  busy: false,
  filter: 'missing',
  activePill: 'all',
  sort: 'default',
  timer: null,
  pollErrors: 0,
  status: null,
  searchQuery: '',
  selectedIds: new Set(),
  theme: localStorage.getItem('sparkxflow_theme') || 'midnight',
  sidebarCollapsed: localStorage.getItem('sparkxflow_sidebar_collapsed') === 'true',
  crmStatus: 'ALL',
  crmListFilter: '',
  crmSearch: '',
  editingLeadId: null,
  activeDetailItem: null,
  savedLeads: [],
  lists: []
};

/* ==========================================================================
   DOM & Utility Helpers
   ========================================================================== */

function node(tag, className = '', text = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== '') el.textContent = text;
  return el;
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
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(30000)
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      const timeoutErr = new Error('Server took too long to reply. Retrying…');
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    const netErr = new Error('Network connection issue. Retrying…');
    netErr.status = 0;
    throw netErr;
  }

  let data = null;
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  if (isJson) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    if ([502, 503, 504].includes(response.status)) {
      const busyErr = new Error('Server is warming up or busy. Retrying in a moment…');
      busyErr.status = response.status;
      throw busyErr;
    }
    const message = (data && typeof data.detail === 'string')
      ? data.detail
      : (data && Array.isArray(data.detail))
        ? data.detail.map(item => item.msg).join(' ')
        : `Request error (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  if (!data && !isJson) {
    throw new Error('Server returned an unexpected response format.');
  }

  return data;
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  const toastEl = $('#toast');
  if (!toastEl) return;
  toastEl.querySelector('span').textContent = message;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3600);
}

function notice(message, type = 'info') {
  const noticeEl = $('#notice');
  if (!noticeEl) return;
  $('#notice-text').textContent = message;
  noticeEl.className = `notice ${type}`;
  noticeEl.setAttribute('role', type === 'error' ? 'alert' : 'status');
  noticeEl.hidden = false;
}

function clearNotice() {
  const noticeEl = $('#notice');
  if (noticeEl) noticeEl.hidden = true;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = node('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copied to clipboard.');
}

/* ==========================================================================
   Multi-View Router & Sidebar Management
   ========================================================================== */

const VIEW_TITLES = {
  overview: 'Overview',
  finder: 'Business Finder',
  'saved-leads': 'Saved Leads',
  lists: 'Lead Lists',
  audit: 'Website Audit Studio',
  enrichment: 'Contact Enrichment',
  campaigns: 'Outreach Campaigns',
  settings: 'Preferences & Storage'
};

function switchView(viewName) {
  if (!VIEW_TITLES[viewName]) viewName = 'overview';
  state.currentView = viewName;

  // 1. Update navigation active state
  $$('#app-sidebar .nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });

  // 2. Update topbar breadcrumb
  const breadcrumbEl = $('#breadcrumb-current-view');
  if (breadcrumbEl) {
    breadcrumbEl.textContent = VIEW_TITLES[viewName];
  }

  // 3. Switch active workspace container
  $$('.workspace-view').forEach(view => {
    view.classList.remove('active');
  });
  const targetView = $(`#view-${viewName}`);
  if (targetView) {
    targetView.classList.add('active');
  }

  // 4. Update URL hash without causing a page jump
  if (window.location.hash.replace('#', '') !== viewName) {
    history.replaceState(null, '', `#${viewName}`);
  }

  // 5. Trigger view-specific data refresh
  if (viewName === 'overview') {
    loadPlatformMetrics();
    refreshHistory();
  } else if (viewName === 'saved-leads') {
    loadSavedLeads();
    loadLeadLists();
  } else if (viewName === 'lists') {
    loadLeadLists();
  } else if (viewName === 'audit') {
    loadRecentAudits();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initSidebar() {
  const sidebar = $('#app-sidebar');
  const appShell = $('#app-shell');
  const collapseBtn = $('#sidebar-collapse-btn');

  if (state.sidebarCollapsed) {
    sidebar?.classList.add('collapsed');
    appShell?.classList.add('sidebar-collapsed');
  }

  collapseBtn?.addEventListener('click', () => {
    const isCollapsed = sidebar.classList.toggle('collapsed');
    appShell?.classList.toggle('sidebar-collapsed', isCollapsed);
    state.sidebarCollapsed = isCollapsed;
    localStorage.setItem('sparkxflow_sidebar_collapsed', isCollapsed ? 'true' : 'false');
  });

  // Wire all nav items
  $$('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Wire quick action cards in Overview
  $$('[data-view-jump]').forEach(card => {
    card.addEventListener('click', () => switchView(card.dataset.viewJump));
  });
}

/* ==========================================================================
   Platform Metrics & Overview Intelligence
   ========================================================================== */

async function loadPlatformMetrics() {
  try {
    const data = await api('/api/metrics');
    if (!data) return;

    if ($('#stat-inspected')) $('#stat-inspected').textContent = Number(data.total_discovered_businesses || 0).toLocaleString();
    if ($('#stat-missing')) {
      $('#stat-missing').replaceChildren(
        document.createTextNode(Number(data.missing_website_leads || 0).toLocaleString()),
        node('span', 'stat-tag', 'OPPORTUNITIES')
      );
    }
    if ($('#stat-share')) {
      const share = data.total_discovered_businesses ? Math.round((data.missing_website_leads / data.total_discovered_businesses) * 100) : 0;
      $('#stat-share').replaceChildren(document.createTextNode(share), node('span', 'stat-percent', '%'));
    }

    // Sidebar & CRM Badges
    const leadsBadge = $('#nav-leads-badge');
    if (leadsBadge) leadsBadge.textContent = data.saved_leads_count || 0;
    const listsBadge = $('#nav-lists-badge');
    if (listsBadge) listsBadge.textContent = data.lead_lists_count || 0;

    // Status Tab Badges
    if ($('#crm-count-all')) $('#crm-count-all').textContent = data.saved_leads_count || 0;
    if (data.leads_by_status) {
      Object.entries(data.leads_by_status).forEach(([st, cnt]) => {
        const badge = $(`#crm-count-${st.toLowerCase()}`);
        if (badge) badge.textContent = cnt;
      });
    }
  } catch (err) {
    console.warn('Metrics refresh skipped:', err);
  }
}

/* ==========================================================================
   Canvas & Mouse Spotlights (Aceternity UI Grid)
   ========================================================================== */

function initAceternityCubesGrid() {
  const canvas = document.getElementById('bg-cubes-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width = (canvas.width = window.innerWidth);
  let height = (canvas.height = window.innerHeight);

  window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  });

  const mouse = { x: width / 2, y: height / 2, targetX: width / 2, targetY: height / 2 };

  window.addEventListener('mousemove', e => {
    mouse.targetX = e.clientX;
    mouse.targetY = e.clientY;
    document.documentElement.style.setProperty('--mouse-x', `${e.clientX}px`);
    document.documentElement.style.setProperty('--mouse-y', `${e.clientY}px`);
  });

  const cubeSize = 44;
  let time = 0;

  function draw() {
    time += 0.015;
    mouse.x += (mouse.targetX - mouse.x) * 0.08;
    mouse.y += (mouse.targetY - mouse.y) * 0.08;

    ctx.clearRect(0, 0, width, height);
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';

    const cols = Math.ceil(width / cubeSize) + 4;
    const rows = Math.ceil(height / (cubeSize * 0.6)) + 4;

    for (let r = -2; r < rows; r++) {
      for (let c = -2; c < cols; c++) {
        const x = c * cubeSize + (r % 2 === 0 ? 0 : cubeSize / 2);
        const y = r * (cubeSize * 0.6);

        const dx = x - mouse.x;
        const dy = y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        const maxDist = 320;
        let intensity = 0;
        if (dist < maxDist) {
          intensity = Math.pow(1 - dist / maxDist, 1.8);
        }

        const wave = Math.sin(time + (x + y) * 0.006) * 0.5 + 0.5;

        // Draw cube polygon
        ctx.beginPath();
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x + 18, y);
        ctx.lineTo(x, y + 8);
        ctx.lineTo(x - 18, y);
        ctx.closePath();

        if (intensity > 0.02) {
          ctx.fillStyle = `rgba(22, 133, 248, ${(intensity * 0.28).toFixed(3)})`;
          ctx.strokeStyle = `rgba(22, 133, 248, ${(intensity * 0.6 + 0.1).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
        } else {
          const baseAlpha = isLight ? (0.02 + wave * 0.02) : (0.012 + wave * 0.018);
          ctx.strokeStyle = isLight ? `rgba(100, 116, 139, ${baseAlpha.toFixed(3)})` : `rgba(255, 255, 255, ${baseAlpha.toFixed(3)})`;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

function initSpotlightCards() {
  $$('.spotlight-card').forEach(card => {
    card.addEventListener('mousemove', e => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      card.style.setProperty('--spotlight-x', `${x}px`);
      card.style.setProperty('--spotlight-y', `${y}px`);
    });
  });
}

/* ==========================================================================
   Theme Management
   ========================================================================== */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('sparkxflow_theme', theme);
  state.theme = theme;
  const iconUse = $('#theme-icon use');
  if (iconUse) {
    iconUse.setAttribute('href', theme === 'light' ? '#i-sun' : '#i-moon');
  }
}

function cycleTheme() {
  const themes = ['midnight', 'dark', 'light'];
  const next = themes[(themes.indexOf(state.theme) + 1) % themes.length];
  applyTheme(next);
  toast(`Switched theme to ${next.toUpperCase()}`);
}

/* ==========================================================================
   Status & Search History
   ========================================================================== */

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    state.status = status;
    $('#allowance-text').textContent = 'Unlimited searches';
    $('#allowance-fill').style.width = '100%';
    $('.allowance-meta span:last-child').textContent = 'Engine Live';
    $('#quota-note').textContent = 'Unlimited searches enabled';
    if ($('#kpi-allowance')) $('#kpi-allowance').textContent = 'Unlimited';
    $('#cache-days-note').textContent = status.cache_days;
    $$('.cache-days-copy').forEach(el => { el.textContent = status.cache_days; });
  } catch { /* Non-blocking */ }
}

async function refreshHistory() {
  try {
    const { searches } = await api('/api/history');
    const list = $('#recent-list');
    if (!list) return;
    list.replaceChildren();
    if (!searches || searches.length === 0) {
      list.append(node('p', 'table-empty-sub', 'No cached searches yet. Run your first search above.'));
      return;
    }
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
        switchView('finder');
        $('#search-form').requestSubmit();
      });
      list.append(button);
    }
  } catch { /* Non-blocking */ }
}

/* ==========================================================================
   Business Finder Search & Polling
   ========================================================================== */

function setBusy(busy) {
  state.busy = busy;
  $$('#search-form input, #search-form select, #search-button, [data-niche], .recent-item, .tag-pill').forEach(el => {
    el.disabled = busy;
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
    $('#copy-sheets').disabled = true;
    $('#save-selected-leads').disabled = true;
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

function playSuccessChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(587.33, t); // D5
    osc.frequency.setValueAtTime(880, t + 0.1); // A5
    gain.gain.setValueAtTime(0.07, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.start(t);
    osc.stop(t + 0.4);
  } catch {}
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
      playSuccessChime();
      await Promise.all([refreshStatus(), refreshHistory(), loadPlatformMetrics()]);
      return;
    }
    if (job.status === 'failed') {
      setBusy(false);
      state.jobId = null;
      $('#empty-state').hidden = false;
      notice(job.error?.message || 'Search could not finish. Please try again.', 'error');
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
    if (error.status === 404 || state.pollErrors >= 8) {
      setBusy(false);
      state.jobId = null;
      notice(error.message || 'Connection lost. Check recent searches.', 'error');
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
      await Promise.all([refreshStatus(), loadPlatformMetrics()]);
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
    notice(error.name === 'TimeoutError' ? 'Server took too long to respond. Try again.' : error.message || 'Could not connect to server.', 'error');
    await refreshStatus();
  }
}

/* ==========================================================================
   Table Rendering & Multi-Actions
   ========================================================================== */

function visibleRows() {
  if (!state.result) return [];
  let rows = state.result.businesses.filter(item => state.filter === 'all' || item.website_status === 'missing');
  
  if (state.activePill && state.activePill !== 'all') {
    if (state.activePill === 'missing') {
      rows = rows.filter(item => item.website_status === 'missing');
    } else if (state.activePill === 'phone') {
      rows = rows.filter(item => Boolean(item.phone && item.phone !== 'Not listed'));
    } else if (state.activePill === 'unclaimed') {
      rows = rows.filter(item => item.is_claimed === false);
    } else if (state.activePill === 'top-rated') {
      rows = rows.filter(item => item.rating && item.rating >= 4.5);
    } else if (state.activePill === 'needs-reviews') {
      rows = rows.filter(item => !item.reviews || item.reviews < 15);
    }
  }

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

function websiteBadge(item) {
  const missing = item.website_status === 'missing';
  const badge = node('span', `website-badge ${missing ? 'missing' : 'linked'}`);
  badge.append(icon(missing ? 'spark' : 'check'), document.createTextNode(missing ? 'No website' : 'Linked'));
  return badge;
}

function updateExportButtonLabel() {
  const count = state.selectedIds.size;
  const label = $('#export-csv-text') || $('#export-csv');
  if (count > 0) {
    label.textContent = `Export Selected (${count})`;
    if ($('#save-selected-leads')) $('#save-selected-leads').textContent = `Save Selected (${count})`;
    if ($('#save-selected-leads')) $('#save-selected-leads').disabled = false;
  } else {
    label.textContent = 'Download CSV';
    if ($('#save-selected-leads')) $('#save-selected-leads').textContent = 'Save to Leads';
    if ($('#save-selected-leads')) $('#save-selected-leads').disabled = true;
  }
}

async function saveLeadToCRM(business, listName = null) {
  try {
    await api('/api/leads', {
      method: 'POST',
      body: JSON.stringify({
        name: business.name,
        category: business.category,
        phone: business.phone,
        address: business.address,
        rating: business.rating,
        reviews: business.reviews,
        website: business.website,
        website_status: business.website_status,
        maps_url: business.maps_url,
        plus_code: business.plus_code,
        status: 'NEW',
        list_name: listName,
        source: 'Google Maps'
      })
    });
    toast(`Saved "${business.name}" to CRM Leads!`);
    loadPlatformMetrics();
  } catch (err) {
    notice(err.message, 'error');
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
  if ($('#copy-sheets')) $('#copy-sheets').disabled = rows.length === 0;

  $('#table-summary').textContent = `${rows.length} ${state.filter === 'missing' ? 'leads' : 'businesses'} · ${state.result.inspected} profiles checked`;
  $('#table-footer-count').textContent = `${rows.length} listing${rows.length === 1 ? '' : 's'} in view`;
  $('#filter-control').hidden = false;
  $('#filter-control select').value = state.filter;

  $('#sort-rating').closest('th').setAttribute('aria-sort', state.sort === 'desc' ? 'descending' : state.sort === 'asc' ? 'ascending' : 'none');

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
    td.append(node('strong', '', 'No listings match this filter.'));
    td.append(document.createTextNode('Try searching another niche or switch to "All checked businesses".'));
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
    checkbox.addEventListener('change', e => {
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

    // 2. Business name (Styled cleanly with zero native button borders)
    const business = node('td');
    business.dataset.label = 'Business';
    const button = node('button', 'business-button');
    button.type = 'button';
    button.setAttribute('aria-label', `View details for ${item.name}`);
    button.append(node('span', 'business-name', item.name), node('span', 'business-category', item.category || 'Local business'));
    button.addEventListener('click', () => openDetail(item));
    business.append(button);

    // 3. Phone with WhatsApp & Copy Micro-Actions
    const phoneCell = node('td', 'phone-cell');
    phoneCell.dataset.label = 'Phone';
    if (item.phone) {
      const cleanDigits = item.phone.replace(/[^+\d]/g, '');
      const phoneBox = node('div', 'phone-box');
      phoneBox.append(node('span', 'phone-number', item.phone));

      const actions = node('div', 'cell-actions');
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
      const copyBtn = node('button', 'action-chip copy-chip');
      copyBtn.type = 'button';
      copyBtn.title = 'Copy phone number';
      copyBtn.append(icon('copy'));
      copyBtn.addEventListener('click', e => { e.stopPropagation(); copyText(item.phone); });
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
    if (item.plus_code) address.append(node('div', 'plus-code-chip', item.plus_code));

    // 7. Website Badge
    const website = node('td');
    website.dataset.label = 'Website';
    website.append(websiteBadge(item));

    // 8. Row Actions (Save Lead, Audit, Maps)
    const actionsTd = node('td', 'actions-cell');
    actionsTd.dataset.label = 'Actions';

    const saveBtn = node('button', 'action-chip', '');
    saveBtn.type = 'button';
    saveBtn.title = 'Save to CRM Leads';
    saveBtn.append(icon('bookmark'));
    saveBtn.addEventListener('click', e => {
      e.stopPropagation();
      saveLeadToCRM(item);
    });
    actionsTd.append(saveBtn);

    if (item.website) {
      const auditBtn = node('button', 'action-chip', '');
      auditBtn.type = 'button';
      auditBtn.title = 'Run Diagnostic Audit on Website';
      auditBtn.append(icon('activity'));
      auditBtn.addEventListener('click', e => {
        e.stopPropagation();
        switchView('audit');
        $('#audit-url-input').value = item.website;
        $('#audit-form').requestSubmit();
      });
      actionsTd.append(auditBtn);
    }

    const mapLink = externalLink(item.maps_url, 'action-chip', '', 'external');
    mapLink.title = 'Open on Google Maps';
    actionsTd.append(mapLink);

    tr.append(tdCheck, business, phoneCell, rating, reviews, address, website, actionsTd);
    body.append(tr);
  }
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

  if (state.selectedIds.size > 0) {
    rows = rows.filter(item => state.selectedIds.has(item.id || item.name));
  }

  const headers = ['Business name', 'Category', 'Phone', 'Address', 'Plus code', 'Rating', 'Reviews', 'Website', 'Website status', 'Google Maps URL'];
  const records = rows.map(item => [
    item.name,
    item.category,
    item.phone,
    item.address,
    item.plus_code || '',
    item.rating,
    item.reviews,
    item.website,
    item.website_status === 'missing' ? 'No website linked' : 'Website linked',
    item.maps_url
  ]);

  const csv = '\uFEFF' + [headers, ...records].map(record => record.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = node('a');
  link.href = url;
  link.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(`${rows.length} lead${rows.length === 1 ? '' : 's'} exported to CSV.`);
}

async function copyForGoogleSheets() {
  const rows = visibleRows();
  if (!rows.length) return toast('No businesses to copy.');
  const headers = ['Business Name', 'Category', 'Phone', 'Address', 'Rating', 'Reviews', 'Website', 'Website Status', 'Google Maps Link'];
  const tsvLines = [headers.join('\t')];
  for (const b of rows) {
    tsvLines.push([
      b.name || '',
      b.category || '',
      b.phone || '',
      b.address || '',
      b.rating != null ? String(b.rating) : '',
      b.reviews != null ? String(b.reviews) : '',
      b.website || '',
      b.website_status === 'missing' ? 'No website' : 'Linked',
      b.maps_url || ''
    ].map(val => String(val).replace(/[\t\r\n]/g, ' ')).join('\t'));
  }
  const tsv = tsvLines.join('\n');
  try {
    await navigator.clipboard.writeText(tsv);
    toast(`Copied ${rows.length} leads! Paste directly into Google Sheets (Ctrl+V)`);
  } catch {
    copyText(tsv);
  }
}

/* ==========================================================================
   Saved Leads CRM
   ========================================================================== */

async function loadSavedLeads() {
  try {
    const params = new URLSearchParams();
    if (state.crmStatus && state.crmStatus !== 'ALL') params.append('status', state.crmStatus);
    if (state.crmListFilter) params.append('list_name', state.crmListFilter);
    if (state.crmSearch) params.append('search', state.crmSearch);

    const data = await api(`/api/leads?${params.toString()}`);
    state.savedLeads = data.leads || [];
    renderSavedLeadsTable();
  } catch (err) {
    notice(err.message, 'error');
  }
}

function renderSavedLeadsTable() {
  const body = $('#crm-results-body');
  const emptyState = $('#crm-empty-state');
  const tableContainer = $('#crm-table-container');
  if (!body) return;

  body.replaceChildren();

  if (!state.savedLeads.length) {
    emptyState.hidden = false;
    tableContainer.hidden = true;
    return;
  }

  emptyState.hidden = true;
  tableContainer.hidden = false;

  for (const lead of state.savedLeads) {
    const tr = node('tr');

    // 1. Lead Name & Category
    const tdName = node('td');
    const nameBtn = node('button', 'business-button');
    nameBtn.type = 'button';
    nameBtn.append(node('span', 'business-name', lead.name), node('span', 'business-category', lead.category || 'Lead'));
    nameBtn.addEventListener('click', () => openDetail(lead));
    tdName.append(nameBtn);

    // 2. Phone & WhatsApp
    const tdPhone = node('td', 'phone-cell');
    if (lead.phone) {
      const cleanDigits = lead.phone.replace(/[^+\d]/g, '');
      const phoneBox = node('div', 'phone-box');
      phoneBox.append(node('span', 'phone-number', lead.phone));

      const actions = node('div', 'cell-actions');
      if (cleanDigits.length >= 8) {
        const waNum = cleanDigits.startsWith('+') ? cleanDigits.slice(1) : (cleanDigits.length === 10 ? '91' + cleanDigits : cleanDigits);
        const waLink = node('a', 'action-chip wa-chip');
        waLink.href = `https://wa.me/${waNum}?text=${encodeURIComponent(`Hi ${lead.name}, reaching out regarding your business.`)}`;
        waLink.target = '_blank';
        waLink.rel = 'noopener noreferrer';
        waLink.title = 'Chat on WhatsApp';
        waLink.append(icon('whatsapp'));
        actions.append(waLink);
      }
      const copyBtn = node('button', 'action-chip copy-chip');
      copyBtn.type = 'button';
      copyBtn.title = 'Copy phone';
      copyBtn.append(icon('copy'));
      copyBtn.addEventListener('click', () => copyText(lead.phone));
      actions.append(copyBtn);

      phoneBox.append(actions);
      tdPhone.append(phoneBox);
    } else {
      tdPhone.textContent = 'Not listed';
    }

    // 3. Location
    const tdLoc = node('td', 'address-cell');
    tdLoc.append(node('div', 'address-text', lead.address || '—'));

    // 4. Website
    const tdWeb = node('td');
    tdWeb.append(websiteBadge(lead));

    // 5. Status Selector Dropdown
    const tdStatus = node('td');
    const select = node('select', `status-select status-${lead.status.toLowerCase()}`);
    ['NEW', 'QUALIFIED', 'CONTACTED', 'INTERESTED', 'CONVERTED', 'REJECTED'].forEach(st => {
      const opt = node('option', '', st);
      opt.value = st;
      opt.selected = lead.status === st;
      select.append(opt);
    });
    select.addEventListener('change', async () => {
      try {
        await api(`/api/leads/${lead.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: select.value })
        });
        select.className = `status-select status-${select.value.toLowerCase()}`;
        toast(`Updated "${lead.name}" status to ${select.value}`);
        loadPlatformMetrics();
      } catch (err) {
        notice(err.message, 'error');
      }
    });
    tdStatus.append(select);

    // 6. List Badge
    const tdList = node('td');
    if (lead.list_name) {
      const listPill = node('span', 'tag-pill', lead.list_name);
      listPill.style.fontSize = '10.5px';
      tdList.append(listPill);
    } else {
      tdList.textContent = '—';
    }

    // 7. Notes Chip
    const tdNotes = node('td');
    const notesBtn = node('button', `notes-chip ${lead.notes ? 'has-note' : ''}`);
    notesBtn.type = 'button';
    notesBtn.append(icon('edit'), document.createTextNode(lead.notes ? lead.notes.slice(0, 18) + '…' : '+ Note'));
    notesBtn.addEventListener('click', () => openLeadNoteModal(lead));
    tdNotes.append(notesBtn);

    // 8. Delete & Dossier Actions
    const tdActions = node('td', 'actions-cell');
    const delBtn = node('button', 'action-chip', '');
    delBtn.type = 'button';
    delBtn.title = 'Remove lead';
    delBtn.append(icon('trash'));
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete lead "${lead.name}"?`)) return;
      try {
        await api(`/api/leads/${lead.id}`, { method: 'DELETE' });
        toast(`Removed lead "${lead.name}"`);
        loadSavedLeads();
        loadPlatformMetrics();
      } catch (err) {
        notice(err.message, 'error');
      }
    });
    tdActions.append(delBtn);

    tr.append(tdName, tdPhone, tdLoc, tdWeb, tdStatus, tdList, tdNotes, tdActions);
    body.append(tr);
  }
}

function openLeadNoteModal(lead) {
  state.editingLeadId = lead.id;
  $('#note-dialog-title').textContent = `Note for ${lead.name}`;
  $('#lead-note-input').value = lead.notes || '';
  $('#lead-note-dialog').showModal();
}

async function saveLeadNote() {
  if (!state.editingLeadId) return;
  const noteText = $('#lead-note-input').value.trim();
  try {
    await api(`/api/leads/${state.editingLeadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: noteText })
    });
    $('#lead-note-dialog').close();
    toast('Lead notes saved!');
    loadSavedLeads();
  } catch (err) {
    notice(err.message, 'error');
  }
}

/* ==========================================================================
   Lead Lists Manager
   ========================================================================== */

async function loadLeadLists() {
  try {
    const data = await api('/api/lists');
    state.lists = data.lists || [];
    renderListsGrid();

    // Populate CRM list filter dropdown
    const filterSelect = $('#crm-list-filter');
    if (filterSelect) {
      filterSelect.replaceChildren(node('option', '', 'All Lists'));
      filterSelect.firstChild.value = '';
      for (const l of state.lists) {
        const opt = node('option', '', `${l.name} (${l.lead_count})`);
        opt.value = l.name;
        opt.selected = state.crmListFilter === l.name;
        filterSelect.append(opt);
      }
    }
  } catch (err) {
    console.warn('Lists load failed:', err);
  }
}

function renderListsGrid() {
  const container = $('#lists-container');
  if (!container) return;
  container.replaceChildren();

  if (!state.lists.length) {
    container.append(node('p', 'table-empty-sub', 'No segmented lists created yet. Create one above to organize your leads.'));
    return;
  }

  const colors = ['#1685F8', '#16C784', '#F5A623', '#8B5CF6', '#06B6D4', '#EC4899'];
  state.lists.forEach((list, idx) => {
    const card = node('div', 'list-card spotlight-card');
    card.dataset.spotlight = 'true';

    const top = node('div');
    const header = node('div', 'list-card-header');
    const titleGroup = node('div', '', '');
    titleGroup.style.display = 'flex';
    titleGroup.style.alignItems = 'center';
    titleGroup.style.gap = '8px';

    const dot = node('span', 'list-color-tag');
    dot.style.background = colors[idx % colors.length];
    titleGroup.append(dot, node('h3', 'list-title', list.name));

    const countBadge = node('span', 'nav-badge', `${list.lead_count} leads`);
    header.append(titleGroup, countBadge);
    top.append(header);

    if (list.description) {
      top.append(node('p', 'list-desc', list.description));
    }
    card.append(top);

    const footer = node('div', 'list-card-footer');
    footer.append(node('span', '', dateLabel(list.created_at)));

    const actions = node('div', '', '');
    actions.style.display = 'flex';
    actions.style.gap = '6px';

    const viewBtn = node('button', 'secondary-button small', 'View Leads');
    viewBtn.type = 'button';
    viewBtn.addEventListener('click', () => {
      state.crmListFilter = list.name;
      switchView('saved-leads');
    });

    const delBtn = node('button', 'action-chip', '');
    delBtn.type = 'button';
    delBtn.title = 'Delete list';
    delBtn.append(icon('trash'));
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete list "${list.name}"?`)) return;
      try {
        await api(`/api/lists/${encodeURIComponent(list.name)}`, { method: 'DELETE' });
        toast(`Deleted list "${list.name}"`);
        loadLeadLists();
        loadPlatformMetrics();
      } catch (err) {
        notice(err.message, 'error');
      }
    });

    actions.append(viewBtn, delBtn);
    footer.append(actions);
    card.append(footer);

    container.append(card);
  });
  initSpotlightCards();
}

/* ==========================================================================
   Website Audit Diagnostic Studio
   ========================================================================== */

async function runWebsiteAudit(event) {
  event.preventDefault();
  const urlInput = $('#audit-url-input');
  const submitBtn = $('#audit-submit-btn');
  const resultsContainer = $('#audit-results-container');
  if (!urlInput || !urlInput.reportValidity()) return;

  const url = urlInput.value.trim();
  submitBtn.disabled = true;
  submitBtn.replaceChildren(icon('globe', 'spinner'), node('span', '', 'Probing Website…'));

  try {
    const data = await api('/api/audit', {
      method: 'POST',
      body: JSON.stringify({ url })
    });

    resultsContainer.hidden = false;

    // Scorecard KPIs
    const statusVal = $('#audit-kpi-status');
    statusVal.textContent = data.status_code ? `${data.status_code} OK` : 'Unreachable';
    statusVal.style.color = data.status_code === 200 ? 'var(--accent-green)' : 'var(--accent-danger)';

    const latencyVal = $('#audit-kpi-latency');
    if (data.response_time_ms != null) {
      latencyVal.textContent = `${data.response_time_ms}ms`;
      latencyVal.className = `audit-kpi-val ${data.response_time_ms < 800 ? 'latency-fast' : data.response_time_ms < 2000 ? 'latency-moderate' : 'latency-slow'}`;
      $('#audit-kpi-latency-note').textContent = data.response_time_ms < 800 ? 'Fast server TTFB' : data.response_time_ms < 2000 ? 'Moderate speed' : 'Slow server response!';
    } else {
      latencyVal.textContent = '—';
    }

    const sslVal = $('#audit-kpi-ssl');
    sslVal.textContent = data.has_ssl ? 'HTTPS Secure' : 'Insecure HTTP';
    sslVal.style.color = data.has_ssl ? 'var(--accent-green)' : 'var(--accent-danger)';

    const mobileVal = $('#audit-kpi-mobile');
    mobileVal.textContent = data.has_viewport ? 'Mobile Tag Set' : 'Missing Tag';
    mobileVal.style.color = data.has_viewport ? 'var(--accent-green)' : 'var(--accent-danger)';

    $('#audit-site-title').textContent = data.title ? data.title.slice(0, 40) + '…' : 'No title tag';

    // Findings Checklist
    const findingsList = $('#audit-findings-list');
    findingsList.replaceChildren();

    if (data.findings && data.findings.length) {
      data.findings.forEach(f => {
        const item = node('div', `finding-item ${f.severity}`);
        const badge = node('span', `finding-badge ${f.severity}`, f.severity);
        const textGroup = node('div');
        textGroup.append(node('strong', '', f.issue), node('p', 'table-empty-sub', f.recommendation));
        item.append(badge, textGroup);
        findingsList.append(item);
      });
    }

    // Tailored Sales Pitch
    $('#audit-pitch-content').textContent = data.tailored_pitch || 'No sales pitch generated.';

    toast('Website diagnostic audit complete!');
    loadRecentAudits();
  } catch (err) {
    notice(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.replaceChildren(icon('activity'), node('span', '', 'Run Diagnostic Probe'));
  }
}

async function loadRecentAudits() {
  try {
    const data = await api('/api/audits');
    const container = $('#recent-audits-list');
    if (!container) return;
    container.replaceChildren();

    if (!data.audits || !data.audits.length) {
      container.append(node('p', 'table-empty-sub', 'No audits recorded yet.'));
      return;
    }

    data.audits.forEach(audit => {
      const item = node('button', 'recent-item');
      item.type = 'button';
      item.append(icon('activity'));
      const body = node('div');
      body.append(node('strong', '', audit.url));
      body.append(node('p', '', `${audit.status_code || 'Err'} · ${audit.response_time_ms ? audit.response_time_ms + 'ms' : '—'} · ${dateLabel(audit.audited_at)}`));
      item.append(body, icon('arrow'));
      item.addEventListener('click', () => {
        $('#audit-url-input').value = audit.url;
        $('#audit-form').requestSubmit();
      });
      container.append(item);
    });
  } catch (err) {
    console.warn('Audits load skipped:', err);
  }
}

/* ==========================================================================
   Contact Enrichment Studio
   ========================================================================== */

function enrichContact() {
  const input = $('#enrich-phone-input');
  const output = $('#enrich-output');
  if (!input || !output) return;

  const raw = input.value.trim();
  if (!raw) return toast('Please enter a phone number.');

  const digits = raw.replace(/[^+\d]/g, '');
  let e164 = digits;
  if (!e164.startsWith('+')) {
    if (e164.length === 10) e164 = '+91' + e164; // Default to India prefix or E.164
    else e164 = '+' + e164;
  }

  const cleanWaNum = e164.replace('+', '');
  const waUrl = `https://wa.me/${cleanWaNum}?text=${encodeURIComponent('Hi, reaching out regarding your business listing on Google Maps.')}`;

  $('#enrich-e164').textContent = e164;
  const waLink = $('#enrich-wa-link');
  waLink.href = waUrl;
  waLink.textContent = `wa.me/${cleanWaNum}`;

  // Build vCard (.vcf)
  const vcfContent = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:Lead ${digits.slice(-4)}`,
    `TEL;TYPE=CELL:${e164}`,
    'NOTE:Extracted via SparkXFlow Prospecting Platform',
    'END:VCARD'
  ].join('\r\n');

  const vcardBtn = $('#enrich-vcard-btn');
  vcardBtn.onclick = () => {
    const blob = new Blob([vcfContent], { type: 'text/vcard;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = node('a');
    a.href = url;
    a.download = `lead-${digits.slice(-4)}.vcf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Downloaded contact vCard!');
  };

  output.hidden = false;
  toast('Contact enriched and formatted!');
}

/* ==========================================================================
   Dossier Modal & AI Cold Outreach Studio
   ========================================================================== */

function openDetail(item) {
  state.activeDetailItem = item;
  $('#detail-title').textContent = item.name;
  $('#detail-category').textContent = item.category || 'LOCAL BUSINESS';
  
  const badgesRow = $('#detail-status');
  badgesRow.replaceChildren(websiteBadge(item));
  if (item.is_claimed === false) {
    const unclaimBadge = node('span', 'badge-unclaimed');
    unclaimBadge.append(icon('shield'), document.createTextNode('Unclaimed Profile'));
    badgesRow.append(unclaimBadge);
  } else {
    const claimBadge = node('span', 'badge-claimed');
    claimBadge.append(icon('check'), document.createTextNode('Verified Listing'));
    badgesRow.append(claimBadge);
  }

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
    try {
      const hostname = new URL(item.website).hostname;
      add('Website', externalLink(item.website, '', hostname));
    } catch {
      add('Website', externalLink(item.website, '', item.website));
    }
  } else {
    add('Website', 'No website detected (Primary Client Lead Opportunity)');
  }

  $('#detail-observed').textContent = `Inspected ${dateLabel(item.observed_at || new Date().toISOString())}`;
  $('#detail-map').href = safeLink(item.maps_url);

  const websiteBtn = $('#detail-website');
  if (item.website) {
    websiteBtn.href = safeLink(item.website);
    websiteBtn.hidden = false;
  } else {
    websiteBtn.hidden = true;
  }

  // Populate Personalized Outreach Studio
  const businessName = item.name || 'there';
  const category = item.category || 'local business';
  const city = (item.address || '').split(',').slice(-2, -1)[0]?.trim() || 'your area';

  // 1. WhatsApp Script
  const waMsg = item.website
    ? `Hi ${businessName}, I came across your Google Maps listing in ${city}. I noticed your website takes a bit to load on mobile phones. Would you be open to a 2-minute video showing how to speed it up to get more customer calls?`
    : `Hi ${businessName}, noticed your Google Maps profile in ${city} has strong reviews, but no website linked for clients to see pricing or book online. I mocked up a fast mobile 1-page site for you—would you be open to a quick preview link?`;
  $('#outreach-wa-text').value = waMsg;

  const cleanDigits = (item.phone || '').replace(/[^+\d]/g, '');
  const waDirectBtn = $('#detail-whatsapp-direct');
  if (cleanDigits.length >= 8) {
    const waNum = cleanDigits.startsWith('+') ? cleanDigits.slice(1) : (cleanDigits.length === 10 ? '91' + cleanDigits : cleanDigits);
    waDirectBtn.href = `https://wa.me/${waNum}?text=${encodeURIComponent(waMsg)}`;
    waDirectBtn.style.display = 'inline-flex';
  } else {
    waDirectBtn.style.display = 'none';
  }

  // 2. Cold Email Script
  const subject = item.website
    ? `Quick speed suggestion for ${businessName}`
    : `Missing website link on Google Maps for ${businessName}`;
  const emailBody = `Hi ${businessName} team,

I was researching top-rated ${category} providers in ${city} and found your business on Google Maps.

${item.website ? `I noticed your current website takes a few seconds to load on mobile networks, which often causes prospective clients to bounce.` : `I noticed you don't currently have a website connected to your Google listing. When customers look for your pricing or portfolio, they cannot find a direct website link.`}

We help local businesses convert map traffic into booked clients with high-speed, modern mobile websites.

Would you be open to a brief 2-minute preview this week?

Best regards,
SparkXFlow Outreach`;
  $('#outreach-email-subject').value = subject;
  $('#outreach-email-text').value = emailBody;
  $('#outreach-email-mailto').href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailBody)}`;

  // 3. Call Script
  const callScript = `“Hi, is this the owner at ${businessName}? 

My name is [Your Name]. I saw your business profile on Google Maps with great reviews in ${city}. 

The reason for my quick call is that your profile is currently missing a direct website link, so potential customers searching for ${category} can't see your work or request quotes directly.

I put together a quick 1-page design preview for you guys—who would be the best person to text or email that over to?”`;
  $('#outreach-call-text').value = callScript;
  $('#outreach-call-link').href = item.phone ? `tel:${item.phone.replace(/[^+\d]/g, '')}` : '#';

  $('#detail-dialog').showModal();
}

/* ==========================================================================
   Command Palette & Keyboard Controls
   ========================================================================== */

function openCommandPalette() {
  const dialog = $('#cmd-palette-dialog');
  if (!dialog) return;
  dialog.showModal();
  $('#cmd-search-input')?.focus();
  $('#cmd-search-input').value = '';
  filterCommandList('');
}

function closeCommandPalette() {
  $('#cmd-palette-dialog')?.close();
}

function filterCommandList(query) {
  const q = query.toLowerCase().trim();
  $$('#cmd-list .cmd-item').forEach(item => {
    const text = item.textContent.toLowerCase();
    item.hidden = q !== '' && !text.includes(q);
  });
}

/* ==========================================================================
   Event Listeners & Boot
   ========================================================================== */

function setupEventListeners() {
  // Navigation & Router
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '');
    if (hash && VIEW_TITLES[hash]) switchView(hash);
  });

  // Search form
  $('#search-form')?.addEventListener('submit', startSearch);

  // Quick filter pills in Finder table
  $('#quick-filter-pills')?.addEventListener('click', e => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    $$('#quick-filter-pills .filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    state.activePill = pill.dataset.pill;
    renderTable();
  });

  // Rating sort button
  $('#sort-rating')?.addEventListener('click', () => {
    state.sort = state.sort === 'default' ? 'desc' : state.sort === 'desc' ? 'asc' : 'default';
    renderTable();
  });

  // Export buttons
  $('#export-csv')?.addEventListener('click', exportCsv);
  $('#copy-sheets')?.addEventListener('click', copyForGoogleSheets);
  $('#copy-all-phones')?.addEventListener('click', () => {
    const rows = visibleRows();
    const phones = rows.map(r => r.phone).filter(p => p && p !== 'Not listed');
    if (!phones.length) return toast('No phone numbers found in current view.');
    const uniquePhones = [...new Set(phones)];
    copyText(uniquePhones.join('\n'));
    toast(`${uniquePhones.length} phone numbers copied to clipboard!`);
  });

  // Bulk save selected leads
  $('#save-selected-leads')?.addEventListener('click', async () => {
    const rows = visibleRows().filter(r => state.selectedIds.has(r.id || r.name));
    if (!rows.length) return toast('No leads selected.');
    let saved = 0;
    for (const r of rows) {
      await saveLeadToCRM(r);
      saved++;
    }
    toast(`Successfully saved ${saved} leads to CRM!`);
  });

  // Dossier dialog save button
  $('#detail-save-lead-btn')?.addEventListener('click', () => {
    if (state.activeDetailItem) {
      saveLeadToCRM(state.activeDetailItem);
    }
  });

  // CRM Status Tabs
  $('#crm-status-tabs')?.addEventListener('click', e => {
    const tab = e.target.closest('.crm-tab');
    if (!tab) return;
    $$('#crm-status-tabs .crm-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.crmStatus = tab.dataset.status;
    loadSavedLeads();
  });

  // CRM List Filter & Search
  $('#crm-list-filter')?.addEventListener('change', e => {
    state.crmListFilter = e.target.value;
    loadSavedLeads();
  });
  $('#crm-search-input')?.addEventListener('input', e => {
    state.crmSearch = e.target.value;
    loadSavedLeads();
  });

  // CRM Copy phones & Export CSV
  $('#crm-copy-phones')?.addEventListener('click', () => {
    const phones = state.savedLeads.map(l => l.phone).filter(p => p && p !== 'Not listed');
    if (!phones.length) return toast('No phone numbers found in saved leads.');
    copyText([...new Set(phones)].join('\n'));
    toast(`${phones.length} phones copied!`);
  });
  $('#crm-export-csv')?.addEventListener('click', () => {
    if (!state.savedLeads.length) return toast('No saved leads to export.');
    const headers = ['Name', 'Category', 'Phone', 'Address', 'Status', 'List', 'Website', 'Notes'];
    const rows = state.savedLeads.map(l => [l.name, l.category, l.phone, l.address, l.status, l.list_name || '', l.website || '', l.notes || '']);
    const csv = '\uFEFF' + [headers, ...rows].map(record => record.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = node('a');
    link.href = url;
    link.download = `saved-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${rows.length} saved leads exported!`);
  });

  // Notes Modal save button
  $('#save-lead-note-btn')?.addEventListener('click', saveLeadNote);

  // Lead List Creation Form
  $('#create-list-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#new-list-name').value.trim();
    const desc = $('#new-list-desc').value.trim();
    if (!name) return;
    try {
      await api('/api/lists', {
        method: 'POST',
        body: JSON.stringify({ name, description: desc })
      });
      $('#new-list-name').value = '';
      $('#new-list-desc').value = '';
      toast(`Created list "${name}"`);
      loadLeadLists();
      loadPlatformMetrics();
    } catch (err) {
      notice(err.message, 'error');
    }
  });

  // Website Audit Studio Form
  $('#audit-form')?.addEventListener('submit', runWebsiteAudit);
  $('#copy-audit-pitch-btn')?.addEventListener('click', () => {
    copyText($('#audit-pitch-content').textContent);
    toast('Audit sales pitch copied!');
  });

  // Contact Enrichment
  $('#enrich-process-btn')?.addEventListener('click', enrichContact);

  // Campaign templates copy buttons
  $$('[data-copy-camp]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.copyCamp;
      const text = $(`#${targetId}`)?.textContent || '';
      copyText(text);
      toast('Campaign template copied!');
    });
  });

  // Dossier outreach tabs
  $$('.outreach-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.outreach-tab').forEach(t => t.classList.remove('active'));
      $$('.outreach-pane').forEach(p => p.hidden = true);
      tab.classList.add('active');
      $(`#pane-${tab.dataset.tab}`).hidden = false;
    });
  });

  // Outreach Pitch Copy Buttons
  $('#copy-wa-pitch')?.addEventListener('click', () => {
    copyText($('#outreach-wa-text').value);
    toast('WhatsApp pitch copied to clipboard!');
  });
  $('#copy-email-pitch')?.addEventListener('click', () => {
    copyText(`Subject: ${$('#outreach-email-subject').value}\n\n${$('#outreach-email-text').value}`);
    toast('Cold email pitch copied to clipboard!');
  });
  $('#copy-call-pitch')?.addEventListener('click', () => {
    copyText($('#outreach-call-text').value);
    toast('Phone script copied to clipboard!');
  });

  // Select all checkbox
  $('#select-all')?.addEventListener('change', e => {
    const rows = visibleRows();
    if (e.target.checked) {
      rows.forEach(r => state.selectedIds.add(r.id || r.name));
    } else {
      state.selectedIds.clear();
    }
    renderTable();
  });

  // Instant live search filter
  $('#table-search')?.addEventListener('input', e => {
    state.searchQuery = e.target.value;
    renderTable();
  });

  // Cancel search
  $('#cancel-search')?.addEventListener('click', async () => {
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

  // Quick suggestion tag buttons
  $$('[data-niche]').forEach(button => button.addEventListener('click', () => {
    if (state.busy) return;
    $('#niche').value = button.dataset.niche;
    $('#city').value = button.dataset.city;
    switchView('finder');
    $('#niche').focus();
    toast('Trade set. Hit "Find businesses" to start.');
  }));

  // Theme toggle
  $('#theme-toggle-btn')?.addEventListener('click', cycleTheme);
  $('#cmd-action-toggle-theme')?.addEventListener('click', () => {
    cycleTheme();
    closeCommandPalette();
  });

  // Command palette triggers
  $('#cmd-palette-btn')?.addEventListener('click', openCommandPalette);
  $('#nav-cmd-trigger')?.addEventListener('click', openCommandPalette);
  $('[data-close-cmd]')?.addEventListener('click', closeCommandPalette);
  $('#cmd-search-input')?.addEventListener('input', e => filterCommandList(e.target.value));

  $$('[data-cmd-view]').forEach(item => {
    item.addEventListener('click', () => {
      closeCommandPalette();
      switchView(item.dataset.cmdView);
    });
  });

  $$('[data-cmd-niche]').forEach(item => {
    item.addEventListener('click', () => {
      closeCommandPalette();
      $('#niche').value = item.dataset.cmdNiche;
      $('#city').value = item.dataset.cmdCity;
      switchView('finder');
      $('#search-form').requestSubmit();
    });
  });

  $('#cmd-action-export')?.addEventListener('click', () => {
    closeCommandPalette();
    exportCsv();
  });

  $('#cmd-action-copy-phones')?.addEventListener('click', () => {
    closeCommandPalette();
    $('#copy-all-phones')?.click();
  });

  // Keyboard shortcuts (Cmd+K / Ctrl+K and /)
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const dialog = $('#cmd-palette-dialog');
      if (dialog && dialog.open) closeCommandPalette();
      else openCommandPalette();
      return;
    }
    if (e.key === 'Escape') {
      closeCommandPalette();
    }
    if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      switchView('finder');
      $('#niche')?.focus();
    }
  });

  // Modal dialog closers
  $$('[data-open-help]').forEach(button => button.addEventListener('click', () => $('#help-dialog').showModal()));
  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      dialog.close();
    }
  }));

  $('#dismiss-notice')?.addEventListener('click', clearNotice);
}

/* ==========================================================================
   Boot Application
   ========================================================================== */

async function initApp() {
  applyTheme(state.theme);
  initAceternityCubesGrid();
  initSpotlightCards();
  initSidebar();
  setupEventListeners();

  // Restore view from URL hash if provided
  const initialHash = window.location.hash.replace('#', '');
  if (initialHash && VIEW_TITLES[initialHash]) {
    switchView(initialHash);
  } else {
    switchView('overview');
  }

  await Promise.all([refreshStatus(), refreshHistory(), loadPlatformMetrics()]);

  // Pre-load initial search into finder if available
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
  } catch { /* Non-blocking */ }
}

initApp();
