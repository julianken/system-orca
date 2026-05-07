// system-orca client
'use strict';

const POLL_MS = 2000;
const SHOW_ARCHIVED_KEY = 'system-orca-show-archived';

window.__systemView = window.__systemView || {
  lastFetchAt: 0,
  lastWorkflowCount: 0,
};

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relativeTime(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (isNaN(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function pillClass(summary) {
  if (summary.archived) return 'pill-archived';
  return `pill-${summary.status || 'pending'}`;
}

function pillText(summary) {
  if (summary.archived) return 'archived';
  return summary.status || 'pending';
}

function cardHTML(s) {
  const id = escapeHtml(s.id);
  const title = escapeHtml(s.title || s.id);
  const goal = escapeHtml(s.goal || '');
  const status = escapeHtml(s.status || 'pending');
  const archived = s.archived ? 'true' : 'false';
  const last = escapeHtml(relativeTime(s.last_event_at || s.started_at));
  const progress = `${s.completed_count || 0}/${s.stage_count || 0} stages`;
  return `<article class="card" role="listitem" tabindex="0"
    data-workflow-id="${id}"
    data-status="${status}"
    data-archived="${archived}">
    <div class="card-head">
      <span class="card-title">${title}</span>
      <span class="pill ${pillClass(s)}">${escapeHtml(pillText(s))}</span>
    </div>
    <div class="card-goal">${goal}</div>
    <div class="card-meta">
      <span><strong>${escapeHtml(progress)}</strong></span>
      <span>updated ${last}</span>
    </div>
  </article>`;
}

function setCounts(workflows) {
  const running = workflows.filter((w) => !w.archived && w.status === 'running').length;
  const completed = workflows.filter((w) => !w.archived && w.status === 'completed').length;
  const r = document.getElementById('count-running');
  const c = document.getElementById('count-completed');
  if (r) r.textContent = String(running);
  if (c) c.textContent = String(completed);
}

async function renderIndex() {
  const cb = document.getElementById('show-archived');
  const showArchived = !!(cb && cb.checked);
  const url = showArchived ? '/api/workflows?include_archived=true' : '/api/workflows';
  let workflows = [];
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) workflows = await res.json();
  } catch { workflows = []; }

  window.__systemView.lastFetchAt = Date.now();
  window.__systemView.lastWorkflowCount = workflows.length;

  const container = document.getElementById('cards');
  if (!container) return;
  if (!workflows.length) {
    container.innerHTML = '<div class="empty">no workflows yet — run <code>system-orca init --title T --goal G</code></div>';
  } else {
    container.innerHTML = workflows.map(cardHTML).join('');
  }
  setCounts(workflows);
}

function bootIndex() {
  const cb = document.getElementById('show-archived');
  if (cb) {
    const stored = localStorage.getItem(SHOW_ARCHIVED_KEY);
    cb.checked = stored === '1';
    cb.addEventListener('change', () => {
      localStorage.setItem(SHOW_ARCHIVED_KEY, cb.checked ? '1' : '0');
      renderIndex();
    });
  }
  const cards = document.getElementById('cards');
  if (cards) {
    cards.addEventListener('click', (e) => {
      const card = e.target.closest('article.card[data-workflow-id]');
      if (!card) return;
      const id = card.getAttribute('data-workflow-id');
      if (id) location.href = `/w/${id}`;
    });
  }
  renderIndex();
  setInterval(renderIndex, POLL_MS);
}

if (location.pathname === '/' || location.pathname === '/index.html') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootIndex);
  } else {
    bootIndex();
  }
}
