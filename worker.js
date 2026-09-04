/**
 * Quiz26 API — Cloudflare Worker + D1
 * Domain: https://quiz26.dpdns.org
 * Auth: JWT (HS256) + PBKDF2 password hashing via Web Crypto
 */

const CORS_ORIGINS = [
  'https://quiz26.dpdns.org',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'http://localhost:20128',
  'http://127.0.0.1:20128',
];

function corsHeaders(origin) {
  const allow = CORS_ORIGINS.includes(origin) ? origin : CORS_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Student-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
  });
}

function error(msg, status = 400, origin = '') {
  return json({ success: false, message: msg }, status, origin);
}

/* ---------- Crypto helpers (Web Crypto) ---------- */
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function hashPassword(password, saltB64) {
  const salt = b64urlDecode(saltB64);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return b64url(bits);
}

function randomSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return b64url(arr);
}

async function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key, b64urlDecode(s), enc.encode(`${h}.${p}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (payload.exp) {
      const expSec = payload.exp instanceof Date ? payload.exp.getTime() / 1000 : Number(payload.exp);
      if (!isFinite(expSec) || Date.now() / 1000 > expSec) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function getAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const secret = env.JWT_SECRET || 'quiz26-dev-secret-change-me';
  return verifyJWT(auth.slice(7), secret);
}

/* ---------- Student accounts (lazy schema + auth) ---------- */
let _studentSchemaReady = false;
async function ensureStudentSchema(env) {
  if (_studentSchemaReady) return;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS students (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id    INTEGER NOT NULL,
      username      TEXT    NOT NULL COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      salt          TEXT    NOT NULL,
      full_name     TEXT    DEFAULT '',
      class_name    TEXT    DEFAULT '',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(teacher_id, username)
    )`).run();
  } catch {}
  try { await env.DB.prepare('ALTER TABLE quizzes ADD COLUMN require_login INTEGER NOT NULL DEFAULT 0').run(); } catch {}
  try { await env.DB.prepare('ALTER TABLE submissions ADD COLUMN student_user_id INTEGER').run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE submissions ADD COLUMN student_phone TEXT DEFAULT ''").run(); } catch {}
  try { await env.DB.prepare('ALTER TABLE quizzes ADD COLUMN report_after_end INTEGER NOT NULL DEFAULT 0').run(); } catch {}
  try { await env.DB.prepare('ALTER TABLE quizzes ADD COLUMN stacked_view INTEGER NOT NULL DEFAULT 0').run(); } catch {}
  try { await env.DB.prepare('ALTER TABLE quizzes ADD COLUMN attachment_json TEXT').run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE homework_submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE homework_submissions ADD COLUMN reply TEXT DEFAULT ''").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE homework_submissions ADD COLUMN replied_at TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE homework ADD COLUMN attachment_json TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE homework_submissions ADD COLUMN student_phone TEXT DEFAULT ''").run(); } catch {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_students_teacher ON students(teacher_id)').run(); } catch {}
  try {
    const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quizzes'").first();
    if (!t) {
      // Fresh D1: schema.sql never applied — create base tables (idempotent)
      const baseSchema = [
        `CREATE TABLE IF NOT EXISTS teachers (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT    NOT NULL,
          salt          TEXT    NOT NULL,
          full_name     TEXT    NOT NULL DEFAULT '',
          email         TEXT,
          school_name   TEXT,
          logo_url      TEXT,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
          last_login    TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS quizzes (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          teacher_id      INTEGER NOT NULL,
          title           TEXT    NOT NULL,
          description     TEXT    DEFAULT '',
          duration_min    INTEGER NOT NULL DEFAULT 30,
          pass_score      REAL    NOT NULL DEFAULT 50,
          shuffle_q       INTEGER NOT NULL DEFAULT 1,
          shuffle_opt     INTEGER NOT NULL DEFAULT 1,
          negative_mark   REAL    NOT NULL DEFAULT 0,
          show_result     INTEGER NOT NULL DEFAULT 1,
          anti_copy       INTEGER NOT NULL DEFAULT 1,
          anti_tab        INTEGER NOT NULL DEFAULT 1,
          max_attempts    INTEGER NOT NULL DEFAULT 1,
          status          TEXT    NOT NULL DEFAULT 'draft',
          start_at        TEXT,
          end_at          TEXT,
          report_after_end INTEGER NOT NULL DEFAULT 0,
          stacked_view    INTEGER NOT NULL DEFAULT 0,
          attachment_json TEXT,
          created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS questions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          quiz_id       INTEGER NOT NULL,
          type          TEXT    NOT NULL DEFAULT 'mcq',
          content       TEXT    NOT NULL,
          options_json  TEXT,
          correct_json  TEXT    NOT NULL,
          score         REAL    NOT NULL DEFAULT 1,
          explanation   TEXT    DEFAULT '',
          image_url     TEXT,
          sort_order    INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS submissions (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          quiz_id         INTEGER NOT NULL,
          student_name    TEXT    NOT NULL,
          student_family  TEXT    NOT NULL DEFAULT '',
          school          TEXT    DEFAULT '',
          class_name      TEXT    DEFAULT '',
          answers_json    TEXT    NOT NULL,
          score           REAL    NOT NULL DEFAULT 0,
          max_score       REAL    NOT NULL DEFAULT 0,
          percent         REAL    NOT NULL DEFAULT 0,
          passed          INTEGER NOT NULL DEFAULT 0,
          duration_sec    INTEGER DEFAULT 0,
          tab_switches    INTEGER DEFAULT 0,
          essay_grades_json TEXT   DEFAULT '{}',
          ip_address      TEXT,
          user_agent      TEXT,
          started_at      TEXT,
          student_user_id INTEGER,
          student_phone   TEXT    DEFAULT '',
          finished_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS bank_questions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          teacher_id    INTEGER NOT NULL,
          type          TEXT    NOT NULL DEFAULT 'mcq',
          content       TEXT    NOT NULL,
          options_json  TEXT,
          correct_json  TEXT    NOT NULL,
          score         REAL    NOT NULL DEFAULT 1,
          explanation   TEXT    DEFAULT '',
          subject       TEXT    DEFAULT '',
          grade         TEXT    DEFAULT '',
          chapter       TEXT    DEFAULT '',
          difficulty    TEXT    DEFAULT 'medium',
          tags          TEXT    DEFAULT '',
          is_public     INTEGER DEFAULT 0,
          use_count     INTEGER DEFAULT 0,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS homework (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          teacher_id    INTEGER NOT NULL,
          title         TEXT    NOT NULL,
          description   TEXT    DEFAULT '',
          subject       TEXT    DEFAULT '',
          due_date      TEXT,
          max_score     REAL    NOT NULL DEFAULT 10,
          status        TEXT    NOT NULL DEFAULT 'active',
          attachment_json TEXT,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS homework_submissions (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          homework_id     INTEGER NOT NULL,
          student_name    TEXT    NOT NULL,
          student_family  TEXT    NOT NULL DEFAULT '',
          school          TEXT    DEFAULT '',
          class_name      TEXT    DEFAULT '',
          answer_text     TEXT    DEFAULT '',
          status          TEXT    NOT NULL DEFAULT 'pending',
          reply           TEXT    DEFAULT '',
          replied_at      TEXT,
          student_phone   TEXT    DEFAULT '',
          files_json      TEXT    DEFAULT '[]',
          score           REAL,
          feedback        TEXT    DEFAULT '',
          comments        TEXT    DEFAULT '',
          grade           TEXT,
          graded_at       TEXT,
          submitted_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS attendance (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          teacher_id    INTEGER NOT NULL,
          class_name    TEXT    NOT NULL,
          date          TEXT    NOT NULL,
          student_name  TEXT    NOT NULL,
          student_family TEXT NOT NULL DEFAULT '',
          status        TEXT    NOT NULL DEFAULT 'present',
          note          TEXT    DEFAULT '',
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS branding (
          teacher_id    INTEGER PRIMARY KEY,
          brand_name    TEXT    DEFAULT 'Quiz26',
          primary_color TEXT    DEFAULT '#6366f1',
          subdomain     TEXT,
          logo_url      TEXT
        )`,
        'CREATE INDEX IF NOT EXISTS idx_quizzes_teacher ON quizzes(teacher_id)',
        'CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id)',
        'CREATE INDEX IF NOT EXISTS idx_submissions_quiz ON submissions(quiz_id)',
        'CREATE INDEX IF NOT EXISTS idx_bank_teacher ON bank_questions(teacher_id)',
        'CREATE INDEX IF NOT EXISTS idx_homework_teacher ON homework(teacher_id)',
        'CREATE INDEX IF NOT EXISTS idx_attendance_teacher ON attendance(teacher_id)',
      ];
      for (const st of baseSchema) { try { await env.DB.prepare(st).run(); } catch {} }
    }
  } catch {}
  _studentSchemaReady = true;
}

function getStudentAuth(request, env) {
  const tok = request.headers.get('X-Student-Token') || '';
  if (!tok) return Promise.resolve(null);
  const secret = env.JWT_SECRET || 'quiz26-dev-secret-change-me';
  return verifyJWT(tok, secret).then(p => (p && p.role === 'student') ? p : null);
}

/* ---------- Cloudflare Workers AI Helper ---------- */
async function callAI(env, systemPrompt, userPrompt, maxTokens = 2000) {
  // Cloudflare Workers AI - رایگان و بدون محدودیت منطقه‌ای
  const prompt = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  
  // مدل‌های جایگزین در Cloudflare Workers AI
  const models = [
    '@cf/meta/llama-3.1-70b-instruct',
    '@cf/meta/llama-3.1-8b-instruct',
    '@cf/google/gemma-7b-it',
    '@cf/mistral/mistral-7b-instruct-v0.3'
  ];
  
  let lastErr = null;
  for (const model of models) {
    try {
      const response = await env.AI?.run(model, {
      messages: prompt,
      max_tokens: maxTokens,
      temperature: 0.3
    });
    
    if (!response?.response) {
      throw new Error('پاسخ هوش مصنوعی خالی است.');
    }
    return response.response;
    } catch (err) {
      console.error('AI Error:', err.message);
      lastErr = err;
      // به مدل بعدی برو
      continue;
    }
  }
  console.error('All AI models failed:', lastErr?.message);
  // Fallback: بازگشت به OpenRouter اگر تنظیم شده باشد
  if (env.OPENROUTER_KEY) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const key = env.OPENROUTER_KEY;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
      },
      body: JSON.stringify({
        model: env.AI_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free',
        messages: prompt,
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: false,
      }),
    });
    
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('AI Error:', res.status, errText);
      if (res.status === 403) throw new Error('خطای دسترسی هوش مصنوعی (403).');
      if (res.status === 401) throw new Error('کلید API نامعتبر است (401).');
      if (res.status === 429) throw new Error('درخواست‌های زیادی ارسال شده.');
      throw new Error('خطای هوش مصنوعی: ' + res.status);
    }
    
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
  
  throw lastErr || new Error('هوش مصنوعی در دسترس نیست.');
}

/* ---------- Scoring ---------- */
function normPhone(p) {
  return String(p || '')
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\d+]/g, '')
    .trim().slice(0, 20);
}

function scoreSubmission(questions, answers, negativeMark = 0) {
  let score = 0;
  let maxScore = 0;
  for (const q of questions) {
    maxScore += Number(q.score) || 1;
    const ans = answers[String(q.id)];
    if (ans === undefined || ans === null || ans === '') continue;
    let correct = false;
    try {
      const correctData = JSON.parse(q.correct_json);
      if (q.type === 'mcq') {
        correct = Number(ans) === Number(correctData);
      } else if (q.type === 'multi') {
        const a = Array.isArray(ans) ? ans.map(Number).sort() : [Number(ans)];
        const c = (Array.isArray(correctData) ? correctData : [correctData]).map(Number).sort();
        correct = a.length === c.length && a.every((v, i) => v === c[i]);
      } else if (q.type === 'tf') {
        correct = String(ans).toLowerCase() === String(correctData).toLowerCase();
      } else if (q.type === 'short') {
        const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
        const accepted = Array.isArray(correctData) ? correctData : [correctData];
        correct = accepted.some(c => norm(c) === norm(ans));
      }
      // essay: not auto-graded
    } catch {}
    const qScore = Number(q.score) || 1;
    if (correct) score += qScore;
    else if (negativeMark > 0 && ans !== undefined && ans !== null && ans !== '' && q.type !== 'essay') score -= negativeMark;
  }
  score = Math.max(0, score);
  const percent = maxScore > 0 ? Math.round((score / maxScore) * 10000) / 100 : 0;
  return { score, maxScore, percent };
}

