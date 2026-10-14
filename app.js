// TaskDesk 모바일 (PWA) — PC 앱과 같은 Supabase 계정의 데이터를 보고 고친다.
// 날짜/빠른 추가/조건 표시 등은 PC와 같은 common.js를 쓰고, 저장은 sync.js로 서버와 맞춘다.
/* global CLOUD_CONFIG */

let state = { tasks: [], categories: [], notes: [], settings: { viewSpace: 'all' } };
let meta = { cursor: null, known: {} };
let cloud = null;
let tab = 'today';
let editing = null;     // 편집 중인 업무 (사본)
let editSubs = [];
let editDeps = [];
let editCond = {};
let addWhen = null;
let syncTimer = null;
let syncing = false;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const PALETTE = ['#4f63f0', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#0091ff', '#d6409f', '#12a594', '#ff8b3e', '#6b7385'];

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

function persist() {
  LS.set('td_data', { tasks: state.tasks, categories: state.categories, notes: state.notes });
  LS.set('td_meta', meta);
  LS.set('td_view', state.settings.viewSpace);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- 데이터 변경 (common.js가 부르는 window.api도 여기로) ----------
function ensureCategory(name, space) {
  if (!name || state.categories.some((c) => c.name === name)) return;
  state.categories.push({ name, color: PALETTE[state.categories.length % PALETTE.length], space: space || 'work' });
}

function upsertTask(input) {
  const now = new Date().toISOString();
  let t = input.id && state.tasks.find((x) => x.id === input.id);
  if (!t) {
    t = {
      id: '', title: '', memo: '', project: '', priority: 'mid', status: 'todo', startDate: '', dueDate: '', dueTime: '',
      remindBefore: 10, repeat: 'none', space: 'work', checklist: [], dependsOn: [], createdAt: now, doneAt: '',
      ...input,
    };
    t.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    state.tasks.push(t);
  } else {
    const wasDone = t.status === 'done';
    Object.assign(t, input, { updatedAt: now });
    if (t.status === 'done' && !wasDone) t.doneAt = now;
    if (t.status !== 'done') { t.doneAt = ''; t.skipped = false; t.skipReason = ''; }
  }
  ensureCategory(t.project, t.space);
  return t;
}

function changed() {
  persist();
  render();
  scheduleSync(600);
}

window.api = {
  async saveTask(input) { const t = upsertTask(input); changed(); return t; },
  async deleteTask(id) {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    state.tasks.forEach((t) => {
      t.dependsOn = (t.dependsOn || []).filter((d) => d !== id);
      if (t.depCond) delete t.depCond[id];
    });
    changed();
  },
  async saveNote(input) {
    const now = new Date().toISOString();
    const n = input.id && state.notes.find((x) => x.id === input.id);
    if (n) Object.assign(n, input, { updatedAt: now });
    else state.notes.unshift({ text: '', pinned: false, taskId: '', space: 'work', createdAt: now, updatedAt: now, ...input, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8) });
    changed();
  },
  async deleteNote(id) { state.notes = state.notes.filter((n) => n.id !== id); changed(); },
  async openMain(id) { if (id) openEditor(id); },
};

// ---------- 동기화 ----------
function setDot(cls, title) {
  const d = $('#sync-dot');
  d.className = `sync-dot ${cls}`;
  d.title = title || '';
}

function scheduleSync(delay = 1000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  if (!cloud || !cloud.signedIn || syncing) return;
  if (!navigator.onLine) { setDot('', '오프라인'); return; }
  syncing = true;
  setDot('busy', '동기화 중');
  try {
    const pulled = await syncPull(cloud, state, meta);
    await syncPush(cloud, state, meta, 'all');
    LS.set('td_last', new Date().toISOString());
    setDot('ok', `동기화됨 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`);
    persist();
    if (pulled.changed) render();
  } catch (e) {
    setDot('err', e.message);
    if (!cloud.signedIn) showLogin();
  } finally {
    syncing = false;
    renderSettings();
  }
}

// ---------- 렌더 ----------
const vt = () => state.tasks.filter(inView);
const byTime = (a, b) => (dueAt(a)?.getTime() ?? Infinity) - (dueAt(b)?.getTime() ?? Infinity);
const PRI_COLOR = { high: 'var(--high)', mid: 'var(--mid)', low: 'var(--low)' };

function sec(box, title, cls = '') {
  const h = document.createElement('div');
  h.className = `sec ${cls}`;
  h.textContent = title;
  box.append(h);
}

function rowEl({ title, meta: metaItems, done, personal, color, onCheck, onOpen }) {
  const el = document.createElement('div');
  el.className = `row${done ? ' done' : ''}${personal ? ' personal' : ''}`;
  el.style.borderLeftColor = color;
  const chk = document.createElement('button');
  chk.className = 'chk';
  chk.textContent = done ? '✓' : '';
  chk.addEventListener('click', (e) => { e.stopPropagation(); onCheck(); });
  const main = document.createElement('div');
  main.className = 'r-main';
  const t = document.createElement('div');
  t.className = 'r-title';
  t.textContent = title;
  const m = document.createElement('div');
  m.className = 'r-meta';
  for (const it of metaItems) {
    if (!it || !it[0]) continue;
    const s = document.createElement('span');
    s.textContent = it[0];
    if (it[1]) s.className = it[1];
    if (it[2]) s.style.setProperty('--c', it[2]);
    m.append(s);
  }
  main.append(t, m);
  el.append(chk, main);
  el.addEventListener('click', onOpen);
  return el;
}

function taskRow(t) {
  const cl = t.checklist || [];
  const cond = t.status !== 'done' ? condLabel(t) : '';
  return rowEl({
    title: t.title,
    meta: [
      [viewSpace() === 'all' && spaceOf(t) === 'personal' ? '🏠' : ''],
      [t.dueDate ? `⏱ ${dueLabel(t)}` : '', isOverdue(t) ? 'late' : ''],
      [t.project, 'tag', catColor(t.project)],
      [cond, 'cond'],
      [!cond && isBlocked(t) ? '🔒 선행 대기' : '', 'lock'],
      [t.status !== 'done' && succsOf(t).filter((x) => x.status !== 'done').length ? `→ 후행 ${succsOf(t).filter((x) => x.status !== 'done').length}건` : '', 'succ'],
      [cl.length ? `☑ ${cl.filter((c) => c.done).length}/${cl.length}` : ''],
      [t.skipped ? '⏭ 건너뜀' : ''],
    ],
    done: t.status === 'done',
    personal: spaceOf(t) === 'personal',
    color: PRI_COLOR[t.priority] || '#d5d9e2',
    onCheck: () => setStatus(t, t.status === 'done' ? 'todo' : 'done'),
    onOpen: () => openEditor(t.id),
  });
}

function renderToday() {
  const now = new Date();
  const today = ymd(now);
  const open = vt().filter((t) => t.status !== 'done').sort(byTime);
  const overdue = open.filter(isOverdue);
  const rest = open.filter((t) => !isOverdue(t));
  const todays = rest.filter((t) => t.dueDate === today || (t.status === 'doing' && !t.dueDate));
  const week = rest.filter((t) => t.dueDate > today && dayDiff(now, parseYmd(t.dueDate)) <= 7);
  const later = rest.filter((t) => t.dueDate && dayDiff(now, parseYmd(t.dueDate)) > 7);
  const nodate = rest.filter((t) => !t.dueDate && t.status !== 'doing');
  const subs = open
    .flatMap((t) => (t.checklist || []).filter((c) => !c.done && c.date && c.date <= today).map((c) => ({ t, c })))
    .sort((a, b) => `${a.c.date}${a.c.time || '99'}`.localeCompare(`${b.c.date}${b.c.time || '99'}`));
  const doneToday = vt().filter((t) => t.status === 'done' && !t.skipped && t.doneAt && ymd(new Date(t.doneAt)) === today);

  $('#b-today').textContent = overdue.length + todays.length + subs.length || '';
  const box = $('#view-today');
  box.innerHTML = '';
  if (overdue.length) { sec(box, `⚠️ 지연 ${overdue.length}`, 'late'); overdue.forEach((t) => box.append(taskRow(t))); }
  sec(box, `📌 오늘 ${todays.length}`);
  todays.forEach((t) => box.append(taskRow(t)));
  if (subs.length) {
    sec(box, `🧩 세부 일정 ${subs.length}`);
    subs.forEach(({ t, c }) => box.append(rowEl({
      title: c.text,
      meta: [[`⏱ ${subWhen(c)}`, subOverdue(c) ? 'late' : ''], [`📁 ${t.title}`]],
      done: false,
      personal: spaceOf(t) === 'personal',
      color: catColor(t.project),
      onCheck: () => toggleSub(t, c.id),
      onOpen: () => openEditor(t.id),
    })));
  }
  if (week.length) { sec(box, `🗓 7일 이내 ${week.length}`); week.forEach((t) => box.append(taskRow(t))); }
  if (later.length) { sec(box, `🔭 나중에 ${later.length}`); later.forEach((t) => box.append(taskRow(t))); }
  if (nodate.length) { sec(box, `📥 날짜 미정 ${nodate.length}`); nodate.forEach((t) => box.append(taskRow(t))); }
  if (doneToday.length) { sec(box, `✅ 오늘 완료 ${doneToday.length}`); doneToday.forEach((t) => box.append(taskRow(t))); }
  if (!vt().length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = '아직 업무가 없어요.<br/>위 입력창에 적어보세요.';
    box.append(e);
  }
}

function renderAll() {
  const q = $('#f-search').value.trim().toLowerCase();
  const st = $('#f-status').value;
  const list = vt().filter((t) => {
    if (q && !`${t.title} ${t.memo} ${t.project}`.toLowerCase().includes(q)) return false;
    if (st === 'open' && t.status === 'done') return false;
    if (st === 'done' && t.status !== 'done') return false;
    return true;
  }).sort(byTime);
  const box = $('#all-list');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">조건에 맞는 업무가 없어요.</div>'; return; }
  list.forEach((t) => box.append(taskRow(t)));
}

function renderMemo() {
  const box = $('#m-list');
  if (box.contains(document.activeElement)) return;
  box.innerHTML = '';
  const notes = sortedNotes();
  if (!notes.length) { box.innerHTML = '<div class="empty">아직 메모가 없어요.</div>'; return; }
  notes.forEach((n) => box.append(noteEl(n, {
    onOpenTask: (id) => openEditor(id),
    onConverted: (t) => toast(`업무로 등록했어요: ${t.title}`),
  })));
}

function renderSettings() {
  if (!cloud) return;
  $('#s-email').textContent = (cloud.session && cloud.session.email) || '-';
  const last = LS.get('td_last', '');
  $('#s-sync').textContent = last ? `마지막 동기화: ${fmtAgo(last)}` : '아직 동기화 전이에요.';
  $('#s-workoff').checked = !!LS.get('td_workoff', false);
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const subscribed = LS.get('td_push', false);
  $('#s-push-state').textContent = perm === 'unsupported' ? '이 브라우저는 알림을 지원하지 않아요.'
    : perm === 'denied' ? '알림이 차단돼 있어요. 크롬 사이트 설정에서 알림을 허용해 주세요.'
      : subscribed && perm === 'granted' ? '✅ 이 휴대폰으로 알림을 받고 있어요. (마감·미리 알림·세부 일정)'
        : '마감 시각이 있는 업무를 휴대폰 알림으로 받을 수 있어요.';
  $('#s-push').textContent = subscribed && perm === 'granted' ? '알림 다시 연결' : '이 휴대폰에서 알림 받기';
}

function render() {
  const d = new Date();
  $('#today-label').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`;
  $$('#space-switch button').forEach((b) => b.classList.toggle('active', b.dataset.space === viewSpace()));
  $('#add-input').placeholder = viewSpace() === 'personal' ? '개인 일 추가 (예: 치과 예약 금요일 3시)' : '할 일 추가 (예: 견적 회신 내일 3시 #영업)';
  $('#add-form').classList.toggle('hidden', !(tab === 'today' || tab === 'all'));
  if (tab === 'today') renderToday();
  if (tab === 'all') renderAll();
  if (tab === 'memo') renderMemo();
  if (tab === 'settings') renderSettings();
  if (tab !== 'today') renderTodayBadge();
}

function renderTodayBadge() {
  const today = ymd(new Date());
  const open = vt().filter((t) => t.status !== 'done');
  const n = open.filter((t) => isOverdue(t) || t.dueDate === today).length
    + open.reduce((s, t) => s + (t.checklist || []).filter((c) => !c.done && c.date && c.date <= today).length, 0);
  $('#b-today').textContent = n || '';
}

function switchTab(next) {
  tab = next;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${tab}`));
  render();
  window.scrollTo(0, 0);
}

