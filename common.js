// 메인 창과 퀵 패널이 함께 쓰는 유틸 (state 전역 변수를 참조)

// ---------- 날짜 유틸 ----------
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseYmd(s) { return new Date(`${s}T00:00`); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function mondayOf(d, extraDays = 0) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7) + extraDays);
  return x;
}
function dayDiff(a, b) { return Math.round((parseYmd(ymd(b)) - parseYmd(ymd(a))) / 86400000); }
const WD = ['일', '월', '화', '수', '목', '금', '토'];

function dueAt(t) {
  if (!t.dueDate) return null;
  return new Date(`${t.dueDate}T${t.dueTime || '23:59'}`);
}
function isOverdue(t) {
  return t.status !== 'done' && t.dueDate && dueAt(t) < new Date();
}

function dueLabel(t) {
  if (!t.dueDate) return '';
  const today = new Date();
  const diff = dayDiff(today, parseYmd(t.dueDate));
  let day;
  if (diff === 0) day = '오늘';
  else if (diff === 1) day = '내일';
  else if (diff === 2) day = '모레';
  else if (diff === -1) day = '어제';
  else {
    const d = parseYmd(t.dueDate);
    day = `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  }
  return t.dueTime ? `${day} ${t.dueTime}` : day;
}

// ---------- 빠른 추가 파서 ----------
function parseQuick(text) {
  let s = ` ${text} `;
  const out = { priority: 'mid' };
  const today = new Date();
  let date = null;
  let time = null;

  s = s.replace(/\s#(\S+)/, (_, p) => { out.project = p; return ' '; });
  s = s.replace(/\s!(?=\s)/, () => { out.priority = 'high'; return ' '; });
  s = s.replace(/\s@(개인|회사)(?=\s)/, (_, w) => { out.space = w === '개인' ? 'personal' : 'work'; return ' '; });
  s = s.replace(/\s@일정(?=\s)/, () => { out.kind = 'event'; return ' '; });

  const rel = { '오늘': 0, '내일': 1, '모레': 2 };
  s = s.replace(/\s(오늘|내일|모레)(?=\s|까지)/, (_, w) => { date = addDays(today, rel[w]); return ' '; });

  s = s.replace(/\s(다음\s?주\s?)?([월화수목금토일])요일(?=\s|까지)/, (_, next, w) => {
    const target = WD.indexOf(w);
    let diff = (target - today.getDay() + 7) % 7;
    if (next) diff = ((target + 6) % 7) - ((today.getDay() + 6) % 7) + 7;
    date = addDays(today, diff);
    return ' ';
  });

  s = s.replace(/\s(\d{1,2})[/.](\d{1,2})(?=\s|까지)/, (_, m, d) => {
    date = new Date(today.getFullYear(), m - 1, d);
    if (date < addDays(today, -30)) date.setFullYear(date.getFullYear() + 1);
    return ' ';
  });
  s = s.replace(/\s(\d{1,2})월\s?(\d{1,2})일(?=\s|까지)/, (_, m, d) => {
    date = new Date(today.getFullYear(), m - 1, d);
    if (date < addDays(today, -30)) date.setFullYear(date.getFullYear() + 1);
    return ' ';
  });

  // 시간 범위 (일정용): 15:00~16:30, 3시~4시, 오후 2시~3시반
  const toHM = (ap, h, m, half) => {
    h = Number(h);
    if (ap === '오후' && h < 12) h += 12;
    if (ap === '오전' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 7) h += 12;
    return `${pad(h)}:${pad(half ? 30 : Number(m || 0))}`;
  };
  s = s.replace(/\s(\d{1,2}):(\d{2})\s?[~-]\s?(\d{1,2}):(\d{2})(?=\s|까지)/, (_, h1, m1, h2, m2) => {
    time = `${pad(h1)}:${m1}`;
    out.endTime = `${pad(h2)}:${m2}`;
    return ' ';
  });
  s = s.replace(/\s(오전|오후)?\s?(\d{1,2})시(?:\s?(\d{1,2})분|\s?(반))?\s?[~-]\s?(오전|오후)?\s?(\d{1,2})시(?:\s?(\d{1,2})분|\s?(반))?(?=\s|까지)/,
    (_, ap1, h1, m1, half1, ap2, h2, m2, half2) => {
      time = toHM(ap1, h1, m1, half1);
      out.endTime = toHM(ap2 || ap1, h2, m2, half2);
      return ' ';
    });
  s = s.replace(/\s(\d{1,2}):(\d{2})(?=\s|까지)/, (_, h, m) => { time = `${pad(h)}:${m}`; return ' '; });
  s = s.replace(/\s(오전|오후)?\s?(\d{1,2})시(?:\s?(\d{1,2})분|\s?반)?(?=\s|까지)/, (all, ap, h, m) => {
    h = Number(h);
    if (ap === '오후' && h < 12) h += 12;
    if (ap === '오전' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 7) h += 12; // "3시" → 오후 3시로 해석 (업무시간 기준)
    const min = all.includes('반') ? 30 : Number(m || 0);
    time = `${pad(h)}:${pad(min)}`;
    return ' ';
  });
  s = s.replace(/\s까지(?=\s)/, ' ');

  if (time && !date) {
    date = new Date(today);
    const [h, m] = time.split(':').map(Number);
    if (h * 60 + m <= today.getHours() * 60 + today.getMinutes()) date = addDays(date, 1);
  }
  out.title = s.replace(/\s+/g, ' ').trim() || text.trim();
  if (date) out.dueDate = ymd(date);
  if (time) out.dueTime = time;
  return out;
}

// ---------- 공간 (회사 / 개인) ----------
const SPACE_LABEL = { work: '💼 회사', personal: '🏠 개인' };
const spaceOf = (x) => (x && x.space) || 'work';
const viewSpace = () => (state.settings && state.settings.viewSpace) || 'all';
const inView = (x) => viewSpace() === 'all' || spaceOf(x) === viewSpace();
// 새로 만드는 업무/메모의 기본 공간: 개인 보기면 개인, 그 외엔 회사
const defaultSpace = () => (viewSpace() === 'personal' ? 'personal' : 'work');

// ---------- 분류 / 선행·후행 / 세부 업무 헬퍼 ----------
const catColor = (name) => (state.categories || []).find((c) => c.name === name)?.color || '#6b7385';
const taskById = (id) => state.tasks.find((t) => t.id === id);
const predsOf = (t) => (t.dependsOn || []).map(taskById).filter(Boolean);
const succsOf = (t) => state.tasks.filter((x) => (x.dependsOn || []).includes(t.id));
const condOf = (t, predId) => {
  const c = t.depCond && t.depCond[predId];
  return c && c.mode !== 'always' ? c : null;
};
// 조건부 연결: 결과가 'go'가 될 때까지 대기 / 일반 연결: 선행 완료까지 대기
const isBlocked = (t) => t.status !== 'done' && predsOf(t).some((p) => {
  const c = condOf(t, p.id);
  return c ? c.result !== 'go' : p.status !== 'done';
});

function condDeadline(pred, cond) {
  if (cond && cond.by) return new Date(cond.by);
  return pred.dueDate ? dueAt(pred) : null;
}
function fmtDeadline(d) {
  if (!d) return '기한 미정';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})${hm === '23:59' ? '' : ` ${hm}`}`;
}
// 카드/패널용 조건 설명
function condLabel(t) {
  for (const p of predsOf(t)) {
    const c = condOf(t, p.id);
    if (!c) continue;
    const when = fmtDeadline(condDeadline(p, c));
    if (c.result === 'go') return c.mode === 'late' ? `🔀 대안 진행 중 ("${p.title}" 기한 초과)` : '';
    return c.mode === 'ontime'
      ? `⏳ "${p.title}" ${when}까지 완료되면 진행`
      : `🔀 대안: "${p.title}" ${when}까지 못 끝나면 진행`;
  }
  return '';
}
const newId = () => Math.random().toString(36).slice(2);

// 이 업무 뒤에 이어지는 모든 후행 업무 (순환 연결 방지용)
function descendants(id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const x of state.tasks) {
      if ((x.dependsOn || []).includes(cur) && !out.has(x.id)) { out.add(x.id); stack.push(x.id); }
    }
  }
  return out;
}