/* ---------- Router ---------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('Origin') || '';
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      await ensureStudentSchema(env);

      // Health
      if (path === '/api/health' && method === 'GET') {
        return json({ ok: true, service: 'Quiz26', ts: new Date().toISOString() }, 200, origin);
      }

      // ---------- Auth ----------
      if (path === '/api/auth/setup' && method === 'POST') {
        const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM teachers').first();
        if (count?.c > 0) return error('راه‌اندازی اولیه قبلاً انجام شده است.', 403, origin);
        const body = await request.json();
        const { username, password, full_name } = body;
        if (!username || !password || password.length < 6) {
          return error('نام کاربری و رمز عبور (حداقل ۶ کاراکتر) الزامی است.', 400, origin);
        }
        const salt = randomSalt();
        const hash = await hashPassword(password, salt);
        const r = await env.DB.prepare(
          'INSERT INTO teachers (username, password_hash, salt, full_name) VALUES (?, ?, ?, ?)'
        ).bind(username, hash, salt, full_name || username).run();
        return json({ success: true, id: r.meta.last_row_id }, 201, origin);
      }

      if (path === '/api/auth/login' && method === 'POST') {
        const body = await request.json();
        const { username, password } = body;
        if (!username || !password) return error('نام کاربری و رمز عبور الزامی است.', 400, origin);

        // Bootstrap first teacher if empty
        const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM teachers').first();
        if (count?.c === 0) {
          if (password.length < 6) return error('رمز عبور حداقل ۶ کاراکتر باشد.', 400, origin);
          const salt = randomSalt();
          const hash = await hashPassword(password, salt);
          await env.DB.prepare(
            'INSERT INTO teachers (username, password_hash, salt, full_name) VALUES (?, ?, ?, ?)'
          ).bind(username, hash, salt, username).run();
        }

        const user = await env.DB.prepare(
          'SELECT * FROM teachers WHERE username = ? COLLATE NOCASE'
        ).bind(username).first();
        if (!user) return error('نام کاربری یا رمز عبور اشتباه است.', 401, origin);

        const hash = await hashPassword(password, user.salt);
        if (hash !== user.password_hash) return error('نام کاربری یا رمز عبور اشتباه است.', 401, origin);

        await env.DB.prepare('UPDATE teachers SET last_login = datetime(\'now\') WHERE id = ?')
          .bind(user.id).run();

        const secret = env.JWT_SECRET || 'quiz26-dev-secret-change-me';
        const token = await signJWT({
          sub: user.id,
          username: user.username,
          name: user.full_name,
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7, // 7 days
        }, secret);

        return json({
          success: true,
          token,
          teacher: {
            id: user.id,
            username: user.username,
            full_name: user.full_name,
            school_name: user.school_name,
          },
        }, 200, origin);
      }

      if (path === '/api/auth/me' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const user = await env.DB.prepare(
          'SELECT id, username, full_name, email, school_name, logo_url, created_at, last_login FROM teachers WHERE id = ?'
        ).bind(payload.sub).first();
        if (!user) return error('کاربر یافت نشد.', 404, origin);
        return json({ success: true, teacher: user }, 200, origin);
      }

      if (path === '/api/auth/register' && method === 'POST') {
        const body = await request.json();
        const { username, password, full_name, email, school_name } = body;
        if (!username || !password || password.length < 6) {
          return error('نام کاربری و رمز عبور (حداقل ۶ کاراکتر) الزامی است.', 400, origin);
        }
        const exists = await env.DB.prepare(
          'SELECT id FROM teachers WHERE username = ? COLLATE NOCASE'
        ).bind(username).first();
        if (exists) return error('این نام کاربری قبلاً ثبت شده است.', 409, origin);
        const salt = randomSalt();
        const hash = await hashPassword(password, salt);
        const r = await env.DB.prepare(
          'INSERT INTO teachers (username, password_hash, salt, full_name, email, school_name) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(username, hash, salt, full_name || username, email || null, school_name || null).run();
        return json({ success: true, id: r.meta.last_row_id }, 201, origin);
      }

      // ---------- Students management ----------
      if (path === '/api/students' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const rows = (await env.DB.prepare(`
          SELECT s.id, s.username, s.full_name, s.class_name, s.created_at,
            (SELECT COUNT(*) FROM submissions WHERE student_user_id = s.id) AS exams_taken
          FROM students s WHERE s.teacher_id = ?
          ORDER BY s.created_at DESC
        `).bind(payload.sub).all()).results || [];
        return json({ success: true, students: rows }, 200, origin);
      }

      if (path === '/api/students' && method === 'POST') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const b = await request.json();
        if (!b.username || !b.password || String(b.password).length < 4) {
          return error('نام کاربری و رمز عبور (حداقل ۴ کاراکتر) الزامی است.', 400, origin);
        }
        const exists = await env.DB.prepare(
          'SELECT id FROM students WHERE teacher_id = ? AND username = ? COLLATE NOCASE'
        ).bind(payload.sub, b.username).first();
        if (exists) return error('این نام کاربری قبلاً ثبت شده است.', 409, origin);
        const salt = randomSalt();
        const hash = await hashPassword(b.password, salt);
        const r = await env.DB.prepare(`
          INSERT INTO students (teacher_id, username, password_hash, salt, full_name, class_name)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(payload.sub, b.username.trim(), hash, salt, b.full_name || '', b.class_name || '').run();
        return json({ success: true, id: r.meta.last_row_id }, 201, origin);
      }

      const studentMatch = path.match(/^\/api\/students\/(\d+)$/);
      if (studentMatch) {
        const sid = Number(studentMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const st = await env.DB.prepare(
          'SELECT * FROM students WHERE id = ? AND teacher_id = ?'
        ).bind(sid, payload.sub).first();
        if (!st) return error('دانش‌آموز یافت نشد.', 404, origin);

        if (method === 'PUT') {
          const b = await request.json();
          const fullName = b.full_name !== undefined ? b.full_name : st.full_name;
          const className = b.class_name !== undefined ? b.class_name : st.class_name;
          let pwClause = '', params = [fullName, className];
          if (b.password && String(b.password).length >= 4) {
            const salt = randomSalt();
            const hash = await hashPassword(String(b.password), salt);
            pwClause = ', password_hash = ?, salt = ?';
            params.push(hash, salt);
          }
          params.push(sid, payload.sub);
          await env.DB.prepare(
            'UPDATE students SET full_name = ?, class_name = ?' + pwClause + ' WHERE id = ? AND teacher_id = ?'
          ).bind(...params).run();
          return json({ success: true }, 200, origin);
        }

        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM students WHERE id = ? AND teacher_id = ?')
            .bind(sid, payload.sub).run();
          return json({ success: true }, 200, origin);
        }
      }

      // ---------- Student exam login ----------
      if (path === '/api/student/login' && method === 'POST') {
        const b = await request.json();
        const qid = Number(b.quiz_id);
        // Panel login (quiz_id=0): no quiz window checks — token valid for teacher's quizzes
        if (!qid) {
          if (!b.username || !b.password) return error('نام کاربری و رمز عبور الزامی است.', 400, origin);
          const panSt = await env.DB.prepare(
            'SELECT * FROM students WHERE username = ? COLLATE NOCASE'
          ).bind(String(b.username).trim()).first();
          if (!panSt) return error('نام کاربری یا رمز عبور اشتباه است.', 401, origin);
          const panHash = await hashPassword(b.password, panSt.salt);
          if (panHash !== panSt.password_hash) return error('نام کاربری یا رمز عبور اشتباه است.', 401, origin);
          const panSecret = env.JWT_SECRET || 'quiz26-dev-secret-change-me';
          const panToken = await signJWT({ role: 'student', sid: panSt.id, tid: panSt.teacher_id, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }, panSecret);
          return json({ success: true, token: panToken, student: { id: panSt.id, username: panSt.username, full_name: panSt.full_name, class_name: panSt.class_name } }, 200, origin);
        }
        if (!b.username || !b.password) return error('نام کاربری و رمز عبور الزامی است.', 400, origin);
        const quiz = await env.DB.prepare(
          'SELECT id, teacher_id, status, start_at, end_at FROM quizzes WHERE id = ?'
        ).bind(qid).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);
        if (quiz.status !== 'active') return error('این آزمون در حال حاضر فعال نیست.', 403, origin);
        const now = new Date().toISOString();
        if (quiz.start_at && now < quiz.start_at) return error('آزمون هنوز شروع نشده است.', 403, origin);
        if (quiz.end_at && now > quiz.end_at) return error('مهلت شرکت در آزمون به پایان رسیده است.', 403, origin);
        const s = await env.DB.prepare(
          'SELECT * FROM students WHERE teacher_id = ? AND username = ? COLLATE NOCASE'
        ).bind(quiz.teacher_id, String(b.username).trim()).first();
        if (!s) return error('نام کاربری یا رمز عبور اشتباه است.', 401, origin);
        const hash = await hashPassword(b.password, s.salt);
        if (hash !== s.password_hash) return error('نام کاربری یا رمز عبور اشتباه است.', 401, origin);
        const taken = await env.DB.prepare(
          'SELECT id FROM submissions WHERE quiz_id = ? AND student_user_id = ?'
        ).bind(qid, s.id).first();
        if (taken) return error('شما قبلاً در این آزمون شرکت کرده‌اید و اجازه ورود مجدد ندارید.', 403, origin);
        const secret = env.JWT_SECRET || 'quiz26-dev-secret-change-me';
        const token = await signJWT({
          role: 'student', sid: s.id, tid: quiz.teacher_id,
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
        }, secret);
        return json({
          success: true, token,
          student: { id: s.id, username: s.username, full_name: s.full_name, class_name: s.class_name },
        }, 200, origin);
      }

      // ---------- Dashboard ----------
      if (path === '/api/dashboard' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const tid = payload.sub;

        const stats = await env.DB.prepare(`
          SELECT
            (SELECT COUNT(*) FROM quizzes WHERE teacher_id = ?) AS total_quizzes,
            (SELECT COUNT(*) FROM quizzes WHERE teacher_id = ? AND status = 'active') AS active_quizzes,
            (SELECT COUNT(*) FROM submissions s JOIN quizzes q ON s.quiz_id = q.id WHERE q.teacher_id = ?) AS total_submissions,
            (SELECT ROUND(AVG(percent), 1) FROM submissions s JOIN quizzes q ON s.quiz_id = q.id WHERE q.teacher_id = ?) AS avg_score
        `).bind(tid, tid, tid, tid).first();

        const quizzes = await env.DB.prepare(`
          SELECT q.*,
            (SELECT COUNT(*) FROM submissions WHERE quiz_id = q.id) AS participants
          FROM quizzes q
          WHERE q.teacher_id = ?
          ORDER BY q.updated_at DESC
          LIMIT 50
        `).bind(tid).all();

        return json({
          success: true,
          stats: {
            total_quizzes: stats?.total_quizzes || 0,
            active_quizzes: stats?.active_quizzes || 0,
            total_submissions: stats?.total_submissions || 0,
            avg_score: stats?.avg_score || 0,
          },
          quizzes: quizzes.results || [],
        }, 200, origin);
      }

      // ---------- Quizzes CRUD ----------
      if (path === '/api/quizzes' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const rows = await env.DB.prepare(`
          SELECT q.*,
            (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS question_count,
            (SELECT COUNT(*) FROM submissions WHERE quiz_id = q.id) AS participants
          FROM quizzes q WHERE q.teacher_id = ?
          ORDER BY q.updated_at DESC
        `).bind(payload.sub).all();
        return json({ success: true, quizzes: rows.results || [] }, 200, origin);
      }

      if (path === '/api/quizzes' && method === 'POST') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const b = await request.json();
        if (!b.title) return error('عنوان آزمون الزامی است.', 400, origin);
        const r = await env.DB.prepare(`
          INSERT INTO quizzes (
            teacher_id, title, description, duration_min, pass_score,
            shuffle_q, shuffle_opt, negative_mark, show_result, anti_copy, anti_tab,
            max_attempts, status, start_at, end_at, require_login, report_after_end, stacked_view
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          payload.sub,
          b.title,
          b.description || '',
          b.duration_min ?? 30,
          b.pass_score ?? 50,
          b.shuffle_q ? 1 : 0,
          b.shuffle_opt ? 1 : 0,
          b.negative_mark ?? 0,
          b.show_result !== false ? 1 : 0,
          b.anti_copy !== false ? 1 : 0,
          b.anti_tab !== false ? 1 : 0,
          b.max_attempts ?? 1,
          b.status || 'draft',
          b.start_at || null,
          b.end_at || null,
          b.require_login ? 1 : 0,
          b.report_after_end ? 1 : 0,
          b.stacked_view ? 1 : 0
        ).run();
        return json({ success: true, id: r.meta.last_row_id }, 201, origin);
      }

      const quizMatch = path.match(/^\/api\/quizzes\/(\d+)$/);
      if (quizMatch) {
        const qid = Number(quizMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);

        const quiz = await env.DB.prepare(
          'SELECT * FROM quizzes WHERE id = ? AND teacher_id = ?'
        ).bind(qid, payload.sub).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);

        if (method === 'GET') {
          const questions = await env.DB.prepare(
            'SELECT * FROM questions WHERE quiz_id = ? ORDER BY sort_order, id'
          ).bind(qid).all();
          return json({ success: true, quiz, questions: questions.results || [] }, 200, origin);
        }

        if (method === 'PUT') {
          const b = await request.json();
          const existing = quiz;
          const newAttachment = b.attachment !== undefined ? (b.attachment ? JSON.stringify(b.attachment) : null) : undefined;
          await env.DB.prepare(`
            UPDATE quizzes SET
              title = COALESCE(?, title),
              description = COALESCE(?, description),
              duration_min = COALESCE(?, duration_min),
              pass_score = COALESCE(?, pass_score),
              shuffle_q = COALESCE(?, shuffle_q),
              shuffle_opt = COALESCE(?, shuffle_opt),
              negative_mark = COALESCE(?, negative_mark),
              show_result = COALESCE(?, show_result),
              anti_copy = COALESCE(?, anti_copy),
              anti_tab = COALESCE(?, anti_tab),
              max_attempts = COALESCE(?, max_attempts),
              status = COALESCE(?, status),
              require_login = COALESCE(?, require_login),
              report_after_end = COALESCE(?, report_after_end),
              stacked_view = COALESCE(?, stacked_view),
              attachment_json = ?,
              start_at = ?,
              end_at = ?,
              updated_at = datetime('now')
            WHERE id = ? AND teacher_id = ?
          `).bind(
            b.title ?? null,
            b.description ?? null,
            b.duration_min ?? null,
            b.pass_score ?? null,
            b.shuffle_q !== undefined ? (b.shuffle_q ? 1 : 0) : null,
            b.shuffle_opt !== undefined ? (b.shuffle_opt ? 1 : 0) : null,
            b.negative_mark ?? null,
            b.show_result !== undefined ? (b.show_result ? 1 : 0) : null,
            b.anti_copy !== undefined ? (b.anti_copy ? 1 : 0) : null,
            b.anti_tab !== undefined ? (b.anti_tab ? 1 : 0) : null,
            b.max_attempts ?? null,
            b.status ?? null,
            b.require_login !== undefined ? (b.require_login ? 1 : 0) : null,
            b.report_after_end !== undefined ? (b.report_after_end ? 1 : 0) : null,
            b.stacked_view !== undefined ? (b.stacked_view ? 1 : 0) : null,
            newAttachment !== undefined ? newAttachment : (existing.attachment_json || null),
            b.start_at ?? null,
            b.end_at ?? null,
            qid, payload.sub
          ).run();
          return json({ success: true }, 200, origin);
        }

        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM quizzes WHERE id = ? AND teacher_id = ?')
            .bind(qid, payload.sub).run();
          return json({ success: true }, 200, origin);
        }
      }

      // Questions under quiz
      const qListMatch = path.match(/^\/api\/quizzes\/(\d+)\/questions$/);
      if (qListMatch) {
        const qid = Number(qListMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const quiz = await env.DB.prepare(
          'SELECT id FROM quizzes WHERE id = ? AND teacher_id = ?'
        ).bind(qid, payload.sub).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);

        if (method === 'GET') {
          const rows = await env.DB.prepare(
            'SELECT * FROM questions WHERE quiz_id = ? ORDER BY sort_order, id'
          ).bind(qid).all();
          return json({ success: true, questions: rows.results || [] }, 200, origin);
        }

        if (method === 'POST') {
          const b = await request.json();
          if (!b.content || b.correct_json === undefined || b.correct_json === null || b.correct_json === '') return error('متن سوال و پاسخ صحیح الزامی است.', 400, origin);
          const maxOrder = await env.DB.prepare(
            'SELECT COALESCE(MAX(sort_order), 0) AS m FROM questions WHERE quiz_id = ?'
          ).bind(qid).first();
          const r = await env.DB.prepare(`
            INSERT INTO questions (quiz_id, type, content, options_json, correct_json, score, explanation, image_url, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            qid,
            b.type || 'mcq',
            b.content,
            b.options_json ? (typeof b.options_json === 'string' ? b.options_json : JSON.stringify(b.options_json)) : null,
            typeof b.correct_json === 'string' ? b.correct_json : JSON.stringify(b.correct_json),
            b.score ?? 1,
            b.explanation || '',
            b.image_url || null,
            (maxOrder?.m || 0) + 1
          ).run();
          await env.DB.prepare('UPDATE quizzes SET updated_at = datetime(\'now\') WHERE id = ?').bind(qid).run();
          return json({ success: true, id: r.meta.last_row_id }, 201, origin);
        }
      }

      const questionMatch = path.match(/^\/api\/questions\/(\d+)$/);
      if (questionMatch) {
        const qid = Number(questionMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);

        const q = await env.DB.prepare(`
          SELECT qu.* FROM questions qu
          JOIN quizzes qz ON qu.quiz_id = qz.id
          WHERE qu.id = ? AND qz.teacher_id = ?
        `).bind(qid, payload.sub).first();
        if (!q) return error('سوال یافت نشد.', 404, origin);

        if (method === 'PUT') {
          const b = await request.json();
          await env.DB.prepare(`
            UPDATE questions SET
              type = COALESCE(?, type),
              content = COALESCE(?, content),
              options_json = COALESCE(?, options_json),
              correct_json = COALESCE(?, correct_json),
              score = COALESCE(?, score),
              explanation = COALESCE(?, explanation),
              image_url = COALESCE(?, image_url),
              sort_order = COALESCE(?, sort_order)
            WHERE id = ?
          `).bind(
            b.type ?? null,
            b.content ?? null,
            b.options_json !== undefined ? (typeof b.options_json === 'string' ? b.options_json : JSON.stringify(b.options_json)) : null,
            b.correct_json !== undefined ? (typeof b.correct_json === 'string' ? b.correct_json : JSON.stringify(b.correct_json)) : null,
            b.score ?? null,
            b.explanation ?? null,
            b.image_url ?? null,
            b.sort_order ?? null,
            qid
          ).run();
          return json({ success: true }, 200, origin);
        }

        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(qid).run();
          return json({ success: true }, 200, origin);
        }
      }

      // Submissions list for teacher
      const subListMatch = path.match(/^\/api\/quizzes\/(\d+)\/submissions$/);
      if (subListMatch && method === 'GET') {
        const qid = Number(subListMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const quiz = await env.DB.prepare(
          'SELECT id FROM quizzes WHERE id = ? AND teacher_id = ?'
        ).bind(qid, payload.sub).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);
        const rows = await env.DB.prepare(`
          SELECT id, student_name, student_family, school, class_name,
                 score, max_score, percent, passed, duration_sec, tab_switches, finished_at
          FROM submissions WHERE quiz_id = ?
          ORDER BY finished_at DESC
        `).bind(qid).all();
        return json({ success: true, submissions: rows.results || [] }, 200, origin);
      }

      // ---------- Public endpoints ----------
      const publicQuizMatch = path.match(/^\/api\/public\/quiz\/(\d+)$/);
      if (publicQuizMatch && method === 'GET') {
        const qid = Number(publicQuizMatch[1]);
        const quiz = await env.DB.prepare(
          'SELECT id, teacher_id, title, description, duration_min, pass_score, shuffle_q, shuffle_opt, negative_mark, show_result, anti_copy, anti_tab, max_attempts, status, start_at, end_at, require_login, report_after_end, stacked_view, attachment_json FROM quizzes WHERE id = ?'
        ).bind(qid).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);
        if (quiz.status !== 'active') return error('این آزمون در حال حاضر فعال نیست.', 403, origin);

        const now = new Date().toISOString();
        if (quiz.start_at && now < quiz.start_at) return error('آزمون هنوز شروع نشده است.', 403, origin);
        const quizEnded = !!(quiz.end_at && now > quiz.end_at);
        if (quizEnded && !quiz.require_login) {
          // Quiz over for guests: entry page becomes "report lookup only"
          return json({
            success: true,
            ended: true,
            quiz: {
              id: quiz.id, title: quiz.title, description: quiz.description,
              duration_min: quiz.duration_min, pass_score: quiz.pass_score,
              require_login: false, report_after_end: !!quiz.report_after_end,
              question_count: 0, start_at: quiz.start_at, end_at: quiz.end_at,
            },
            questions: [],
            student: null,
          }, 200, origin);
        }
        // Student login enforcement
        let studentInfo = null;
        if (quiz.require_login) {
          const sp = await getStudentAuth(request, env);
          if (!sp || sp.tid !== quiz.teacher_id) {
            return json({ success: false, require_login: true, message: 'ورود با حساب دانش‌آموزی الزامی است.' }, 200, origin);
          }
          // Quiz ended: student logs in to view their report (deferred mode)
          const nowIso = new Date().toISOString();
          if (quiz.end_at && nowIso > quiz.end_at) {
            const sub = await env.DB.prepare(
              'SELECT id, score, max_score, percent, passed, finished_at FROM submissions WHERE quiz_id = ? AND student_user_id = ? ORDER BY finished_at DESC LIMIT 1'
            ).bind(qid, sp.sid).first();
            return json({
              success: true,
              ended: true,
              student_report: sub || null,
              quiz: { id: quiz.id, title: quiz.title, require_login: true, report_after_end: !!quiz.report_after_end },
              questions: [],
            }, 200, origin);
          }
          const taken = await env.DB.prepare(
            'SELECT id FROM submissions WHERE quiz_id = ? AND student_user_id = ?'
          ).bind(qid, sp.sid).first();
          if (taken) {
            return error('شما قبلاً در این آزمون شرکت کرده‌اید و اجازه ورود مجدد ندارید.', 403, origin);
          }
          const st = await env.DB.prepare('SELECT id, username, full_name, class_name FROM students WHERE id = ?')
            .bind(sp.sid).first();
          studentInfo = st;
        }

        let questions = (await env.DB.prepare(
          'SELECT id, type, content, options_json, score, image_url, sort_order FROM questions WHERE quiz_id = ? ORDER BY sort_order, id'
        ).bind(qid).all()).results || [];

        questions = questions.map(q => {
          let options = null;
          if (q.options_json) {
            try { options = JSON.parse(q.options_json); } catch { options = []; }
          }
          return {
            id: q.id,
            type: q.type,
            content: q.content,
            options,
            score: q.score,
            image_url: q.image_url,
          };
        }).filter(q => q.type !== 'essay' || q.content);

        if (quiz.shuffle_q) {
          for (let i = questions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [questions[i], questions[j]] = [questions[j], questions[i]];
          }
        }
        // Note: option shuffling is done on the frontend to keep correct_json indices aligned

        let quizAttachment = null;
        try { quizAttachment = quiz.attachment_json ? JSON.parse(quiz.attachment_json) : null; } catch {}
        return json({
          success: true,
          quiz: {
            id: quiz.id,
            title: quiz.title,
            description: quiz.description,
            duration_min: quiz.duration_min,
            pass_score: quiz.pass_score,
            anti_copy: !!quiz.anti_copy,
            anti_tab: !!quiz.anti_tab,
            show_result: !!quiz.show_result,
            require_login: !!quiz.require_login,
            report_after_end: !!quiz.report_after_end,
            stacked_view: !!quiz.stacked_view,
            question_count: questions.length,
            start_at: quiz.start_at,
            end_at: quiz.end_at,
            attachment: quizAttachment,
          },
          student: studentInfo,
          questions,
        }, 200, origin);
      }

      const submitMatch = path.match(/^\/api\/public\/quiz\/(\d+)\/submit$/);
      if (submitMatch && method === 'POST') {
        const qid = Number(submitMatch[1]);
        const quiz = await env.DB.prepare(
          'SELECT * FROM quizzes WHERE id = ?'
        ).bind(qid).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);
        if (quiz.status !== 'active') return error('آزمون فعال نیست.', 403, origin);

        // Enforce one attempt for logged-in students
        let studentUserId = null;
        if (quiz.require_login) {
          const sp = await getStudentAuth(request, env);
          if (!sp || sp.tid !== quiz.teacher_id) return error('ورود با حساب دانش‌آموزی الزامی است.', 401, origin);
          const dup = await env.DB.prepare(
            'SELECT id FROM submissions WHERE quiz_id = ? AND student_user_id = ?'
          ).bind(qid, sp.sid).first();
          if (dup) return error('شما قبلاً در این آزمون شرکت کرده‌اید.', 403, origin);
          studentUserId = sp.sid;
        }

        const body = await request.json();
        const { student_name, student_family, school, class_name, student_phone, answers, duration_sec, tab_switches } = body;
        if (!student_name) return error('نام دانش‌آموز الزامی است.', 400, origin);
        if (!answers || typeof answers !== 'object') return error('پاسخ‌ها نامعتبر است.', 400, origin);

        // Enforce quiz window on submit too (page could have been left open)
        // Grace: students who entered before end_at may finish and submit.
        const nowSub = new Date().toISOString();
        if (quiz.end_at && nowSub > quiz.end_at) {
          const startedIso = body.started_at || '';
          if (!startedIso || startedIso >= quiz.end_at) {
            return error('مهلت شرکت در آزمون به پایان رسیده است.', 403, origin);
          }
        }

        // Anti-duplicate: each phone (guest) or student account can submit once.
        const normSubPhone = (!quiz.require_login || !studentUserId) ? normPhone(student_phone) : '';
        if (!quiz.require_login) {
          if (!normSubPhone) return error('شماره موبایل الزامی است (شناسه کارنامه و جلوگیری از ارسال تکراری).', 400, origin);
          const dupPhone = await env.DB.prepare(
            'SELECT id FROM submissions WHERE quiz_id = ? AND student_phone = ?'
          ).bind(qid, normSubPhone).first();
          if (dupPhone) return error('این شماره قبلاً در این آزمون شرکت کرده است (هر شماره فقط یک‌بار).', 409, origin);
        }

        // For logged-in students, identity comes from the account (not user-supplied fields)
        let finalName = student_name, finalFamily = student_family || '', finalSchool = school || '', finalClass = class_name || '';
        if (studentUserId) {
          const srow = await env.DB.prepare('SELECT full_name, class_name FROM students WHERE id = ?').bind(studentUserId).first();
          if (srow) {
            const parts = String(srow.full_name || '').trim().split(/\s+/);
            finalName = parts[0] || student_name;
            finalFamily = parts.slice(1).join(' ') || '';
            finalClass = srow.class_name || '';
            finalSchool = school === '—' ? '' : (school || '');
          }
        }

        const questions = (await env.DB.prepare(
          'SELECT id, type, correct_json, score FROM questions WHERE quiz_id = ?'
        ).bind(qid).all()).results || [];

        const { score, maxScore, percent } = scoreSubmission(questions, answers, Number(quiz.negative_mark) || 0);
        const passed = percent >= (quiz.pass_score || 50) ? 1 : 0;
        const hasEssay = questions.some(q => q.type === 'essay');

        const r = await env.DB.prepare(`
          INSERT INTO submissions (
            quiz_id, student_name, student_family, school, class_name,
            answers_json, score, max_score, percent, passed,
            duration_sec, tab_switches, ip_address, user_agent, started_at, student_user_id, student_phone, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `        ).bind(
          qid,
          finalName,
          finalFamily,
          finalSchool,
          finalClass,
          JSON.stringify(answers),
          score,
          maxScore,
          percent,
          passed,
          duration_sec || 0,
          tab_switches || 0,
          request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '',
          (request.headers.get('User-Agent') || '').slice(0, 300),
          body.started_at || null,
          studentUserId,
          (quiz.require_login && studentUserId) ? '' : normSubPhone
        ).run();

        const result = {
          success: true,
          submission_id: r.meta.last_row_id,
          score,
          max_score: maxScore,
          percent,
          passed: !!passed,
          show_result: !!quiz.show_result,
          report_after_end: !!quiz.report_after_end,
          report_access_phone: (quiz.require_login && studentUserId) ? null : normPhone(student_phone),
          essay_pending: hasEssay,
        };
        return json(result, 201, origin);
      }

      const resultMatch = path.match(/^\/api\/public\/result\/(\d+)$/);
      if (resultMatch && method === 'GET') {
        const sid = Number(resultMatch[1]);
        const sub = await env.DB.prepare(`
          SELECT s.*, q.title AS quiz_title, q.pass_score, q.show_result, q.end_at, q.report_after_end, q.require_login
          FROM submissions s
          JOIN quizzes q ON s.quiz_id = q.id
          WHERE s.id = ?
        `).bind(sid).first();
        if (!sub) return error('نتیجه یافت نشد.', 404, origin);
        // Deferred report: hide scores until quiz end_at has passed
        if (sub.report_after_end && sub.end_at) {
          const now = new Date().toISOString();
          if (now < sub.end_at) {
            return json({
              success: true,
              result: {
                id: sub.id,
                quiz_title: sub.quiz_title,
                student_name: sub.student_name,
                student_family: sub.student_family,
                message: 'کارنامه شما پس از پایان مهلت آزمون منتشر می‌شود.',
                deferred: true,
                end_at: sub.end_at,
              },
            }, 200, origin);
          }
        }
        if (!sub.show_result) {
          return json({
            success: true,
            result: {
              id: sub.id,
              quiz_title: sub.quiz_title,
              student_name: sub.student_name,
              student_family: sub.student_family,
              message: 'نمایش کارنامه توسط معلم غیرفعال شده است.',
            },
          }, 200, origin);
        }
        return json({
          success: true,
          result: {
            id: sub.id,
            quiz_title: sub.quiz_title,
            student_name: sub.student_name,
            student_family: sub.student_family,
            school: sub.school,
            class_name: sub.class_name,
            score: sub.score,
            max_score: sub.max_score,
            percent: sub.percent,
            passed: !!sub.passed,
            pass_score: sub.pass_score,
            duration_sec: sub.duration_sec,
            finished_at: sub.finished_at,
          },
        }, 200, origin);
      }

      // ---------- Find report by phone (public) ----------
      const repFindMatch = path.match(/^\/api\/public\/quiz\/(\d+)\/report$/);
      if (repFindMatch && method === 'GET') {
        const qid = Number(repFindMatch[1]);
        const url2 = new URL(request.url);
        const phone = String(url2.searchParams.get('phone') || '').trim();
        if (!phone) return error('شماره را وارد کنید.', 400, origin);
        const quiz = await env.DB.prepare('SELECT id, end_at, report_after_end FROM quizzes WHERE id = ?').bind(qid).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);
        // Students with accounts: report visible only after end date when deferred mode is on
        if (quiz.report_after_end && quiz.end_at) {
          const now = new Date().toISOString();
          if (now < quiz.end_at) return error('کارنامه‌ها پس از پایان مهلت آزمون منتشر می‌شوند.', 403, origin);
        }
        const norm = normPhone(phone);
        const rows = (await env.DB.prepare(`
          SELECT id, student_name, student_family, school, class_name, score, max_score, percent, passed, duration_sec, tab_switches, finished_at
          FROM submissions WHERE quiz_id = ? AND student_phone = ?
          ORDER BY finished_at DESC LIMIT 1
        `).bind(qid, norm).all()).results || [];
        if (!rows.length) return error('کارنامه‌ای با این شماره پیدا نشد.', 404, origin);
        return json({ success: true, submission_id: rows[0].id, result: rows[0] }, 200, origin);
      }

      // Bank questions with filtering
      if (path === '/api/bank' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const url2 = new URL(request.url);
        const subject = url2.searchParams.get('subject') || '';
        const grade = url2.searchParams.get('grade') || '';
        const chapter = url2.searchParams.get('chapter') || '';
        const difficulty = url2.searchParams.get('difficulty') || '';
        const search = url2.searchParams.get('q') || '';
        let query = 'SELECT * FROM bank_questions WHERE teacher_id = ?';
        const params = [payload.sub];
        if (subject) { query += ' AND subject = ?'; params.push(subject); }
        if (grade) { query += ' AND grade = ?'; params.push(grade); }
        if (chapter) { query += ' AND chapter = ?'; params.push(chapter); }
        if (difficulty) { query += ' AND difficulty = ?'; params.push(difficulty); }
        if (search) { query += ' AND content LIKE ?'; params.push('%' + search + '%'); }
        query += ' ORDER BY created_at DESC LIMIT 200';
        const rows = (await env.DB.prepare(query).bind(...params).all()).results || [];
        return json({ success: true, questions: rows }, 200, origin);
      }

      if (path === '/api/bank' && method === 'POST') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const b = await request.json();
        if (!b.content || b.correct_json === undefined || b.correct_json === null || b.correct_json === '') return error('متن و پاسخ صحیح الزامی است.', 400, origin);
        const r = await env.DB.prepare(`
          INSERT INTO bank_questions (teacher_id, type, content, options_json, correct_json, score, explanation, subject, grade, difficulty, tags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          payload.sub,
          b.type || 'mcq',
          b.content,
          b.options_json ? (typeof b.options_json === 'string' ? b.options_json : JSON.stringify(b.options_json)) : null,
          typeof b.correct_json === 'string' ? b.correct_json : JSON.stringify(b.correct_json),
          b.score ?? 1,
          b.explanation || '',
          b.subject || '',
          b.grade || '',
          b.difficulty || 'medium',
          b.tags || ''
        ).run();
        return json({ success: true, id: r.meta.last_row_id }, 201, origin);
      }

      // Bank statistics
      if (path === '/api/bank/stats' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const stats = await env.DB.prepare(`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN grade = 'هفتم' THEN 1 ELSE 0 END) as grade7,
            SUM(CASE WHEN grade = 'هشتم' THEN 1 ELSE 0 END) as grade8,
            SUM(CASE WHEN grade = 'نهم' THEN 1 ELSE 0 END) as grade9,
            SUM(CASE WHEN difficulty = 'easy' THEN 1 ELSE 0 END) as easy,
            SUM(CASE WHEN difficulty = 'medium' THEN 1 ELSE 0 END) as medium,
            SUM(CASE WHEN difficulty = 'hard' THEN 1 ELSE 0 END) as hard,
            SUM(CASE WHEN difficulty = 'olympiad' THEN 1 ELSE 0 END) as olympiad
          FROM bank_questions WHERE teacher_id = ?
        `).bind(payload.sub).first();
        const subjects = (await env.DB.prepare(`
          SELECT subject, COUNT(*) as count 
          FROM bank_questions WHERE teacher_id = ? AND subject != '' 
          GROUP BY subject ORDER BY count DESC
        `).bind(payload.sub).all()).results || [];
        return json({ success: true, stats: stats || { total: 0 }, subjects }, 200, origin);
      }

      // ---------- Submission detail (teacher) ----------
      const subDetailMatch = path.match(/^\/api\/submissions\/(\d+)$/);
      if (subDetailMatch) {
        const sid = Number(subDetailMatch[1]);
        if (method === 'GET') {
          const payload = await getAuth(request, env);
          if (!payload) return error('Unauthorized', 401, origin);
          const sub = await env.DB.prepare(`
            SELECT s.*, q.title AS quiz_title, q.pass_score
            FROM submissions s JOIN quizzes q ON s.quiz_id = q.id
            WHERE s.id = ?
          `).bind(sid).first();
          if (!sub) return error('نتیجه یافت نشد.', 404, origin);
          const quiz = await env.DB.prepare(
            'SELECT id FROM quizzes WHERE id = ? AND teacher_id = ?'
          ).bind(sub.quiz_id, payload.sub).first();
          if (!quiz) return error('Unauthorized', 401, origin);
          const questions = (await env.DB.prepare(
            'SELECT id, type, content, options_json, correct_json, score, explanation FROM questions WHERE quiz_id = ? ORDER BY sort_order, id'
          ).bind(sub.quiz_id).all()).results || [];
          return json({ success: true, submission: sub, questions }, 200, origin);
        }
        if (method === 'POST') {
          const payload = await getAuth(request, env);
          if (!payload) return error('Unauthorized', 401, origin);
          const sub = await env.DB.prepare(
            'SELECT s.* FROM submissions s JOIN quizzes q ON s.quiz_id = q.id WHERE s.id = ? AND q.teacher_id = ?'
          ).bind(sid, payload.sub).first();
          if (!sub) return error('نتیجه یافت نشد.', 404, origin);
          const b = await request.json();
          if (b.grades) {
            const essayGrades = JSON.parse(sub.essay_grades_json || '{}');
            Object.assign(essayGrades, b.grades);
            await env.DB.prepare('UPDATE submissions SET essay_grades_json = ? WHERE id = ?')
              .bind(JSON.stringify(essayGrades), sid).run();
            const questions = (await env.DB.prepare(
              'SELECT id, type, score FROM questions WHERE quiz_id = ?'
            ).bind(sub.quiz_id).all()).results || [];
            let answers = {};
            try { answers = JSON.parse(sub.answers_json || '{}'); } catch {}
            let totalScore = 0;
            let maxScore = 0;
            for (const q of questions) {
              maxScore += Number(q.score) || 1;
              if (q.type === 'essay') {
                const g = essayGrades[String(q.id)];
                if (g && g.accepted) totalScore += Number(q.score) || 1;
              } else {
                const ans = answers[String(q.id)];
                if (ans === undefined || ans === null || ans === '') continue;
                try {
                  const correctData = JSON.parse(q.correct_json || 'null');
                  if (q.type === 'mcq') { if (Number(ans) === Number(correctData)) totalScore += Number(q.score) || 1; }
                  else if (q.type === 'multi') {
                    const a = Array.isArray(ans) ? ans.map(Number).sort() : [Number(ans)];
                    const c = (Array.isArray(correctData) ? correctData : [correctData]).map(Number).sort();
                    if (a.length === c.length && a.every((v, i) => v === c[i])) totalScore += Number(q.score) || 1;
                  } else if (q.type === 'tf') { if (String(ans).toLowerCase() === String(correctData).toLowerCase()) totalScore += Number(q.score) || 1; }
                  else if (q.type === 'short') {
                    const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
                    const accepted = Array.isArray(correctData) ? correctData : [correctData];
                    if (accepted.some(c => norm(c) === norm(ans))) totalScore += Number(q.score) || 1;
                  }
                } catch {}
              }
            }
            const percent = maxScore > 0 ? Math.round((totalScore / maxScore) * 10000) / 100 : 0;
            const quiz = await env.DB.prepare('SELECT pass_score FROM quizzes WHERE id = ?').bind(sub.quiz_id).first();
            const passed = percent >= (quiz?.pass_score || 50) ? 1 : 0;
            await env.DB.prepare(
              'UPDATE submissions SET score = ?, max_score = ?, percent = ?, passed = ? WHERE id = ?'
            ).bind(totalScore, maxScore, percent, passed, sid).run();
            return json({ success: true, score: totalScore, max_score: maxScore, percent, passed: !!passed, essay_grades: essayGrades }, 200, origin);
          }
          return error('داده نامعتبر.', 400, origin);
        }
      }

      // Grade/reply homework submission (teacher)
      const hwGradeMatch = path.match(/^\/api\/homework-submissions\/(\d+)\/review$/);
      if (hwGradeMatch && method === 'POST') {
        const sid = Number(hwGradeMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const sub = await env.DB.prepare(`
          SELECT hs.* FROM homework_submissions hs JOIN homework h ON hs.homework_id = h.id
          WHERE hs.id = ? AND h.teacher_id = ?
        `).bind(sid, payload.sub).first();
        if (!sub) return error('یافت نشد.', 404, origin);
        const b = await request.json();
        const status = ['approved', 'needs_revision', 'pending'].includes(b.status) ? b.status : 'pending';
        await env.DB.prepare(`UPDATE homework_submissions SET
            status = ?, score = ?, reply = ?, replied_at = datetime('now'),
            graded_at = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE graded_at END
          WHERE id = ?`).bind(
          status, b.score ?? null, b.reply || '', (b.score !== undefined && b.score !== null) ? 1 : null, sid
        ).run();
        return json({ success: true }, 200, origin);
      }

      // ---------- AI: Chat (public) ----------
      if (path === '/api/ai/chat' && method === 'POST') {
        const b = await request.json();
        const { message } = b;
        if (!message || message.trim().length < 2) return error('پیام وارد کنید.', 400, origin);
        const systemPrompt = `تو دستیار هوش مصنوعی Quiz26 هستی، یک سامانه آزمون آنلاین. به سوالات کاربران به فارسی پاسخ بده. میتوانی درباره نحوه استفاده از سایت، ساخت آزمون، و هر سوال عمومی دیگر کمک کنی. پاسخ‌هات کوتاه و مفید باشد.`;
        try {
          const aiResponse = await callAI(env, systemPrompt, message, 1000);
          return json({ success: true, reply: aiResponse }, 200, origin);
        } catch (err) {
          return error(err.message, 500, origin);
        }
      }

      // ---------- AI: Auto-grade Essay ----------
      if (path.match(/^\/api\/ai\/auto-grade\/(\d+)$/) && method === 'POST') {
        const sid = Number(path.match(/^\/api\/ai\/auto-grade\/(\d+)$/)[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const sub = await env.DB.prepare(`
          SELECT s.* FROM submissions s JOIN quizzes q ON s.quiz_id = q.id
          WHERE s.id = ? AND q.teacher_id = ?
        `).bind(sid, payload.sub).first();
        if (!sub) return error('نتیجه یافت نشد.', 404, origin);
        const questions = (await env.DB.prepare(
          'SELECT id, type, content, correct_json, score FROM questions WHERE quiz_id = ?'
        ).bind(sub.quiz_id).all()).results || [];
        let answers = {};
        try { answers = JSON.parse(sub.answers_json || '{}'); } catch {}
        let essayGrades = {};
        try { essayGrades = JSON.parse(sub.essay_grades_json || '{}'); } catch {}
        const essayQuestions = questions.filter(q => q.type === 'essay');
        if (!essayQuestions.length) return error('سوال تشریحی وجود ندارد.', 400, origin);
        let graded = 0;
        for (const q of essayQuestions) {
          const ans = answers[String(q.id)];
          if (!ans) continue;
          const studentAnswer = (typeof ans === 'object' && ans !== null) ? (ans.text || JSON.stringify(ans)) : String(ans);
          const answerKey = (Array.isArray(JSON.parse(q.correct_json || '[]')) ? JSON.parse(q.correct_json || '[]') : [q.correct_json]).join(', ');
          const systemPrompt = `تو یک مصحح حرفه‌ای هستی. پاسخ دانش‌آموز را ارزیابی کن.
فرمت خروجی فقط JSON: {"score": number, "feedback": "توضیح کوتاه فارسی"}
نمره بین 0 تا ${q.score || 1} باشد.`;
          const userPrompt = `سوال: ${q.content}\nکلید پاسخ: ${answerKey}\nپاسخ دانش‌آموز: ${studentAnswer}\nنمره maximum: ${q.score || 1}`;
          try {
            const aiResponse = await callAI(env, systemPrompt, userPrompt, 500);
            let result;
            try { const m = aiResponse.match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : { score: 0, feedback: aiResponse }; }
            catch { result = { score: 0, feedback: aiResponse }; }
            result.score = Math.max(0, Math.min(Number(q.score) || 1, Number(result.score) || 0));
            essayGrades[String(q.id)] = { accepted: result.score >= ((Number(q.score) || 1) * 0.5), score: result.score, feedback: result.feedback, ai_graded: true };
            graded++;
          } catch {}
        }
        await env.DB.prepare('UPDATE submissions SET essay_grades_json = ? WHERE id = ?')
          .bind(JSON.stringify(essayGrades), sid).run();
        // Recalculate total score
        let totalScore = 0, maxScore = 0;
        for (const q of questions) {
          maxScore += Number(q.score) || 1;
          if (q.type === 'essay') {
            const g = essayGrades[String(q.id)];
            if (g) totalScore += Number(g.score) || 0;
          } else {
            const ans = answers[String(q.id)];
            if (ans === undefined || ans === null || ans === '') continue;
            try {
              const cd = JSON.parse(q.correct_json);
              if (q.type === 'mcq' && Number(ans) === Number(cd)) totalScore += Number(q.score) || 1;
              else if (q.type === 'tf' && String(ans).toLowerCase() === String(cd).toLowerCase()) totalScore += Number(q.score) || 1;
              else if (q.type === 'short') {
                const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
                const acc = Array.isArray(cd) ? cd : [cd];
                if (acc.some(c => norm(c) === norm(ans))) totalScore += Number(q.score) || 1;
              } else if (q.type === 'multi') {
                const a = Array.isArray(ans) ? ans.map(Number).sort() : [Number(ans)];
                const c = (Array.isArray(cd) ? cd : [cd]).map(Number).sort();
                if (a.length === c.length && a.every((v, i) => v === c[i])) totalScore += Number(q.score) || 1;
              }
            } catch {}
          }
        }
        const percent = maxScore > 0 ? Math.round((totalScore / maxScore) * 10000) / 100 : 0;
        const quiz = await env.DB.prepare('SELECT pass_score FROM quizzes WHERE id = ?').bind(sub.quiz_id).first();
        const passed = percent >= (quiz?.pass_score || 50) ? 1 : 0;
        await env.DB.prepare('UPDATE submissions SET score = ?, max_score = ?, percent = ?, passed = ? WHERE id = ?')
          .bind(totalScore, maxScore, percent, passed, sid).run();
        return json({ success: true, graded, score: totalScore, max_score: maxScore, percent, passed: !!passed, essay_grades: essayGrades }, 200, origin);
      }

      // ---------- AI: Grade Essay ----------
      if (path === '/api/ai/grade-essay' && method === 'POST') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const b = await request.json();
        const { question_content, student_answer, answer_key, max_score } = b;
        if (!question_content || !student_answer) return error('متن سوال و پاسخ دانش‌آموز الزامی است.', 400, origin);
        const systemPrompt = `تو یک مصحح حرفه‌ای و بی‌طرف هستی. پاسخ دانش‌آموز را بر اساس کلید پاسخ ارزیابی کن.
قوانین:
- فقط عدد نمره (بین 0 تا ${max_score || 1}) و یک توضیح کوتاه فارسی برگردان.
- فرمت خروجی: {"score": number, "feedback": "توضیح فارسی"}
- نمره را منصفانه و بر اساس محتوا بده، نه طول متن.`;
        const userPrompt = `سوال: ${question_content}\n\nکلید پاسخ: ${answer_key || 'ندارد'}\n\nپاسخ دانش‌آموز: ${student_answer}\n\nنمره maximum: ${max_score || 1}`;
        try {
          const aiResponse = await callAI(env, systemPrompt, userPrompt, 500);
          let result;
          try {
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            result = jsonMatch ? JSON.parse(jsonMatch[0]) : { score: 0, feedback: aiResponse };
          } catch { result = { score: 0, feedback: aiResponse }; }
          result.score = Math.max(0, Math.min(Number(max_score) || 1, Number(result.score) || 0));
          return json({ success: true, grade: result }, 200, origin);
        } catch (err) {
          return error(err.message, 500, origin);
        }
      }

      // ---------- AI: Generate Questions ----------
      if (path === '/api/ai/generate-questions' && method === 'POST') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const b = await request.json();
        const { topic, count, type, difficulty, grade_level } = b;
        if (!topic) return error('موضوع سوال الزامی است.', 400, origin);
        const typeMap = { mcq: 'چندگزینه‌ای تک‌جواب', multi: 'چندگزینه‌ای چندجواب', tf: 'درست/نادرست', short: 'پاسخ کوتاه' };
        const diffMap = { easy: 'آسان', medium: 'متوسط', hard: 'سخت', olympiad: 'المپیادی' };
        const systemPrompt = `تو یک طراح سوال حرفه‌ای آزمون هستی. سوالات با کیفیت و استاندارد طراحی کن.
قوانین:
- خروجی باید JSON باشد: [{"content":"متن سوال","type":"mcq","options":["گزینه۱","گزینه۲","گزینه۳","گزینه۴"],"correct":0,"explanation":"توضیح"}]
- برای tf: correct باید "true" یا "false" باشد
- برای short: correct باید یک آرایه از پاسخ‌های قابل قبول باشد
- محتوا دقیق، بدون ابهام و آموزشی باشد`;
        const userPrompt = `${count || 5} سوال ${typeMap[type] || 'چندگزینه‌ای تک‌جواب'} از موضوع "${topic}" با سطح دشواری ${diffMap[difficulty] || 'متوسط'} ${grade_level ? `برای پایه ${grade_level}` : ''} بساز. خروجی فقط JSON آرایه باشد.`;
        try {
          const aiResponse = await callAI(env, systemPrompt, userPrompt, 3000);
          let questions;
          try {
            const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
            questions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
          } catch { questions = []; }
          questions = questions.slice(0, Math.min(count || 5, 20));
          return json({ success: true, questions }, 200, origin);
        } catch (err) {
          return error(err.message, 500, origin);
        }
      }

      // ---------- AI: Analyze Quiz ----------
      const aiAnalyzeMatch = path.match(/^\/api\/ai\/analyze-quiz\/(\d+)$/);
      if (aiAnalyzeMatch && method === 'GET') {
        const qid = Number(aiAnalyzeMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const quiz = await env.DB.prepare(
          'SELECT id, title FROM quizzes WHERE id = ? AND teacher_id = ?'
        ).bind(qid, payload.sub).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);
        const submissions = (await env.DB.prepare(
          'SELECT score, max_score, percent, answers_json, duration_sec, tab_switches FROM submissions WHERE quiz_id = ?'
        ).bind(qid).all()).results || [];
        if (!submissions.length) return error('هنوز نتیجه‌ای ثبت نشده.', 404, origin);
        const questions = (await env.DB.prepare(
          'SELECT id, type, content, score, correct_json FROM questions WHERE quiz_id = ? ORDER BY sort_order, id'
        ).bind(qid).all()).results || [];
        const avg = submissions.reduce((s, x) => s + (x.percent || 0), 0) / submissions.length;
        const qStats = questions.map(q => {
          let correctCount = 0;
          for (const sub of submissions) {
            let answers = {};
            try { answers = JSON.parse(sub.answers_json || '{}'); } catch {}
            const ans = answers[String(q.id)];
            if (ans === undefined || ans === null || ans === '') continue;
            try {
              const cd = JSON.parse(q.correct_json);
              if (q.type === 'mcq') { if (Number(ans) === Number(cd)) correctCount++; }
              else if (q.type === 'tf') { if (String(ans).toLowerCase() === String(cd).toLowerCase()) correctCount++; }
              else if (q.type === 'short') {
                const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
                const acc = Array.isArray(cd) ? cd : [cd];
                if (acc.some(c => norm(c) === norm(ans))) correctCount++;
              }
            } catch {}
          }
          const rate = submissions.length > 0 ? Math.round((correctCount / submissions.length) * 100) : 0;
          return { id: q.id, content: q.content.slice(0, 100), type: q.type, score: q.score, correctRate: rate };
        });
        const sorted = [...qStats].sort((a, b) => a.correctRate - b.correctRate);
        const hardest = sorted.slice(0, 3);
        const easiest = sorted.slice(-3).reverse();
        const avgDuration = submissions.reduce((s, x) => s + (x.duration_sec || 0), 0) / submissions.length;
        const avgTabSwitches = submissions.reduce((s, x) => s + (x.tab_switches || 0), 0) / submissions.length;
        const systemPrompt = `تو یک تحلیلگر آزمون هستی. نتایج زیر را تحلیل کن و به فارسی گزارش بده.
فرمت خروجی: {"summary":"خلاصه کلی","hardIssues":"مشکلات سوالات سخت","easyIssues":"سوالات آسان","recommendations":"پیشنهادات","riskStudents":"دانش‌آموزان در خطر"}`;
        const userPrompt = `آزمون: ${quiz.title}
تعداد شرکت‌کننده: ${submissions.length}
میانگین نمره: ${avg.toFixed(1)}%
سوالات سخت (بیشترین غلط): ${hardest.map(q => `"${q.content}" (${q.correctRate}% درست)`).join(', ')}
سوالات آسان: ${easiest.map(q => `"${q.content}" (${q.correctRate}% درست)`).join(', ')}
میانگین زمان: ${Math.round(avgDuration)} ثانیه
میانگین ترک تب: ${avgTabSwitches.toFixed(1)}`;
        try {
          const aiResponse = await callAI(env, systemPrompt, userPrompt, 1500);
          let analysis;
          try {
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: aiResponse };
          } catch { analysis = { summary: aiResponse }; }
          return json({ success: true, analysis, stats: { avg: avg.toFixed(1), count: submissions.length, hardest, easiest, avgDuration: Math.round(avgDuration) } }, 200, origin);
        } catch (err) {
          return json({ success: true, analysis: { summary: 'تحلیل AI در دسترس نیست.' }, stats: { avg: avg.toFixed(1), count: submissions.length, hardest, easiest, avgDuration: Math.round(avgDuration) } }, 200, origin);
        }
      }

      // ---------- AI: Suggest Improvements ----------
      const aiSuggestMatch = path.match(/^\/api\/ai\/suggest-improvements\/(\d+)$/);
      if (aiSuggestMatch && method === 'GET') {
        const qid = Number(aiSuggestMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const quiz = await env.DB.prepare(
          'SELECT id, title FROM quizzes WHERE id = ? AND teacher_id = ?'
        ).bind(qid, payload.sub).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);
        const questions = (await env.DB.prepare(
          'SELECT id, type, content, options_json, correct_json, score, explanation FROM questions WHERE quiz_id = ? ORDER BY sort_order, id'
        ).bind(qid).all()).results || [];
        const submissions = (await env.DB.prepare(
          'SELECT answers_json FROM submissions WHERE quiz_id = ?'
        ).bind(qid).all()).results || [];
        if (!submissions.length) return error('هنوز نتیجه‌ای ثبت نشده.', 404, origin);
        const qAnalysis = questions.map(q => {
          let correctCount = 0;
          let attemptCount = 0;
          for (const sub of submissions) {
            let answers = {};
            try { answers = JSON.parse(sub.answers_json || '{}'); } catch {}
            const ans = answers[String(q.id)];
            if (ans === undefined || ans === null || ans === '') continue;
            attemptCount++;
            try {
              const cd = JSON.parse(q.correct_json);
              if (q.type === 'mcq') { if (Number(ans) === Number(cd)) correctCount++; }
              else if (q.type === 'tf') { if (String(ans).toLowerCase() === String(cd).toLowerCase()) correctCount++; }
              else if (q.type === 'short') {
                const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
                const acc = Array.isArray(cd) ? cd : [cd];
                if (acc.some(c => norm(c) === norm(ans))) correctCount++;
              }
            } catch {}
          }
          return { id: q.id, content: q.content, type: q.type, options: q.options_json, correct: q.correct_json, explanation: q.explanation, correctRate: attemptCount > 0 ? Math.round((correctCount / attemptCount) * 100) : -1 };
        });
        const systemPrompt = `تو یک مشاور آموزشی هستی. سوالات آزمون را بررسی کن و پیشنهادات بهبود بده.
فرمت خروجی JSON: {"suggestions":[{"questionId":number,"issue":"مشکل","improvement":"پیشنهاد","newOptions":["گ۱","گ۲","گ۳","گ۴"]?,"newCorrect":number?}],"overall":"نظر کلی"}`;
        const userPrompt = `سوالات آزمون "${quiz.title}":\n${qAnalysis.map((q, i) => `سوال ${i + 1} (id:${q.id}): ${q.content.slice(0, 80)} | نوع:${q.type} | درصد درست:${q.correctRate}% | توضیح:${q.explanation || 'ندارد'}`).join('\n')}\n\nلطفاً سوالاتی که نیاز به بهبود دارند را شناسایی کن و پیشنهاد بده.`;
        try {
          const aiResponse = await callAI(env, systemPrompt, userPrompt, 2000);
          let result;
          try {
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            result = jsonMatch ? JSON.parse(jsonMatch[0]) : { overall: aiResponse, suggestions: [] };
          } catch { result = { overall: aiResponse, suggestions: [] }; }
          return json({ success: true, suggestions: result }, 200, origin);
        } catch (err) {
          return error(err.message, 500, origin);
        }
      }

      // ---------- Bank: Delete ----------
      const bankDelMatch = path.match(/^\/api\/bank\/(\d+)$/);
      if (bankDelMatch && method === 'DELETE') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const bid = Number(bankDelMatch[1]);
        await env.DB.prepare('DELETE FROM bank_questions WHERE id = ? AND teacher_id = ?').bind(bid, payload.sub).run();
        return json({ success: true }, 200, origin);
      }

      // ========== AI: Bulk Generate for Bank ==========
      if (path === '/api/ai/generate-bank' && method === 'POST') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const b = await request.json();
        const { grade, subject, chapter, count, difficulty } = b;
        if (!grade || !subject) return error('پایه و درس الزامی است.', 400, origin);
        const batchSize = Math.min(Math.max(Number(count) || 10, 1), 20);
        const totalNeeded = Math.min(Math.max(Number(count) || 10, 1), 200);
        const allQuestions = [];
        const diffLabel = { easy: 'آسان', medium: 'متوسط', hard: 'سخت', olympiad: 'المپیادی' }[difficulty] || 'متوسط';
        const chapterText = chapter ? ` فصل "${chapter}"` : '';

        // Generate in batches of 20 (API limit)
        for (let offset = 0; offset < totalNeeded; offset += batchSize) {
          const batchCount = Math.min(batchSize, totalNeeded - offset);
          const systemPrompt = `تو یک طراح سوال حرفه‌ای آزمون برای مدارس ایران هستی. سوالات استاندارد و با کیفیت طراحی کن.
قوانین خروجی JSON:
[{"content":"متن سوال","type":"mcq","options":["گزینه۱","گزینه۲","گزینه۳","گزینه۴"],"correct":0,"explanation":"توضیح"}]
- فقط سوالات چندگزینه‌ای تک‌جواب با ۴ گزینه تولید کن
- محتوا دقیق، بدون ابهام و آموزشی باشد
- پاسخ‌ها متنوع و گمراه‌کننده باشند
- هر سوال باید از نظر موضوع، زاویه دید، ساختار جمله و ترتیب گزینه‌ها با سوالات قبلی کاملاً متفاوت باشد
- از تکرار یک مفهوم یا شباهت دو سوال اکیداً خودداری کن؛ هر سوال یک نکتهٔ متفاوت از کتاب را می‌سنجد
- موقعیت‌ها و اعداد داخل سوال‌ها را متنوع کن (اعداد سال، نام‌ها، مثال‌های روزمره متفاوت)
- ترتیب گزینه صحیح بین سوالات مختلف به‌شدت جابه‌جا شود (0،1،2،3 به‌صورت پراکنده)`;
        const userPrompt = `${batchCount} سوال چندگزینه‌ای از کتاب ${subject} ${chapterText} پایه ${grade} با سطح دشواری ${diffLabel} بساز. خروجی فقط JSON آرایه باشد.
سوالات باید از هر نظر متنوع باشند: موضوعات فرعی متفاوتِ کتاب را پوشش بده، عدد و موقعیت هر سوال را تغییر بده و شماره گزینه صحیح را در سوالات مختلف عوض کن.`;
          try {
            const aiResponse = await callAI(env, systemPrompt, userPrompt, 4000);
            let questions;
            try { const m = aiResponse.match(/\[[\s\S]*\]/); questions = m ? JSON.parse(m[0]) : []; }
            catch { questions = []; }
            allQuestions.push(...questions.slice(0, batchCount));
          } catch (err) {
            if (offset === 0) return error(err.message, 500, origin);
            break;
          }
        }

        // Save to bank
        let saved = 0;
        const usable = [];
        for (const q of allQuestions) {
          if (!q.content || !q.options || !q.options.length) continue;
          usable.push(q);
          try {
            await env.DB.prepare(`INSERT INTO bank_questions (teacher_id, type, content, options_json, correct_json, score, explanation, subject, grade, chapter, difficulty)
              VALUES (?, 'mcq', ?, ?, ?, 1, ?, ?, ?, ?, ?)`).bind(
              payload.sub, q.content, JSON.stringify(q.options),
              typeof q.correct === 'number' ? q.correct : 0,
              q.explanation || '', subject, grade, chapter || '', difficulty || 'medium'
            ).run();
            saved++;
          } catch {}
        }

        // Also add to current quiz if quiz_id provided
        let addedToQuiz = 0;
        if (b.quiz_id) {
          try {
            const qz = await env.DB.prepare(
              'SELECT id FROM quizzes WHERE id = ? AND teacher_id = ?'
            ).bind(Number(b.quiz_id), payload.sub).first();
            if (qz) {
              let order = 0;
              const mo = await env.DB.prepare(
                'SELECT COALESCE(MAX(sort_order), 0) AS m FROM questions WHERE quiz_id = ?'
              ).bind(qz.id).first();
              order = mo?.m || 0;
              for (const q of usable) {
                await env.DB.prepare(`
                  INSERT INTO questions (quiz_id, type, content, options_json, correct_json, score, explanation, sort_order)
                  VALUES (?, 'mcq', ?, ?, ?, 1, ?, ?)
                `).bind(qz.id, q.content, JSON.stringify(q.options), typeof q.correct === 'number' ? q.correct : 0, q.explanation || '', ++order).run();
                addedToQuiz++;
              }
              await env.DB.prepare("UPDATE quizzes SET updated_at = datetime('now') WHERE id = ?").bind(qz.id).run();
            }
          } catch {}
        }
        return json({ success: true, generated: allQuestions.length, saved, added_to_quiz: addedToQuiz }, 200, origin);
      }

      // Bank: Update
      const bankUpdMatch = path.match(/^\/api\/bank\/(\d+)$/);
      if (bankUpdMatch && method === 'PUT') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const bid = Number(bankUpdMatch[1]);
        const b = await request.json();
        await env.DB.prepare(`UPDATE bank_questions SET
          type = COALESCE(?, type), content = COALESCE(?, content),
          options_json = COALESCE(?, options_json), correct_json = COALESCE(?, correct_json),
          score = COALESCE(?, score), explanation = COALESCE(?, explanation),
          subject = COALESCE(?, subject), grade = COALESCE(?, grade),
          chapter = COALESCE(?, chapter), difficulty = COALESCE(?, difficulty),
          tags = COALESCE(?, tags), is_public = COALESCE(?, is_public)
          WHERE id = ? AND teacher_id = ?`).bind(
          b.type ?? null, b.content ?? null,
          b.options_json !== undefined ? (typeof b.options_json === 'string' ? b.options_json : JSON.stringify(b.options_json)) : null,
          b.correct_json !== undefined ? (typeof b.correct_json === 'string' ? b.correct_json : JSON.stringify(b.correct_json)) : null,
          b.score ?? null, b.explanation ?? null, b.subject ?? null, b.grade ?? null,
          b.chapter ?? null, b.difficulty ?? null, b.tags ?? null,
          b.is_public !== undefined ? (b.is_public ? 1 : 0) : null,
          bid, payload.sub
        ).run();
        return json({ success: true }, 200, origin);
      }

      // Bank: Public (shared questions from all teachers)
      if (path === '/api/bank/public' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const url2 = new URL(request.url);
        const subject = url2.searchParams.get('subject') || '';
        const grade = url2.searchParams.get('grade') || '';
        const difficulty = url2.searchParams.get('difficulty') || '';
        const search = url2.searchParams.get('q') || '';
        let query = 'SELECT b.*, t.full_name AS teacher_name FROM bank_questions b JOIN teachers t ON b.teacher_id = t.id WHERE b.is_public = 1';
        const params = [];
        if (subject) { query += ' AND b.subject = ?'; params.push(subject); }
        if (grade) { query += ' AND b.grade = ?'; params.push(grade); }
        if (difficulty) { query += ' AND b.difficulty = ?'; params.push(difficulty); }
        if (search) { query += ' AND b.content LIKE ?'; params.push('%' + search + '%'); }
        query += ' ORDER BY b.use_count DESC, b.created_at DESC LIMIT 100';
        const rows = (await env.DB.prepare(query).bind(...params).all()).results || [];
        return json({ success: true, questions: rows }, 200, origin);
      }

      // ========== HOMEWORK ==========
      if (path === '/api/homework' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const rows = (await env.DB.prepare(`
          SELECT h.*, (SELECT COUNT(*) FROM homework_submissions WHERE homework_id = h.id) AS submission_count,
            (SELECT COUNT(*) FROM homework_submissions WHERE homework_id = h.id AND score IS NOT NULL) AS graded_count
          FROM homework h WHERE h.teacher_id = ? ORDER BY h.created_at DESC
        `).bind(payload.sub).all()).results || [];
        return json({ success: true, homework: rows }, 200, origin);
      }

      if (path === '/api/homework' && method === 'POST') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const b = await request.json();
        if (!b.title) return error('عنوان تکلیف الزامی است.', 400, origin);
        const r = await env.DB.prepare(`INSERT INTO homework (teacher_id, title, description, subject, due_date, max_score, status, attachment_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          payload.sub, b.title, b.description || '', b.subject || '', b.due_date || null,
          b.max_score ?? 10, b.status || 'active', b.attachment ? JSON.stringify(b.attachment) : null
        ).run();
        return json({ success: true, id: r.meta.last_row_id }, 201, origin);
      }

      const hwMatch = path.match(/^\/api\/homework\/(\d+)$/);
      if (hwMatch) {
        const hid = Number(hwMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);

        if (method === 'GET') {
          const hw = await env.DB.prepare('SELECT * FROM homework WHERE id = ? AND teacher_id = ?').bind(hid, payload.sub).first();
          if (!hw) return error('تکلیف یافت نشد.', 404, origin);
          let attachment = null;
          try { attachment = hw.attachment_json ? JSON.parse(hw.attachment_json) : null; } catch {}
          const subs = (await env.DB.prepare('SELECT * FROM homework_submissions WHERE homework_id = ? ORDER BY submitted_at DESC').bind(hid).all()).results || [];
          return json({ success: true, homework: { ...hw, attachment }, submissions: subs }, 200, origin);
        }
        if (method === 'PUT') {
          const hw = await env.DB.prepare('SELECT id, attachment_json FROM homework WHERE id = ? AND teacher_id = ?').bind(hid, payload.sub).first();
          if (!hw) return error('تکلیف یافت نشد.', 404, origin);
          const b = await request.json();
          const newAttachment = b.attachment !== undefined ? (b.attachment ? JSON.stringify(b.attachment) : null) : hw.attachment_json;
          await env.DB.prepare(`UPDATE homework SET title = COALESCE(?, title), description = COALESCE(?, description),
            subject = COALESCE(?, subject), due_date = ?, max_score = COALESCE(?, max_score),
            status = COALESCE(?, status), attachment_json = ? WHERE id = ? AND teacher_id = ?`).bind(
            b.title ?? null, b.description ?? null, b.subject ?? null, b.due_date ?? null,
            b.max_score ?? null, b.status ?? null, newAttachment, hid, payload.sub
          ).run();
          return json({ success: true }, 200, origin);
        }
        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM homework WHERE id = ? AND teacher_id = ?').bind(hid, payload.sub).run();
          return json({ success: true }, 200, origin);
        }
      }

      // Homework submissions (teacher)
      const hwSubMatch = path.match(/^\/api\/homework\/(\d+)\/submissions$/);
      if (hwSubMatch && method === 'GET') {
        const hid = Number(hwSubMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const hw = await env.DB.prepare('SELECT id FROM homework WHERE id = ? AND teacher_id = ?').bind(hid, payload.sub).first();
        if (!hw) return error('تکلیف یافت نشد.', 404, origin);
        const rows = (await env.DB.prepare('SELECT * FROM homework_submissions WHERE homework_id = ? ORDER BY submitted_at DESC').bind(hid).all()).results || [];
        return json({ success: true, submissions: rows }, 200, origin);
      }

      // Grade homework (teacher) — legacy endpoint (kept for compatibility)
      const hwGradeMatch2 = path.match(/^\/api\/homework-submissions\/(\d+)\/grade$/);
      if (hwGradeMatch2 && method === 'POST') {
        const sid = Number(hwGradeMatch2[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const sub = await env.DB.prepare(`
          SELECT hs.* FROM homework_submissions hs JOIN homework h ON hs.homework_id = h.id
          WHERE hs.id = ? AND h.teacher_id = ?
        `).bind(sid, payload.sub).first();
        if (!sub) return error('یافت نشد.', 404, origin);
        const b = await request.json();
        await env.DB.prepare('UPDATE homework_submissions SET score = ?, feedback = ?, graded_at = datetime(\'now\') WHERE id = ?')
          .bind(b.score ?? null, b.feedback || '', sid).run();
        return json({ success: true }, 200, origin);
      }

      // ========== ATTENDANCE ==========
      if (path === '/api/attendance' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const url2 = new URL(request.url);
        const date = url2.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const rows = (await env.DB.prepare('SELECT * FROM attendance WHERE teacher_id = ? AND date = ? ORDER BY student_name')
          .bind(payload.sub, date).all()).results || [];
        return json({ success: true, attendance: rows, date }, 200, origin);
      }

      if (path === '/api/attendance' && method === 'POST') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const b = await request.json();
        if (!b.date || !b.students || !Array.isArray(b.students)) return error('داده نامعتبر.', 400, origin);
        // Delete existing for this date
        await env.DB.prepare('DELETE FROM attendance WHERE teacher_id = ? AND date = ?').bind(payload.sub, b.date).run();
        // Insert new
        for (const s of b.students) {
          await env.DB.prepare(`INSERT INTO attendance (teacher_id, class_name, date, student_name, student_family, status, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
            payload.sub, b.class_name || '', b.date, s.name, s.family || '', s.status || 'present', s.note || ''
          ).run();
        }
        return json({ success: true }, 201, origin);
      }

      // Attendance history
      if (path === '/api/attendance/history' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const rows = (await env.DB.prepare(`
          SELECT date, class_name,
            SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count,
            SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent_count,
            SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late_count,
            SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) AS leave_count,
            COUNT(*) AS total
          FROM attendance WHERE teacher_id = ? GROUP BY date, class_name ORDER BY date DESC LIMIT 50
        `).bind(payload.sub).all()).results || [];
        return json({ success: true, history: rows }, 200, origin);
      }

      // ========== REPORTS ==========
      // Quiz statistics
      const statsMatch = path.match(/^\/api\/quizzes\/(\d+)\/stats$/);
      if (statsMatch && method === 'GET') {
        const qid = Number(statsMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const quiz = await env.DB.prepare('SELECT id, title FROM quizzes WHERE id = ? AND teacher_id = ?').bind(qid, payload.sub).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);
        const subs = (await env.DB.prepare('SELECT score, max_score, percent, passed, duration_sec, student_name, student_family, class_name FROM submissions WHERE quiz_id = ?').bind(qid).all()).results || [];
        const questions = (await env.DB.prepare('SELECT id, type, content, score, correct_json FROM questions WHERE quiz_id = ? ORDER BY sort_order, id').bind(qid).all()).results || [];
        if (!subs.length) return json({ success: true, stats: { total: 0, avg: 0, passRate: 0, highest: 0, lowest: 0, questions: [], distribution: [] } }, 200, origin);
        const avg = subs.reduce((s, x) => s + (x.percent || 0), 0) / subs.length;
        const passRate = subs.filter(s => s.passed).length / subs.length * 100;
        const highest = Math.max(...subs.map(s => s.percent || 0));
        const lowest = Math.min(...subs.map(s => s.percent || 0));
        const avgDuration = subs.reduce((s, x) => s + (x.duration_sec || 0), 0) / subs.length;
        // Grade distribution
        const dist = [0, 0, 0, 0, 0]; // 0-20, 20-40, 40-60, 60-80, 80-100
        subs.forEach(s => { const p = s.percent || 0; const idx = Math.min(4, Math.floor(p / 20)); dist[idx]++; });
        const distribution = dist.map((count, i) => ({ range: (i*20) + '-' + ((i+1)*20), count }));
        // Per-question stats
        const qStats = questions.map(q => {
          let correct = 0;
          subs.forEach(s => {
            let answers = {}; try { answers = JSON.parse(s.answers_json || '{}'); } catch {}
            const ans = answers[String(q.id)];
            if (ans === undefined || ans === null || ans === '') return;
            try {
              const cd = JSON.parse(q.correct_json);
              if (q.type === 'mcq' && Number(ans) === Number(cd)) correct++;
              else if (q.type === 'tf' && String(ans).toLowerCase() === String(cd).toLowerCase()) correct++;
              else if (q.type === 'short') {
                const norm = x => String(x).trim().toLowerCase().replace(/\s+/g, ' ');
                const acc = Array.isArray(cd) ? cd : [cd];
                if (acc.some(c => norm(c) === norm(ans))) correct++;
              }
            } catch {}
          });
          return { id: q.id, content: q.content.slice(0, 100), type: q.type, score: q.score,
            correctRate: subs.length > 0 ? Math.round(correct / subs.length * 100) : 0 };
        });
        // Top students
        const top = [...subs].sort((a, b) => (b.percent || 0) - (a.percent || 0)).slice(0, 10).map(s => ({
          name: s.student_name + ' ' + s.student_family, score: s.score, max_score: s.max_score, percent: s.percent, class_name: s.class_name
        }));
        return json({ success: true, stats: {
          total: subs.length, avg: avg.toFixed(1), passRate: passRate.toFixed(1),
          highest, lowest, avgDuration: Math.round(avgDuration),
          questions: qStats, distribution, top, quiz_title: quiz.title
        }}, 200, origin);
      }

      // Student performance over time
      if (path === '/api/student-performance' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const url2 = new URL(request.url);
        const name = url2.searchParams.get('name') || '';
        const family = url2.searchParams.get('family') || '';
        if (!name) return error('نام دانش‌آموز الزامی است.', 400, origin);
        const rows = (await env.DB.prepare(`
          SELECT s.percent, s.score, s.max_score, s.finished_at, q.title AS quiz_title
          FROM submissions s JOIN quizzes q ON s.quiz_id = q.id
          JOIN teachers t ON q.teacher_id = t.id
          WHERE t.id = ? AND s.student_name = ? AND s.student_family = ?
          ORDER BY s.finished_at ASC
        `).bind(payload.sub, name, family || '').all()).results || [];
        return json({ success: true, performance: rows }, 200, origin);
      }

      // ========== BRANDING ==========
      if (path === '/api/branding' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const branding = await env.DB.prepare('SELECT * FROM branding WHERE teacher_id = ?')
          .bind(payload.sub).first();
        return json({ success: true, branding: branding || {
          brand_name: 'Quiz26', primary_color: '#6366f1', subdomain: null, logo_url: null
        }}, 200, origin);
      }

      if (path === '/api/branding' && method === 'POST') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const b = await request.json();
        const existing = await env.DB.prepare('SELECT teacher_id FROM branding WHERE teacher_id = ?')
          .bind(payload.sub).first();
        if (existing) {
          await env.DB.prepare(`UPDATE branding SET
            brand_name = COALESCE(?, brand_name),
            primary_color = COALESCE(?, primary_color),
            subdomain = ?,
            logo_url = ?
            WHERE teacher_id = ?`).bind(
            b.brand_name ?? null, b.primary_color ?? null,
            b.subdomain !== undefined ? b.subdomain : null,
            b.logo_url !== undefined ? b.logo_url : null,
            payload.sub
          ).run();
        } else {
          await env.DB.prepare(`INSERT INTO branding (teacher_id, brand_name, primary_color, subdomain, logo_url)
            VALUES (?, ?, ?, ?, ?)`).bind(
            payload.sub,
            b.brand_name || 'Quiz26',
            b.primary_color || '#6366f1',
            b.subdomain || null,
            b.logo_url || null
          ).run();
        }
        return json({ success: true }, 200, origin);
      }

      // ========== HOMEWORK SUBMISSIONS ==========
      const hwSubsMatch = path.match(/^\/api\/homework\/(\d+)\/submissions$/);
      if (hwSubsMatch && method === 'GET') {
        const hid = Number(hwSubsMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const hw = await env.DB.prepare('SELECT id FROM homework WHERE id = ? AND teacher_id = ?').bind(hid, payload.sub).first();
        if (!hw) return error('تکلیف یافت نشد.', 404, origin);
        const subs = (await env.DB.prepare('SELECT * FROM homework_submissions WHERE homework_id = ? ORDER BY submitted_at DESC').bind(hid).all()).results || [];
        return json({ success: true, submissions: subs }, 200, origin);
      }

      // Grade homework submission
      const gradeHwMatch = path.match(/^\/api\/homework\/submissions\/(\d+)\/grade$/);
      if (gradeHwMatch && method === 'POST') {
        const sid = Number(gradeHwMatch[1]);
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const sub = await env.DB.prepare('SELECT hs.id FROM homework_submissions hs JOIN homework h ON hs.homework_id = h.id WHERE hs.id = ? AND h.teacher_id = ?').bind(sid, payload.sub).first();
        if (!sub) return error('یافت نشد.', 404, origin);
        const b = await request.json();
        await env.DB.prepare('UPDATE homework_submissions SET score = ?, comments = ?, grade = ?, graded_at = datetime(\'now\') WHERE id = ?')
          .bind(b.score ?? b.grade ?? null, b.comments || '', b.grade !== undefined ? String(b.grade) : null, sid).run();
        return json({ success: true }, 200, origin);
      }

      // ========== PUBLIC HOMEWORK SUBMIT ==========
      // Public quiz metadata for homework-style pages (no auth): include end_at grace
      const pubHwMatch = path.match(/^\/api\/public\/homework\/(\d+)$/);
      if (pubHwMatch && method === 'GET') {
        const hid = Number(pubHwMatch[1]);
        const hw = await env.DB.prepare('SELECT id, title, description, subject, due_date, max_score, status, attachment_json FROM homework WHERE id = ? AND status = ?').bind(hid, 'active').first();
        if (!hw) return error('تکلیف یافت نشد.', 404, origin);
        let attachment = null;
        try { attachment = hw.attachment_json ? JSON.parse(hw.attachment_json) : null; } catch {}
        return json({ success: true, homework: { ...hw, attachment } }, 200, origin);
      }

      const pubHwSubMatch = path.match(/^\/api\/public\/homework\/(\d+)\/submit$/);
      if (pubHwSubMatch && method === 'POST') {
        const hid = Number(pubHwSubMatch[1]);
        const hw = await env.DB.prepare('SELECT id FROM homework WHERE id = ?').bind(hid).first();
        if (!hw) return error('تکلیف یافت نشد.', 404, origin);
        const b = await request.json();
        if (!b.student_name) return error('نام دانش‌آموز الزامی است.', 400, origin);
        // Anti-duplicate: same name (+family) can submit each homework only once — teacher can reply with "needs_revision" for resubmission
        const dupHw = await env.DB.prepare(
          'SELECT id, status FROM homework_submissions WHERE homework_id = ? AND student_name = ? AND student_family = ?'
        ).bind(hid, b.student_name, b.student_family || '').first();
        if (dupHw && dupHw.status === 'approved') {
          return error('تکلیف شما تأیید شده و دیگر قابل تغییر نیست.', 403, origin);
        }
        if (dupHw && dupHw.status !== 'needs_revision') {
          return error('شما قبلاً این تکلیف را ارسال کرده‌اید. برای مشاهده نتیجه از دکمه «مشاهده وضعیت» استفاده کنید.', 409, origin);
        }
        if (dupHw && dupHw.status === 'needs_revision') {
          // Resubmission after teacher requested revision — PRESERVE previously uploaded files unless new ones provided
          let filesJson = JSON.stringify(b.files || []);
          let oldFiles = [];
          try { oldFiles = JSON.parse((await env.DB.prepare('SELECT files_json FROM homework_submissions WHERE id = ?').bind(dupHw.id).first()).files_json || '[]'); } catch {}
          if (!(b.files && b.files.length) && oldFiles.length) filesJson = JSON.stringify(oldFiles);
          const finalFiles = JSON.parse(filesJson);
          await env.DB.prepare(`UPDATE homework_submissions SET answer_text = ?, files_json = ?, status = 'pending', reply = '', student_phone = ?, submitted_at = datetime('now') WHERE id = ?`)
            .bind(b.answer_text || '', filesJson, normPhone(b.student_phone || ''), dupHw.id).run();
          return json({ success: true, id: dupHw.id, status: 'pending', resubmitted: true, kept_files: finalFiles.length }, 200, origin);
        }
        const r = await env.DB.prepare(`INSERT INTO homework_submissions (homework_id, student_name, student_family, school, class_name, answer_text, student_phone, files_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          hid, b.student_name, b.student_family || '', b.school || '', b.class_name || '',
          b.answer_text || '', normPhone(b.student_phone || ''), JSON.stringify(b.files || [])
        ).run();
        return json({ success: true, id: r.meta.last_row_id, status: 'pending' }, 201, origin);
      }

      // Public: student fetches their own homework submission status (by phone or name)
      const pubHwStatusMatch = path.match(/^\/api\/public\/homework\/(\d+)\/status$/);
      if (pubHwStatusMatch && method === 'GET') {
        const hid = Number(pubHwStatusMatch[1]);
        const url2 = new URL(request.url);
        const phone = normPhone(url2.searchParams.get('phone') || '');
        const nm = String(url2.searchParams.get('name') || '').trim();
        const fam = String(url2.searchParams.get('family') || '').trim();
        if (!phone && !nm) return error('شماره یا نام الزامی است.', 400, origin);
        let rows = [];
        if (phone) {
          rows = (await env.DB.prepare(`
            SELECT id, student_name, student_family, answer_text, files_json, score, status, reply, replied_at, submitted_at, graded_at
            FROM homework_submissions WHERE homework_id = ? AND student_phone = ?
            ORDER BY submitted_at DESC LIMIT 1
          `).bind(hid, phone).all()).results || [];
        }
        if (!rows.length && nm) {
          rows = (await env.DB.prepare(`
            SELECT id, student_name, student_family, answer_text, files_json, score, status, reply, replied_at, submitted_at, graded_at
            FROM homework_submissions WHERE homework_id = ? AND student_name = ? AND (student_family = ? OR ? = '')
            ORDER BY submitted_at DESC LIMIT 1
          `).bind(hid, nm, fam, fam).all()).results || [];
        }
        if (!rows.length) return json({ success: true, submission: null }, 200, origin);
        return json({ success: true, submission: rows[0] }, 200, origin);
      }

      // ---------- Student panel (logged-in students) ----------
      const stuPanelMatch = path.match(/^\/api\/student\/panel$/);
      if (stuPanelMatch && method === 'GET') {
        const sp = await getStudentAuth(request, env);
        if (!sp) return error('Unauthorized', 401, origin);
        const st = await env.DB.prepare('SELECT id, username, full_name, class_name FROM students WHERE id = ?').bind(sp.sid).first();
        if (!st) return error('حساب یافت نشد.', 404, origin);
        // Active quizzes of THIS student's teacher (all quizzes; participation state computed per quiz)
        const quizzes = (await env.DB.prepare(`
          SELECT q.id, q.title, q.description, q.duration_min, q.status, q.start_at, q.end_at, q.require_login, q.report_after_end, q.stacked_view, q.attachment_json,
            (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS question_count,
            (SELECT COUNT(*) FROM submissions WHERE quiz_id = q.id AND student_user_id = ?) AS my_attempts
          FROM quizzes q WHERE q.teacher_id = ? AND q.status = 'active'
          ORDER BY q.created_at DESC LIMIT 50
        `).bind(sp.sid, sp.tid).all()).results || [];
        const homework = (await env.DB.prepare(`
          SELECT h.id, h.title, h.subject, h.description, h.due_date, h.max_score, h.attachment_json,
            (SELECT status FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.student_name = ? AND hs.student_family = ? ORDER BY hs.submitted_at DESC LIMIT 1) AS my_status,
            (SELECT score FROM homework_submissions hs2 WHERE hs2.homework_id = h.id AND hs2.student_name = ? AND hs2.student_family = ? ORDER BY hs2.submitted_at DESC LIMIT 1) AS my_score,
            (SELECT reply FROM homework_submissions hs3 WHERE hs3.homework_id = h.id AND hs3.student_name = ? AND hs3.student_family = ? ORDER BY hs3.submitted_at DESC LIMIT 1) AS my_reply
          FROM homework h WHERE h.teacher_id = ? AND h.status = 'active'
          ORDER BY h.created_at DESC LIMIT 50
        `).bind(st.full_name.split(' ')[0] || '', st.full_name.split(' ').slice(1).join(' ') || '', st.full_name.split(' ')[0] || '', st.full_name.split(' ').slice(1).join(' ') || '', st.full_name.split(' ')[0] || '', st.full_name.split(' ').slice(1).join(' ') || '', sp.tid).all()).results || [];
        const homeworkMapped = homework.map(h => { let attachment = null; try { attachment = h.attachment_json ? JSON.parse(h.attachment_json) : null; } catch {} return { ...h, attachment, attachment_json: undefined }; });
        const attendance = (await env.DB.prepare(`
          SELECT date, status, class_name FROM attendance WHERE teacher_id = ? AND student_name = ? AND student_family = ?
          ORDER BY date DESC LIMIT 60
        `).bind(sp.tid, st.full_name.split(' ')[0] || '', st.full_name.split(' ').slice(1).join(' ') || '').all()).results || [];
        const results = (await env.DB.prepare(`
          SELECT s.id, s.quiz_id, s.score, s.max_score, s.percent, s.passed, s.finished_at, q.title AS quiz_title
          FROM submissions s JOIN quizzes q ON s.quiz_id = q.id
          WHERE s.student_user_id = ? AND (q.show_result = 1 OR q.report_after_end = 0)
          ORDER BY s.finished_at DESC LIMIT 50
        `).bind(sp.sid).all()).results || [];
        return json({ success: true, student: st, quizzes, homework: homeworkMapped, attendance, results }, 200, origin);
      }

      return error('مسیر یافت نشد.', 404, origin);
    } catch (err) {
      console.error(err);
      return json({ success: false, message: err.message || 'خطای سرور' }, 500, origin);
    }
  },
};