// ---------- 편집 시트 ----------
function fillCategories(space, selected) {
  const sel = $('#sheet').elements.project;
  sel.innerHTML = '';
  const add = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.append(o); };
  add('', '미분류');
  const names = state.categories.filter((c) => (c.space || 'work') === space).map((c) => c.name);
  names.forEach((n) => add(n, n));
  if (selected && !names.includes(selected)) add(selected, selected);
  sel.value = selected || '';
}

function setEditSpace(space) {
  editing.space = space;
  $$('#e-space button').forEach((b) => b.classList.toggle('active', b.dataset.space === space));
}

function renderSubs() {
  const box = $('#e-subs');
  box.innerHTML = '';
  editSubs.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = `sub${c.done ? ' done' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = c.done;
    cb.addEventListener('change', () => { c.done = cb.checked; c.doneAt = c.done ? new Date().toISOString() : ''; renderSubs(); });
    const tx = document.createElement('span');
    tx.className = 's-text';
    tx.textContent = c.text;
    const when = document.createElement('span');
    when.className = 's-when';
    when.textContent = subWhen(c);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 's-del';
    del.textContent = '✕';
    del.addEventListener('click', () => { editSubs.splice(i, 1); renderSubs(); });
    row.append(cb, tx, when, del);
    box.append(row);
  });
  const done = editSubs.filter((c) => c.done).length;
  $('#e-sub-prog').textContent = editSubs.length ? `${done}/${editSubs.length}` : '';
}

// 선행 업무 목록 (조건 선택 포함)
function renderDeps() {
  const box = $('#e-deps');
  box.innerHTML = '';
  for (const id of editDeps) {
    const p = taskById(id);
    if (!p) continue;
    const c = editCond[id] || { mode: 'always', by: '' };
    const row = document.createElement('div');
    row.className = 'dep-row';
    const top = document.createElement('div');
    top.className = 'dep-top';
    const name = document.createElement('span');
    name.className = 'dep-name';
    name.textContent = `${p.status === 'done' ? '✓' : '🔒'} ${p.title}${p.dueDate ? ` (마감 ${dueLabel(p)})` : ''}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'dep-x';
    x.textContent = '✕';
    x.addEventListener('click', () => { editDeps = editDeps.filter((d) => d !== id); delete editCond[id]; renderDeps(); });
    top.append(name, x);

    const mode = document.createElement('select');
    [['always', '완료되면 진행'], ['ontime', '기한 내 완료되면 진행'], ['late', '기한까지 못 끝나면 진행 (대안)']].forEach(([v, label]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = label; mode.append(o);
    });
    mode.value = c.mode || 'always';
    const by = document.createElement('input');
    by.type = 'datetime-local';
    by.value = c.by || '';
    by.title = '기한 (비우면 선행 업무 마감)';
    by.classList.toggle('hidden', mode.value === 'always');
    const update = () => { editCond[id] = { mode: mode.value, by: by.value }; renderDeps(); };
    mode.addEventListener('change', update);
    by.addEventListener('change', update);
    row.append(top, mode, by);
    if (c.result) {
      const r = document.createElement('span');
      r.className = `dep-res ${c.result}`;
      r.textContent = c.result === 'go' ? '→ 진행 결정됨' : '→ 건너뜀';
      row.append(r);
    }
    box.append(row);
  }

  // 후보: 자기 자신, 이미 고른 것, 자신의 후행(순환) 제외
  const blocked = editing && editing.id ? descendants(editing.id) : new Set();
  const cands = state.tasks
    .filter((t) => t.id !== (editing && editing.id) && !editDeps.includes(t.id) && !blocked.has(t.id))
    .sort((a, b) => (a.status === 'done') - (b.status === 'done') || byTime(a, b));
  const sel = $('#e-dep-add');
  sel.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = cands.length ? '＋ 선행 업무 선택…' : '연결할 수 있는 업무가 없어요';
  sel.append(first);
  for (const t of cands) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `${t.status === 'done' ? '✓ ' : ''}${t.project ? `[${t.project}] ` : ''}${t.title}${t.dueDate ? ` (~${dueLabel(t)})` : ''}`;
    sel.append(o);
  }

  const succ = editing && editing.id ? succsOf({ id: editing.id }) : [];
  $('#e-succ').textContent = succ.length ? `후행 업무: ${succ.map((s) => s.title).join(', ')}` : '';
  $('#e-succ-btns').classList.toggle('hidden', !(editing && editing.id));
}