function subWhen(c) {
  if (!c.date) return '';
  const diff = dayDiff(new Date(), parseYmd(c.date));
  const d = parseYmd(c.date);
  const day = diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === -1 ? '어제' : `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  return c.time ? `${day} ${c.time}` : day;
}
const subOverdue = (c) => !c.done && c.date && new Date(`${c.date}T${c.time || '23:59'}`) < new Date();

function setStatus(t, status) {
  if (status === 'done' && isBlocked(t)) {
    const names = predsOf(t).filter((p) => p.status !== 'done').map((p) => `· ${p.title}`).join('\n');
    if (!confirm(`아직 끝나지 않은 선행 업무가 있어요.\n${names}\n\n그래도 완료 처리할까요?`)) return;
  }
  window.api.saveTask({ id: t.id, status });
}

function toggleSub(t, subId) {
  const checklist = (t.checklist || []).map((c) => (c.id === subId
    ? { ...c, done: !c.done, doneAt: c.done ? '' : new Date().toISOString() }
    : c));
  window.api.saveTask({ id: t.id, checklist });
}


// ---------- 메모 ----------
function fmtAgo(iso) {
  const d = new Date(iso);
  const min = (Date.now() - d) / 60000;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (min < 1) return '방금';
  if (min < 60) return `${Math.floor(min)}분 전`;
  if (ymd(d) === ymd(new Date())) return `오늘 ${hm}`;
  if (dayDiff(d, new Date()) === 1) return `어제 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${hm}`;
}

function sortedNotes(q = '') {
  const query = q.trim().toLowerCase();
  return (state.notes || [])
    .filter((n) => inView(n) && (!query || n.text.toLowerCase().includes(query)))
    .sort((a, b) => (b.pinned - a.pinned) || b.createdAt.localeCompare(a.createdAt));
}

// 메모 첫 줄을 업무 제목으로(날짜/시간/#분류 인식), 나머지는 업무 메모로
async function noteToTask(n) {
  const [first, ...rest] = n.text.trim().split('\n');
  const parsed = parseQuick(first);
  const task = await window.api.saveTask({ ...parsed, space: parsed.space || spaceOf(n), memo: rest.join('\n').trim() });
  await window.api.saveNote({ id: n.id, taskId: task.id });
  return task;
}

function noteEl(n, { onOpenTask, onConverted } = {}) {
  const el = document.createElement('div');
  el.className = `note${n.pinned ? ' pinned' : ''}`;

  const text = document.createElement('div');
  text.className = 'note-text';
  text.textContent = n.text;
  text.title = '클릭해서 수정';
  text.addEventListener('click', () => {
    const ta = document.createElement('textarea');
    ta.className = 'note-edit';
    ta.value = n.text;
    ta.rows = Math.min(10, Math.max(3, n.text.split('\n').length + 1));
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = ta.value.trim();
      if (save && v && v !== n.text) window.api.saveNote({ id: n.id, text: v });
      else ta.replaceWith(text);
    };
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    text.replaceWith(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });

  const foot = document.createElement('div');
  foot.className = 'note-foot';
  const time = document.createElement('span');
  time.className = 'note-time';
  time.textContent = fmtAgo(n.createdAt);
  foot.append(time);

  const linked = n.taskId && taskById(n.taskId);
  if (linked) {
    const a = document.createElement('button');
    a.className = 'note-link';
    a.textContent = `→ ${linked.status === 'done' ? '✓ ' : ''}${linked.title}`;
    a.title = '연결된 업무 열기';
    a.addEventListener('click', () => onOpenTask && onOpenTask(linked.id));
    foot.append(a);
  }
  const sp = document.createElement('span');
  sp.className = 'spacer';
  foot.append(sp);

  const btn = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'note-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', fn);
    foot.append(b);
    return b;
  };
  btn(n.pinned ? '📌' : '📍', n.pinned ? '고정 해제' : '위에 고정', () => window.api.saveNote({ id: n.id, pinned: !n.pinned }));
  if (!linked) {
    btn('✅ 업무로', '첫 줄을 제목으로 업무 등록', async () => {
      const task = await noteToTask(n);
      if (onConverted) onConverted(task);
    });
  }
  const del = btn('🗑', '삭제', () => {
    if (del.dataset.armed) { window.api.deleteNote(n.id); return; }
    del.dataset.armed = '1';
    del.textContent = '삭제?';
    del.classList.add('armed');
    setTimeout(() => { delete del.dataset.armed; del.textContent = '🗑'; del.classList.remove('armed'); }, 2500);
  });

  el.append(text, foot);
  return el;
}

// ---------- 빠른 추가: 날짜/시간 선택 바 ----------
// [오늘][내일][모레][날짜][시간]  — 기본 '오늘', 같은 버튼을 다시 누르면 날짜 없음.
// 입력 문장에 날짜/시간이 있으면 그쪽이 우선.
function createQuickWhen(root, opts = {}) {
  root.classList.add('qw');
  let kind = 'task';
  root.innerHTML = (opts.kind ? `
    <span class="qw-kind">
      <button type="button" data-k="task" class="on">✓ 할 일</button>
      <button type="button" data-k="event">📅 일정</button>
    </span>` : '') + `
    <button type="button" data-d="0">오늘</button>
    <button type="button" data-d="1">내일</button>
    <button type="button" data-d="2">모레</button>
    <input type="date" class="qw-date" title="날짜 직접 선택" />
    <input type="time" class="qw-time" title="시간 (선택, 입력하면 알림)" />
    <button type="button" class="qw-none" title="날짜 없이 등록">날짜 없음</button>`;
  const dateIn = root.querySelector('.qw-date');
  const timeIn = root.querySelector('.qw-time');
  let date = '';

  const paint = () => {
    root.querySelectorAll('[data-d]').forEach((b) => b.classList.toggle('on', !!date && date === ymd(addDays(new Date(), Number(b.dataset.d)))));
    root.querySelector('.qw-none').classList.toggle('on', !date);
    dateIn.value = date;
    dateIn.classList.toggle('on', !!date && ![0, 1, 2].some((n) => date === ymd(addDays(new Date(), n))));
  };
  const setDate = (d) => { date = d; paint(); };

  root.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
    const d = ymd(addDays(new Date(), Number(b.dataset.d)));
    setDate(date === d ? '' : d);
  }));
  root.querySelector('.qw-none').addEventListener('click', () => { setDate(''); timeIn.value = ''; });
  dateIn.addEventListener('change', () => setDate(dateIn.value));
  timeIn.addEventListener('change', () => {
    timeIn.classList.toggle('on', !!timeIn.value);
    if (timeIn.value && !date) setDate(ymd(new Date()));
  });

  const paintKind = () => root.querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', b.dataset.k === kind));
  root.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.k;
    paintKind();
    if (opts.onKind) opts.onKind(kind);
  }));

  const api = {
    kind: () => kind,
    // 문장에서 못 찾은 날짜/시간을 선택 바 값으로 채움
    apply(parsed) {
      if (!parsed.dueDate && date) parsed.dueDate = date;
      if (!parsed.dueTime && timeIn.value && parsed.dueDate === date) parsed.dueTime = timeIn.value;
      return parsed;
    },
    reset() { timeIn.value = ''; timeIn.classList.remove('on'); setDate(ymd(new Date())); },
  };
  api.reset();
  return api;
}

function whenLabel(t) {
  return t.dueDate ? dueLabel(t) : '날짜 없음';
}

// ---------- 일정 (캘린더) ----------
// 일정: { id, title, date, endDate(여러 날), allDay, startTime, endTime, location, memo,
//         space, project, remindBefore(-1 = 알림 없음), repeat: none|daily|weekly|monthly|yearly }
const EVENT_REPEAT = { none: '반복 안 함', daily: '매일', weekly: '매주', monthly: '매월', yearly: '매년' };

function evSpanDays(ev) {
  return ev.endDate && ev.endDate > ev.date ? dayDiff(parseYmd(ev.date), parseYmd(ev.endDate)) : 0;
}

// 날짜 d('YYYY-MM-DD')에 시작하는 회차가 있는지
// 반복 규칙: repeat(daily|weekly|monthly|yearly) · repeatEvery(N마다, 기본 1)
//            repeatDays(매주일 때 요일 0~6, 비우면 시작 요일) · repeatUntil(종료일, 비우면 계속)
function evStartsOn(ev, d) {
  if (!ev.date || d < ev.date) return false;
  if (ev.repeatUntil && d > ev.repeatUntil) return false;
  const r = ev.repeat || 'none';
  if (r === 'none') return d === ev.date;
  const n = Math.max(1, Number(ev.repeatEvery) || 1);
  const a = parseYmd(ev.date);
  const b = parseYmd(d);
  if (r === 'daily') return dayDiff(a, b) % n === 0;
  if (r === 'weekly') {
    const days = ev.repeatDays && ev.repeatDays.length ? ev.repeatDays.map(Number) : [a.getDay()];
    if (!days.includes(b.getDay())) return false;
    const weeks = Math.round(dayDiff(addDays(a, -a.getDay()), addDays(b, -b.getDay())) / 7); // 일요일 기준 몇 주째
    return weeks % n === 0;
  }
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (r === 'monthly') return a.getDate() === b.getDate() && months % n === 0;
  if (r === 'yearly') return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && (b.getFullYear() - a.getFullYear()) % n === 0;
  return false;
}

// '2주마다 월·수 (~12/31)' 같은 설명
function repeatLabel(ev) {
  const r = ev.repeat || 'none';
  if (r === 'none') return '';
  const n = Math.max(1, Number(ev.repeatEvery) || 1);
  const unit = { daily: '일', weekly: '주', monthly: '개월', yearly: '년' }[r];
  let s = n === 1 ? EVENT_REPEAT[r] : `${n}${unit}마다`;
  if (r === 'weekly' && ev.repeatDays && ev.repeatDays.length) s += ` ${[...ev.repeatDays].map(Number).sort((x, y) => x - y).map((i) => WD[i]).join('·')}`;
  if (ev.repeatUntil) { const u = parseYmd(ev.repeatUntil); s += ` (~${u.getMonth() + 1}/${u.getDate()})`; }
  return s;
}

// 반복 설정 입력부 (메인 창 · 퀵 패널 · 휴대폰 공용). value()로 { repeat, repeatEvery, repeatDays, repeatUntil }
function createRepeatEditor(root, ev = {}, getStartDate) {
  root.classList.add('rp');
  root.innerHTML = `
    <div class="rp-line">
      <select class="rp-kind">
        <option value="none">반복 안 함</option>
        <option value="daily">일 단위</option>
        <option value="weekly">주 단위</option>
        <option value="monthly">월 단위</option>
        <option value="yearly">년 단위</option>
      </select>
      <span class="rp-every"><input type="number" class="rp-n" min="1" max="99" /><span class="rp-unit"></span>마다</span>
    </div>
    <div class="rp-days">${WD.map((w, i) => `<button type="button" data-wd="${i}">${w}</button>`).join('')}</div>
    <label class="rp-until-l"><span>종료일</span><input type="date" class="rp-until" /><span class="rp-hint">비우면 계속</span></label>
    <div class="rp-sum"></div>`;
  const kind = root.querySelector('.rp-kind');
  const num = root.querySelector('.rp-n');
  const until = root.querySelector('.rp-until');
  let days = new Set((ev.repeatDays || []).map(Number));
  kind.value = ev.repeat && ev.repeat !== 'weekdays' ? ev.repeat : (ev.repeat === 'weekdays' ? 'weekly' : 'none');
  if (ev.repeat === 'weekdays') days = new Set([1, 2, 3, 4, 5]);
  num.value = String(Math.max(1, Number(ev.repeatEvery) || 1));
  until.value = ev.repeatUntil || '';

  const value = () => {
    const r = kind.value;
    if (r === 'none') return { repeat: 'none', repeatEvery: 1, repeatDays: [], repeatUntil: '' };
    return {
      repeat: r,
      repeatEvery: Math.min(99, Math.max(1, Number(num.value) || 1)),
      repeatDays: r === 'weekly' ? [...days].sort((x, y) => x - y) : [],
      repeatUntil: until.value || '',
    };
  };
  const paint = () => {
    const r = kind.value;
    root.classList.toggle('off', r === 'none');
    root.querySelector('.rp-unit').textContent = { daily: '일', weekly: '주', monthly: '개월', yearly: '년' }[r] || '';
    root.querySelector('.rp-days').classList.toggle('hidden', r !== 'weekly');
    root.querySelectorAll('[data-wd]').forEach((b) => b.classList.toggle('on', days.has(Number(b.dataset.wd))));
    const start = getStartDate ? getStartDate() : ev.date;
    const label = repeatLabel({ ...value(), date: start });
    root.querySelector('.rp-sum').textContent = r === 'none' ? '' : `🔁 ${label}${r === 'weekly' && !days.size && start ? ` (${WD[parseYmd(start).getDay()]}요일)` : ''}`;
  };
  kind.addEventListener('change', paint);
  num.addEventListener('input', paint);
  until.addEventListener('change', paint);
  root.querySelectorAll('[data-wd]').forEach((b) => b.addEventListener('click', () => {
    const d = Number(b.dataset.wd);
    if (days.has(d)) days.delete(d); else days.add(d);
    paint();
  }));
  paint();
  return { value, refresh: paint };
}


// 날짜 d에 걸쳐 있는 회차의 시작일 (없으면 null)
function evOccurrenceOn(ev, d) {
  const span = evSpanDays(ev);
  for (let k = 0; k <= span; k++) {
    const s = ymd(addDays(parseYmd(d), -k));
    if (evStartsOn(ev, s)) return s;
  }
  return null;
}

function eventsOn(d, list) {
  return (list || state.events || [])
    .map((ev) => { const start = evOccurrenceOn(ev, d); return start ? { ev, start } : null; })
    .filter(Boolean)
    .sort((a, b) => (a.ev.allDay ? '' : a.ev.startTime || '').localeCompare(b.ev.allDay ? '' : b.ev.startTime || ''));
}

function evTimeLabel(ev) {
  if (ev.allDay || !ev.startTime) return '종일';
  return ev.endTime ? `${ev.startTime}~${ev.endTime}` : ev.startTime;
}

// ---------- 공유 캘린더 ----------
const calOf = (ev) => (ev && ev.calendarId ? (state.calendars || []).find((c) => c.id === ev.calendarId) : null);
const hiddenCals = () => (state.settings && state.settings.hiddenCals) || [];

// 화면에 보일 일정: 내 캘린더 + 숨기지 않은 공유 캘린더
function allEvents() {
  const hidden = hiddenCals();
  const mine = hidden.includes('me') ? [] : (state.events || []);
  const shared = (state.sharedEvents || []).filter((e) => !hidden.includes(e.calendarId) && calOf(e));
  return [...mine, ...shared];
}

function findEvent(id) {
  return (state.events || []).find((e) => e.id === id) || (state.sharedEvents || []).find((e) => e.id === id) || null;
}

function canEditEvent(ev) {
  const c = calOf(ev);
  return !ev.calendarId || (c && c.role !== 'viewer');
}

function evColor(ev) {
  const cal = calOf(ev);
  if (cal) return cal.color;
  if (ev.project) return catColor(ev.project);
  return spaceOf(ev) === 'personal' ? '#8e4ec6' : '#0091ff';
}

function plusHour(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h >= 23 ? '23:59' : `${pad(h + 1)}:${pad(m)}`;
}

// 빠른 추가 결과 → 일정
function quickToEvent(p) {
  const start = p.dueTime || '';
  return {
    title: p.title,
    date: p.dueDate || ymd(new Date()),
    startTime: start,
    endTime: start ? (p.endTime && p.endTime > start ? p.endTime : plusHour(start)) : '',
    allDay: !start,
    space: p.space || defaultSpace(),
    project: p.project || '',
    remindBefore: 10,
    repeat: 'none',
  };
}

function evWhenLabel(ev) {
  const diff = dayDiff(new Date(), parseYmd(ev.date));
  const d = parseYmd(ev.date);
  const day = diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === 2 ? '모레' : `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  return `${day} ${evTimeLabel(ev)}`;
}

// 방금 추가한 항목이 지금 화면 필터 때문에 안 보이면 그 이유 (보이면 '')
function hiddenReason(item, kind) {
  const v = viewSpace();
  if (v !== 'all' && spaceOf(item) !== v) {
    return `${SPACE_LABEL[spaceOf(item)]} 항목이라 지금 보기(${SPACE_LABEL[v]})에서는 안 보여요`;
  }
  if (kind === 'event' && !item.calendarId && hiddenCals().includes('me')) return '내 캘린더를 숨겨둔 상태라 안 보여요';
  return '';
}
