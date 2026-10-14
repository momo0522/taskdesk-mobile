// Supabase 동기화 (PC 코어와 휴대폰 앱이 함께 사용)
//
// 서버 테이블 items(user_id, kind, id, data, deleted, updated_at, server_at) 한 곳에
// 업무(task) · 일정(event) · 메모(note) · 분류(category, id = 이름)를 한 줄씩 저장한다.
//  - 올리기: 마지막으로 맞춘 내용의 해시(meta.known)와 지금 내용을 비교해 바뀐 것만 업로드,
//            사라진 것은 삭제 표시(deleted=true)로 업로드
//  - 받기: server_at이 meta.cursor 이후인 줄만 받아서 반영
//  - 충돌: 마지막 수정이 이김 (서버 트리거가 updated_at이 더 오래된 덮어쓰기를 무시)
// 알림을 보냈는지 같은 기기별 상태는 동기화하지 않는다.

const SYNC_KINDS = ['task', 'note', 'category', 'event'];

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function hashStr(s) {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// 기기별 상태(알림 발송 여부)를 뺀 동기화용 사본
function cleanItem(kind, x) {
  if (kind !== 'task') return x;
  const { notifiedRemind, notifiedDue, ...rest } = x;
  rest.checklist = (x.checklist || []).map(({ notified, ...c }) => c);
  return rest;
}

const itemHash = (kind, x) => hashStr(stableStringify(cleanItem(kind, x)));

function itemSpace(kind, x) {
  return (x && x.space) || 'work';
}

// 지금 상태에서 동기화 대상 목록 (scope: 'all' | 'personal')
function collectItems(state, scope = 'all') {
  const map = new Map();
  const ok = (kind, x) => scope !== 'personal' || itemSpace(kind, x) === 'personal';
  for (const t of state.tasks || []) if (ok('task', t)) map.set(`task:${t.id}`, { kind: 'task', id: t.id, data: t });
  for (const n of state.notes || []) if (ok('note', n)) map.set(`note:${n.id}`, { kind: 'note', id: n.id, data: n });
  for (const c of state.categories || []) if (ok('category', c)) map.set(`category:${c.name}`, { kind: 'category', id: c.name, data: c });
  for (const e of state.events || []) if (ok('event', e)) map.set(`event:${e.id}`, { kind: 'event', id: e.id, data: e });
  return map;
}

function existsLocally(state, kind, id) {
  if (kind === 'task') return (state.tasks || []).some((t) => t.id === id);
  if (kind === 'note') return (state.notes || []).some((n) => n.id === id);
  if (kind === 'event') return (state.events || []).some((e) => e.id === id);
  return (state.categories || []).some((c) => c.name === id);
}

// ---------- Supabase 연결 (REST) ----------
class Cloud {
  // cfg: { url, key, session: { access, refresh, expiresAt, userId, email } }, onSession: 세션이 바뀌면 저장
  constructor(cfg, onSession) {
    this.url = cfg.url.replace(/\/+$/, '');
    this.key = cfg.key;
    this.session = cfg.session || null;
    this.onSession = onSession || (() => {});
  }

  get signedIn() { return !!(this.session && this.session.refresh); }

  async authRequest(path, body) {
    const res = await fetch(`${this.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error_description || j.msg || j.message || `로그인 실패 (${res.status})`);
    return j;
  }

  setSession(j) {
    if (!j.access_token) throw new Error('이메일 확인이 필요한 설정이에요. 관리자에게 문의하세요.');
    this.session = {
      access: j.access_token,
      refresh: j.refresh_token,
      expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
      userId: j.user && j.user.id,
      email: j.user && j.user.email,
    };
    this.onSession(this.session);
  }

  async signIn(email, password) {
    this.setSession(await this.authRequest('token?grant_type=password', { email, password }));
  }

  async signUp(email, password) {
    this.setSession(await this.authRequest('signup', { email, password }));
  }

  signOut() {
    this.session = null;
    this.onSession(null);
  }

  async token() {
    if (!this.signedIn) throw new Error('로그인이 필요해요.');
    if (Date.now() > this.session.expiresAt - 60000) {
      try {
        this.setSession(await this.authRequest('token?grant_type=refresh_token', { refresh_token: this.session.refresh }));
      } catch (e) {
        if (/invalid|expired|not found/i.test(e.message)) this.signOut();
        throw e;
      }
    }
    return this.session.access;
  }

  async rest(method, path, body, prefer) {
    const headers = { apikey: this.key, Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${this.url}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`서버 오류 ${res.status}: ${t.slice(0, 200)}`);
    }
    return res.status === 204 || method !== 'GET' ? null : res.json();
  }
}

// ---------- 올리기 ----------
async function syncPush(cloud, state, meta, scope = 'all') {
  meta.known = meta.known || {};
  const items = collectItems(state, scope);
  const rows = [];
  const now = new Date().toISOString();
  for (const [k, it] of items) {
    const h = itemHash(it.kind, it.data);
    if (meta.known[k] !== h) rows.push({ k, h, row: { kind: it.kind, id: it.id, data: cleanItem(it.kind, it.data), deleted: false, updated_at: now } });
  }
  for (const k of Object.keys(meta.known)) {
    if (items.has(k)) continue;
    const [kind, ...rest] = k.split(':');
    const id = rest.join(':');
    if (existsLocally(state, kind, id)) { delete meta.known[k]; continue; } // 범위 밖으로 빠진 것: 서버 사본은 그대로 둠
    rows.push({ k, h: null, row: { kind, id, data: {}, deleted: true, updated_at: now } });
  }
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    await cloud.rest('POST', 'items?on_conflict=user_id,kind,id', batch.map((r) => r.row), 'resolution=merge-duplicates,return=minimal');
    for (const r of batch) {
      if (r.h) meta.known[r.k] = r.h;
      else delete meta.known[r.k];
    }
  }
  return rows.length;
}

// ---------- 받기 ----------
// 반환: { changed, completed: [이번에 완료로 바뀐 업무] }
async function syncPull(cloud, state, meta) {
  meta.known = meta.known || {};
  let changed = false;
  const completed = [];
  for (;;) {
    const since = encodeURIComponent(meta.cursor || '1970-01-01T00:00:00Z');
    const rows = await cloud.rest('GET', `items?select=kind,id,data,deleted,updated_at,server_at&server_at=gt.${since}&order=server_at.asc&limit=500`);
    for (const r of rows) {
      meta.cursor = r.server_at;
      if (!SYNC_KINDS.includes(r.kind)) continue;
      const k = `${r.kind}:${r.id}`;
      const list = r.kind === 'task' ? (state.tasks = state.tasks || [])
        : r.kind === 'note' ? (state.notes = state.notes || [])
          : r.kind === 'event' ? (state.events = state.events || []) : (state.categories = state.categories || []);
      const idx = list.findIndex((x) => (r.kind === 'category' ? x.name : x.id) === r.id);
      const local = idx >= 0 ? list[idx] : null;

      // 아직 올리지 못한 로컬 수정이 있으면 로컬 우선 (곧 올라가면서 서버를 덮어씀)
      if (local && meta.known[k] && itemHash(r.kind, local) !== meta.known[k]) continue;

      if (r.deleted) {
        if (idx >= 0) { list.splice(idx, 1); changed = true; }
        delete meta.known[k];
        continue;
      }
      const incoming = { ...r.data };
      if (r.kind === 'task') {
        // 기기별 알림 상태는 로컬 값 유지
        incoming.notifiedRemind = local ? !!local.notifiedRemind : false;
        incoming.notifiedDue = local ? !!local.notifiedDue : false;
        const prevSubs = new Map(((local && local.checklist) || []).map((c) => [c.id, c]));
        incoming.checklist = (incoming.checklist || []).map((c) => ({ ...c, notified: prevSubs.has(c.id) ? !!prevSubs.get(c.id).notified : false }));
        if (local && local.status !== 'done' && incoming.status === 'done') completed.push(incoming);
      }
      if (local && itemHash(r.kind, local) === itemHash(r.kind, incoming)) {
        meta.known[k] = itemHash(r.kind, incoming);
        continue;
      }
      if (idx >= 0) list[idx] = incoming;
      else list.push(incoming);
      meta.known[k] = itemHash(r.kind, incoming);
      changed = true;
    }
    if (rows.length < 500) break;
  }
  return { changed, completed };
}