$('#e-dep-add').addEventListener('change', (e) => {
  if (e.target.value) editDeps.push(e.target.value);
  renderDeps();
});

// 이 업무 다음에 할 일 만들기 (편집 창을 그 자리에서 새 업무로 바꿈)
$$('#e-succ-btns [data-succ]').forEach((b) => b.addEventListener('click', () => {
  const t = editing && editing.id && taskById(editing.id);
  if (!t) return;
  const mode = b.dataset.succ;
  if (mode !== 'always' && !t.dueDate) { toast('조건부 후행은 이 업무에 마감일이 있어야 해요.'); return; }
  const base = t.dueDate || t.startDate;
  openEditor(null, {
    space: spaceOf(t),
    project: t.project,
    dependsOn: [t.id],
    depCond: mode === 'always' ? {} : { [t.id]: { mode, by: '' } },
    startDate: base ? ymd(addDays(parseYmd(base), 1)) : '',
  }, true);
}));

function openEditor(id, preset = {}, inPlace = false) {
  const t = id ? state.tasks.find((x) => x.id === id) : null;
  if (id && !t) return;
  editing = t ? structuredClone(t) : { space: defaultSpace(), status: 'todo', priority: 'mid', remindBefore: 10, repeat: 'none', ...preset };
  const f = $('#sheet').elements;
  for (const k of ['title', 'status', 'dueDate', 'dueTime', 'startDate', 'priority', 'remindBefore', 'repeat', 'memo']) f[k].value = editing[k] ?? '';
  setEditSpace(editing.space || 'work');
  fillCategories(editing.space || 'work', editing.project);
  editSubs = structuredClone(editing.checklist || []);
  renderSubs();
  editDeps = [...(editing.dependsOn || [])];
  editCond = structuredClone(editing.depCond || {});
  renderDeps();
  $('#e-title').textContent = t ? '업무 수정' : '새 업무';
  $('#e-delete').classList.toggle('hidden', !t);
  $('#sheet').classList.remove('hidden');
  $('#sheet-back').classList.remove('hidden');
  $('#sheet .sheet-body').scrollTop = 0;
  if (!inPlace) history.pushState({ sheet: true }, '');
}

