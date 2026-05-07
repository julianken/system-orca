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

// ---- detail page ----

const TAB_KEY = 'system-orca-tab';

function workflowIdFromPath() {
  const m = location.pathname.match(/^\/w\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function pillForStatus(status) {
  return `<span class="pill pill-${escapeHtml(status || 'pending')}">${escapeHtml(status || 'pending')}</span>`;
}

function renderListBlock(label, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lis = items.map((x) => `<li>${escapeHtml(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('');
  return `<div class="stage-list-label">${escapeHtml(label)}</div><ul class="stage-list">${lis}</ul>`;
}

function renderVerdict(stage) {
  if (!stage.verdict && !stage.error && !stage.artifact) return '';
  const parts = [];
  if (stage.verdict) parts.push(`<strong>verdict:</strong> ${escapeHtml(String(stage.verdict))}`);
  if (stage.error) parts.push(`<strong>error:</strong> ${escapeHtml(String(stage.error))}`);
  if (stage.artifact) parts.push(`<strong>artifact:</strong> ${escapeHtml(String(stage.artifact))}`);
  return `<div class="stage-verdict">${parts.join(' · ')}</div>`;
}

function stageHTML(stage, childStages) {
  const id = escapeHtml(stage.id || '');
  const status = escapeHtml(stage.status || 'pending');
  const type = escapeHtml(stage.type || 'stage');
  const label = escapeHtml(stage.label || stage.id || '');
  const name = stage.name ? escapeHtml(stage.name) : '';
  const summary = stage.summary ? `<div class="stage-summary">${escapeHtml(stage.summary)}</div>` : '';
  const findings = renderListBlock('key findings', stage.key_findings);
  const questions = renderListBlock('open questions', stage.open_questions);
  const verdict = renderVerdict(stage);
  const childrenHTML = (childStages && childStages.length)
    ? `<div class="stage-children">${childStages.map((c) => stageHTML(c, [])).join('')}</div>`
    : '';
  return `<article class="stage" data-stage-id="${id}" data-status="${status}" data-type="${type}">
    <div class="stage-head">
      <span><span class="stage-id">${id}</span><span class="stage-title">${label}${name ? ': ' + name : ''}</span></span>
      <span class="pill pill-${status}">${status}</span>
    </div>
    ${summary}${findings}${questions}${verdict}${childrenHTML}
  </article>`;
}

function renderStages(state) {
  const stages = state.stages || [];
  const childrenByParent = new Map();
  const topLevel = [];
  for (const s of stages) {
    if (s.parent_id && stages.some((x) => x.id === s.parent_id)) {
      if (!childrenByParent.has(s.parent_id)) childrenByParent.set(s.parent_id, []);
      childrenByParent.get(s.parent_id).push(s);
    } else {
      topLevel.push(s);
    }
  }
  const html = topLevel.map((s) => stageHTML(s, childrenByParent.get(s.id) || [])).join('');
  for (const [parentId, children] of childrenByParent) {
    if (!stages.some((x) => x.id === parentId)) {
      for (const child of children) {
        document.getElementById('tab-stages').insertAdjacentHTML('beforeend', stageHTML(child, []));
      }
    }
  }
  document.getElementById('tab-stages').innerHTML = html;
}

function feedEntryHTML(entry) {
  const ts = escapeHtml(entry.ts ? new Date(entry.ts).toISOString().slice(11, 19) : '');
  const agent = escapeHtml(entry.agent || '');
  const type = escapeHtml(entry.type || '');
  const stage = entry.stage_id ? `stage=${escapeHtml(entry.stage_id)} ` : '';
  const text = entry.text ? escapeHtml(entry.text) : (entry.summary ? escapeHtml(entry.summary) : '');
  const level = entry.level ? ` data-level="${escapeHtml(entry.level)}"` : '';
  return `<div class="feed-entry" data-event-type="${type}"${level}>
    <span class="ts">${ts}</span>
    <span class="agent">${agent}</span>
    <span class="type">${type}</span>
    <span class="text">${stage}${text}</span>
  </div>`;
}

function renderFeed(state) {
  const list = document.getElementById('feed-list');
  if (!list) return;
  const feed = state.feed || [];
  list.innerHTML = feed.map(feedEntryHTML).join('');
}

function renderHeader(state) {
  const meta = state.meta || {};
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText('wf-title', meta.title || meta.id || workflowIdFromPath() || 'workflow');
  setText('wf-goal', meta.goal || '');
  setText('wf-started', meta.started_at ? new Date(meta.started_at).toISOString().slice(0, 19) + ' UTC' : '—');
  const lastEvent = state.feed && state.feed.length ? state.feed[state.feed.length - 1].ts : meta.started_at;
  setText('wf-last-update', lastEvent ? relativeTime(lastEvent) : '—');
  const pill = document.getElementById('wf-status-pill');
  const status = meta.archived ? 'archived' : (meta.status || 'running');
  if (pill) pill.innerHTML = pillForStatus(status);
}

let mermaidInitDone = false;
function initMermaid() {
  if (mermaidInitDone) return;
  if (typeof window.mermaid === 'undefined') return;
  window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
  mermaidInitDone = true;
}

async function renderDiagram(force = false) {
  const id = workflowIdFromPath();
  if (!id) return;
  const target = document.getElementById('diagram-target');
  if (!target) return;
  let src = '';
  try {
    const r = await fetch(`/api/workflows/${encodeURIComponent(id)}/diagram.mmd`, { cache: 'no-store' });
    if (r.ok) src = await r.text();
  } catch { /* keep previous */ }
  if (!force && src && src === window.__systemView.lastDiagramSource) return;
  window.__systemView.lastDiagramSource = src;
  if (!src) return;
  initMermaid();
  if (!mermaidInitDone) return;
  try {
    const { svg } = await window.mermaid.render(`mm-${Date.now()}`, src);
    target.innerHTML = svg;
  } catch (err) {
    target.textContent = `mermaid render failed: ${err && err.message ? err.message : err}`;
  }
}

async function renderDetail() {
  const id = workflowIdFromPath();
  if (!id) return;
  let state = null;
  try {
    const r = await fetch(`/api/workflows/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (r.ok) state = await r.json();
  } catch { state = null; }
  window.__systemView.lastFetchAt = Date.now();
  if (!state) return;
  renderHeader(state);
  renderStages(state);
  renderFeed(state);
  if (currentTab() === 'diagram') {
    renderDiagram();
  }
}

function currentTab() {
  return localStorage.getItem(TAB_KEY) || 'stages';
}

function setTab(name) {
  localStorage.setItem(TAB_KEY, name);
  for (const btn of document.querySelectorAll('nav.tabs button')) {
    btn.setAttribute('aria-selected', btn.dataset.tab === name ? 'true' : 'false');
  }
  const stagesPanel = document.getElementById('tab-stages');
  const diagramPanel = document.getElementById('tab-diagram');
  if (stagesPanel)  stagesPanel.hidden  = name !== 'stages';
  if (diagramPanel) diagramPanel.hidden = name !== 'diagram';
  if (name === 'diagram') renderDiagram(true);
}

function bootDetail() {
  const id = workflowIdFromPath();
  if (!id) return;
  const rawLink = document.getElementById('raw-events-link');
  if (rawLink) rawLink.href = `/api/workflows/${encodeURIComponent(id)}/events.jsonl`;
  for (const btn of document.querySelectorAll('nav.tabs button')) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }
  setTab(currentTab());
  renderDetail();
  setInterval(renderDetail, POLL_MS);
  setInterval(() => { if (currentTab() === 'diagram') renderDiagram(); }, POLL_MS);
}

if (location.pathname === '/' || location.pathname === '/index.html') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootIndex);
  } else {
    bootIndex();
  }
} else if (location.pathname.startsWith('/w/')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootDetail);
  } else {
    bootDetail();
  }
}
