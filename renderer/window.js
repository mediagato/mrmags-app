/**
 * Mr. Mags — main window renderer.
 *
 * Talks to the local HTTP API on 127.0.0.1:11436 (same one the MCP relay and
 * browser extension use). No direct brain access from the renderer — everything
 * goes through the API surface so behavior matches what every other front door
 * sees.
 */

const API = 'http://127.0.0.1:11436';
const TABS = ['howto', 'memories', 'settings', 'about'];

// ── Tab routing ────────────────────────────────────────────────────────────

function showTab(name) {
  if (!TABS.includes(name)) name = 'howto';
  TABS.forEach(t => {
    document.getElementById(`panel-${t}`).hidden = t !== name;
  });
  document.querySelectorAll('.rail-link').forEach(a => {
    a.classList.toggle('active', a.dataset.tab === name);
  });
  if (name === 'memories') loadMemories();
  if (name === 'settings') loadSettings();
  history.replaceState(null, '', `#${name}`);
}

document.querySelectorAll('.rail-link').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    showTab(a.dataset.tab);
  });
});

// External links via Electron shell
document.addEventListener('click', e => {
  const ext = e.target.closest('[data-extlink]');
  if (ext) {
    e.preventDefault();
    window.mrmags?.openExternal?.(ext.dataset.extlink);
  }
});

// ── API helpers ────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

// ── Status dot ─────────────────────────────────────────────────────────────

async function refreshStatus() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  try {
    const h = await api('/health');
    dot.className = 'dot ok';
    text.textContent = `listening · ${h.memory_count ?? 0} memories`;
  } catch {
    dot.className = 'dot err';
    text.textContent = 'API unreachable';
  }
}
refreshStatus();
setInterval(refreshStatus, 10000);

// ── Memories ───────────────────────────────────────────────────────────────

let allMemories = [];

async function loadMemories() {
  const list = document.getElementById('memories-list');
  const empty = document.getElementById('memories-empty');
  const count = document.getElementById('mem-count');
  try {
    const data = await api('/memories');
    allMemories = Array.isArray(data) ? data : (data.memories || []);
    count.textContent = `${allMemories.length} entr${allMemories.length === 1 ? 'y' : 'ies'}`;
    renderMemories(allMemories);
    empty.hidden = allMemories.length > 0;
  } catch (e) {
    list.innerHTML = `<li class="mem-item" style="border-color:#e6c4b8;color:#823020;">Couldn't load: ${e.message}</li>`;
    empty.hidden = true;
  }
}

function renderMemories(items) {
  const list = document.getElementById('memories-list');
  list.innerHTML = '';
  items.forEach(m => {
    const li = document.createElement('li');
    li.className = 'mem-item';
    li.dataset.filename = m.filename || '';
    const title = (m.name || m.filename || 'memory').replace(/\.md$/, '');
    const preview = (m.description || m.content || '').replace(/\s+/g, ' ').slice(0, 110);
    const tagsHtml = (m.tags || []).map(t => `<span class="mem-tag">${escapeHtml(t)}</span>`).join('');
    li.innerHTML = `
      <div class="mem-title">${escapeHtml(title)}</div>
      ${preview ? `<div class="mem-preview">${escapeHtml(preview)}</div>` : ''}
      ${tagsHtml ? `<div class="mem-tags">${tagsHtml}</div>` : ''}
    `;
    li.addEventListener('click', () => openMemoryModal(m));
    list.appendChild(li);
  });
}

document.getElementById('mem-search').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  const filtered = !q ? allMemories : allMemories.filter(m => {
    const blob = JSON.stringify(m).toLowerCase();
    return blob.includes(q);
  });
  renderMemories(filtered);
});

document.getElementById('mem-refresh').addEventListener('click', loadMemories);

// Memory modal
function openMemoryModal(m) {
  document.getElementById('mem-modal-title').textContent = (m.name || m.filename || 'memory').replace(/\.md$/, '');
  document.getElementById('mem-modal-body').textContent = m.content || m.description || '(no content)';
  const meta = [
    m.type && `type: ${m.type}`,
    m.dewey && `dewey: ${m.dewey}`,
    (m.tags || []).length && `tags: ${(m.tags || []).join(', ')}`,
  ].filter(Boolean).join(' · ');
  document.getElementById('mem-modal-meta').textContent = meta || '—';
  document.getElementById('mem-delete').dataset.filename = m.filename || '';
  document.getElementById('mem-modal').hidden = false;
}

document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => {
    document.getElementById('mem-modal').hidden = true;
  });
});

document.getElementById('mem-delete').addEventListener('click', async (e) => {
  const filename = e.target.dataset.filename;
  if (!filename) return;
  if (!confirm(`Forget "${filename}"? This can't be undone.`)) return;
  try {
    await api(`/memory/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    document.getElementById('mem-modal').hidden = true;
    loadMemories();
    refreshStatus();
  } catch (err) {
    alert(`Couldn't delete: ${err.message}`);
  }
});

// ── Settings ───────────────────────────────────────────────────────────────

async function loadSettings() {
  // Widget toggle reflects state.widget_enabled
  try {
    const s = await api('/state/widget_enabled');
    document.getElementById('setting-widget').checked = s?.value === 'true' || s?.value === true;
  } catch {}
  // Autostart reflects what main process tells us
  try {
    const a = await window.mrmags?.getAutostart?.();
    if (typeof a === 'boolean') document.getElementById('setting-autostart').checked = a;
  } catch {}
  // Data path
  try {
    const path = await window.mrmags?.dataPath?.();
    if (path) {
      document.getElementById('setting-data-path').textContent = path;
      const hp = document.getElementById('howto-data-path');
      if (hp) hp.textContent = path + '/brain';
    }
  } catch {}
}

document.getElementById('setting-widget').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
    await api('/state/widget_enabled', {
      method: 'POST',
      body: JSON.stringify({ value: String(enabled) }),
    });
    window.mrmags?.toggleWidget?.(enabled);
  } catch (err) {
    alert(`Couldn't save: ${err.message}`);
    e.target.checked = !enabled;
  }
});

document.getElementById('setting-autostart').addEventListener('change', async (e) => {
  try {
    await window.mrmags?.setAutostart?.(e.target.checked);
  } catch {
    e.target.checked = !e.target.checked;
  }
});

document.getElementById('open-data').addEventListener('click', () => {
  window.mrmags?.openDataFolder?.();
});

document.getElementById('open-claude-cfg').addEventListener('click', () => {
  window.mrmags?.openClaudeConfig?.();
});

// ── About / version ───────────────────────────────────────────────────────

(async () => {
  const v = await window.mrmags?.version?.();
  if (v) {
    document.getElementById('brand-version').textContent = `v${v}`;
    document.getElementById('about-version').textContent = `v${v}`;
  }
})();

// ── Initial route ─────────────────────────────────────────────────────────

const initial = (location.hash || '#howto').replace(/^#/, '');
showTab(TABS.includes(initial) ? initial : 'howto');

// ── Utils ─────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