function closeEditor(fromPop) {
  if ($('#sheet').classList.contains('hidden')) return;
  $('#sheet').classList.add('hidden');
  $('#sheet-back').classList.add('hidden');
  editing = null;
  if (!fromPop && history.state && history.state.sheet) history.back();
}

function addSubFromInputs() {
  const text = $('#e-sub-text').value.trim();
  if (!text) return null;
  let date = $('#e-sub-date').value;
  const time = $('#e-sub-time').value;
  if (time && !date) date = ymd(new Date());
  const item = { id: newId(), text, done: false, date, time };
  editSubs.push(item);
  $('#e-sub-text').value = '';
  $('#e-sub-time').value = '';
  renderSubs();
  return item;
}

$('#e-sub-add').addEventListener('click', addSubFromInputs);
$('#e-sub-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addSubFromInputs(); }
});
$$('#e-space button').forEach((b) => b.addEventListener('click', () => {
  const cur = $('#sheet').elements.project.value;
  setEditSpace(b.dataset.space);
  const ok = state.categories.some((c) => c.name === cur && (c.space || 'work') === b.dataset.space);
  fillCategories(b.dataset.space, ok ? cur : '');
}));
$('#e-cancel').addEventListener('click', () => closeEditor());
$('#sheet-back').addEventListener('click', () => closeEditor());
window.addEventListener('popstate', () => closeEditor(true));

$('#sheet').addEventListener('submit', (e) => {
  e.preventDefault();
  addSubFromInputs();
  const f = e.target.elements;
  const data = {
    title: f.title.value.trim(),
    space: editing.space || 'work',
    project: f.project.value,
    status: f.status.value,
    dueDate: f.dueDate.value,
    dueTime: f.dueTime.value,
    startDate: f.startDate.value,
    priority: f.priority.value,
    remindBefore: Number(f.remindBefore.value),
    repeat: f.repeat.value,
    memo: f.memo.value,
    checklist: editSubs,
    dependsOn: editDeps,
    depCond: Object.fromEntries(editDeps.filter((id) => editCond[id] && editCond[id].mode !== 'always').map((id) => {
      const before = editing.id && taskById(editing.id) && (taskById(editing.id).depCond || {})[id];
      const now = editCond[id];
      // 조건이 그대로면 판단 결과 유지, 바뀌었으면 PC가 다시 판단
      const same = before && before.mode === now.mode && (before.by || '') === (now.by || '');
      return [id, same ? before : { mode: now.mode, by: now.by || '' }];
    })),
  };
  if (!data.title) return;
  if (data.dueTime && !data.dueDate) data.dueDate = ymd(new Date());
  if (data.startDate && data.dueDate && data.startDate > data.dueDate) { toast('시작일이 마감일보다 늦어요.'); return; }
  if (data.repeat !== 'none' && !data.dueDate) { toast('반복 업무는 마감일이 필요해요.'); return; }
  if (editing.id) data.id = editing.id;
  window.api.saveTask(data);
  closeEditor();
  toast('저장했어요.');
});

$('#e-delete').addEventListener('click', () => {
  if (!editing || !editing.id) return;
  if (!confirm('이 업무를 삭제할까요?')) return;
  window.api.deleteTask(editing.id);
  closeEditor();
});

// ---------- 빠른 추가 / 메모 / 보기 전환 ----------
$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#add-input').value.trim();
  if (!text) return;
  const parsed = addWhen.apply(parseQuick(text));
  window.api.saveTask({ ...parsed, space: parsed.space || defaultSpace() });
  $('#add-input').value = '';
  const msg = $('#added');
  msg.textContent = `✓ 추가됨: ${parsed.title} · ${whenLabel(parsed)}`;
  msg.classList.remove('hidden');
  clearTimeout(msg._t);
  msg._t = setTimeout(() => msg.classList.add('hidden'), 3000);
  addWhen.reset();
});

$('#m-save').addEventListener('click', () => {
  const text = $('#m-input').value.trim();
  if (!text) return;
  window.api.saveNote({ text, space: defaultSpace() });
  $('#m-input').value = '';
});

$$('#space-switch button').forEach((b) => b.addEventListener('click', () => {
  state.settings.viewSpace = b.dataset.space;
  persist();
  render();
}));
$$('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('#f-search').addEventListener('input', renderAll);
$('#f-status').addEventListener('change', renderAll);

// ---------- 설정: 로그아웃 / 알림 ----------
$('#s-sync-now').addEventListener('click', () => runSync());
$('#s-logout').addEventListener('click', () => {
  if (!confirm('로그아웃할까요? 이 휴대폰에 저장된 사본도 지워져요.')) return;
  cloud.signOut();
  meta = { cursor: null, known: {} };
  state.tasks = []; state.categories = []; state.notes = [];
  persist();
  LS.set('td_push', false);
  showLogin();
});

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function savePushSubscription(sub) {
  await cloud.rest('POST', 'push_subs?on_conflict=endpoint', [{
    endpoint: sub.endpoint,
    sub: sub.toJSON(),
    prefs: { workOff: !!LS.get('td_workoff', false) },
    tz_offset: new Date().getTimezoneOffset(),
  }], 'resolution=merge-duplicates,return=minimal');
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('이 브라우저는 알림을 지원하지 않아요. 크롬에서 열어주세요.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('알림 권한을 허용해야 받을 수 있어요.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(CLOUD_CONFIG.vapidPublic) });
  await savePushSubscription(sub);
  LS.set('td_push', true);
}

$('#s-push').addEventListener('click', async () => {
  try { await enablePush(); toast('알림을 연결했어요.'); } catch (e) { toast(e.message); }
  renderSettings();
});
$('#s-workoff').addEventListener('change', async () => {
  LS.set('td_workoff', $('#s-workoff').checked);
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await savePushSubscription(sub);
    toast($('#s-workoff').checked ? '회사 업무 알림은 휴대폰으로 보내지 않아요.' : '회사 업무 알림도 휴대폰으로 받아요.');
  } catch (e) { toast(e.message); }
});

// ---------- 로그인 ----------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  render();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#l-error').textContent = '';
  try {
    await cloud.signIn($('#l-email').value.trim(), $('#l-pass').value);
    meta = { cursor: null, known: {} };
    state.tasks = []; state.categories = []; state.notes = [];
    $('#l-pass').value = '';
    showApp();
    await runSync();
  } catch (err) {
    $('#l-error').textContent = /invalid/i.test(err.message) ? '이메일 또는 비밀번호가 맞지 않아요.' : err.message;
  }
});

// ---------- 시작 ----------
function start() {
  const data = LS.get('td_data', null);
  if (data) Object.assign(state, data);
  meta = LS.get('td_meta', meta);
  state.settings.viewSpace = LS.get('td_view', 'all');
  addWhen = createQuickWhen($('#add-when'));
  cloud = new Cloud({ url: CLOUD_CONFIG.url, key: CLOUD_CONFIG.key, session: LS.get('td_session', null) }, (s) => LS.set('td_session', s));

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (!cloud.signedIn) { showLogin(); return; }
  showApp();
  runSync();

  // 알림을 눌러 열린 경우 해당 업무 열기 / ?tab=memo 같은 바로가기
  const params = new URLSearchParams(location.search);
  const taskId = params.get('task');
  if (params.get('tab')) switchTab(params.get('tab'));
  if (taskId || params.get('tab')) history.replaceState(null, '', location.pathname);
  if (taskId) setTimeout(() => openEditor(taskId), 300);
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); runSync(); } });
window.addEventListener('online', () => runSync());
setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 30000);
setInterval(() => { if (document.visibilityState === 'visible') render(); }, 60000);
navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data && e.data.openTask) openEditor(e.data.openTask);
});

start();
