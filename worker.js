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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
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

/* ---------- OpenRouter AI Helper (به‌روزرسانی‌شده 2026) ---------- */
async function callAI(env, systemPrompt, userPrompt, maxTokens = 2000) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const key = env.OPENROUTER_KEY || '';
  if (!key) throw new Error('کلید API هوش مصنوعی تنظیم نشده است.');

  const model = env.AI_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + key,
  };

  if (env.SITE_URL) headers['HTTP-Referer'] = env.SITE_URL;
  else headers['HTTP-Referer'] = 'https://quiz26.dpdns.org';
  headers['X-Title'] = 'Quiz26';

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
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

/* ---------- Scoring ---------- */
function scoreSubmission(questions, answers) {
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
    if (correct) score += Number(q.score) || 1;
  }
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
        const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM teachers').first();
        if (count?.c > 0) {
          const payload = await getAuth(request, env);
          if (!payload) return error('برای ثبت معلم جدید باید وارد شوید.', 401, origin);
        }
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
            max_attempts, status, start_at, end_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          b.end_at || null
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
          'SELECT id, title, description, duration_min, pass_score, shuffle_q, shuffle_opt, negative_mark, show_result, anti_copy, anti_tab, max_attempts, status, start_at, end_at FROM quizzes WHERE id = ?'
        ).bind(qid).first();
        if (!quiz) return error('آزمون یافت نشد.', 404, origin);
        if (quiz.status !== 'active') return error('این آزمون در حال حاضر فعال نیست.', 403, origin);

        const now = new Date().toISOString();
        if (quiz.start_at && now < quiz.start_at) return error('آزمون هنوز شروع نشده است.', 403, origin);
        if (quiz.end_at && now > quiz.end_at) return error('مهلت شرکت در آزمون به پایان رسیده است.', 403, origin);

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
            question_count: questions.length,
          },
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

        const body = await request.json();
        const { student_name, student_family, school, class_name, answers, duration_sec, tab_switches } = body;
        if (!student_name) return error('نام دانش‌آموز الزامی است.', 400, origin);
        if (!answers || typeof answers !== 'object') return error('پاسخ‌ها نامعتبر است.', 400, origin);

        const questions = (await env.DB.prepare(
          'SELECT id, type, correct_json, score FROM questions WHERE quiz_id = ?'
        ).bind(qid).all()).results || [];

        const { score, maxScore, percent } = scoreSubmission(questions, answers);
        const passed = percent >= (quiz.pass_score || 50) ? 1 : 0;
        const hasEssay = questions.some(q => q.type === 'essay');

        const r = await env.DB.prepare(`
          INSERT INTO submissions (
            quiz_id, student_name, student_family, school, class_name,
            answers_json, score, max_score, percent, passed,
            duration_sec, tab_switches, ip_address, user_agent, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).bind(
          qid,
          student_name,
          student_family || '',
          school || '',
          class_name || '',
          JSON.stringify(answers),
          score,
          maxScore,
          percent,
          passed,
          duration_sec || 0,
          tab_switches || 0,
          request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '',
          (request.headers.get('User-Agent') || '').slice(0, 300),
          body.started_at || null
        ).run();

        const result = {
          success: true,
          submission_id: r.meta.last_row_id,
          score,
          max_score: maxScore,
          percent,
          passed: !!passed,
          show_result: !!quiz.show_result,
          essay_pending: hasEssay,
        };
        return json(result, 201, origin);
      }

      const resultMatch = path.match(/^\/api\/public\/result\/(\d+)$/);
      if (resultMatch && method === 'GET') {
        const sid = Number(resultMatch[1]);
        const sub = await env.DB.prepare(`
          SELECT s.*, q.title AS quiz_title, q.pass_score, q.show_result
          FROM submissions s
          JOIN quizzes q ON s.quiz_id = q.id
          WHERE s.id = ?
        `).bind(sid).first();
        if (!sub) return error('نتیجه یافت نشد.', 404, origin);
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
- پاسخ‌ها متنوع و گمراه‌کننده باشند`;
          const userPrompt = `${batchCount} سوال چندگزینه‌ای از کتاب ${subject} پایه ${diffLabel} پایه ${grade} ${chapterText} بساز. خروجی فقط JSON آرایه باشد.`;
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
        for (const q of allQuestions) {
          if (!q.content || !q.options || !q.options.length) continue;
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
        return json({ success: true, generated: allQuestions.length, saved }, 200, origin);
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

      // Bank: Stats
      if (path === '/api/bank/stats' && method === 'GET') {
        const payload = await getAuth(request, env);
        if (!payload) return error('Unauthorized', 401, origin);
        const stats = await env.DB.prepare(`
          SELECT
            (SELECT COUNT(*) FROM bank_questions WHERE teacher_id = ?) AS total,
            (SELECT COUNT(DISTINCT subject) FROM bank_questions WHERE teacher_id = ? AND subject != '') AS subjects,
            (SELECT COUNT(*) FROM bank_questions WHERE teacher_id = ? AND difficulty = 'easy') AS easy,
            (SELECT COUNT(*) FROM bank_questions WHERE teacher_id = ? AND difficulty = 'medium') AS medium,
            (SELECT COUNT(*) FROM bank_questions WHERE teacher_id = ? AND difficulty = 'hard') AS hard,
            (SELECT COUNT(*) FROM bank_questions WHERE teacher_id = ? AND difficulty = 'olympiad') AS olympiad
        `).bind(payload.sub, payload.sub, payload.sub, payload.sub, payload.sub, payload.sub).first();
        return json({ success: true, stats }, 200, origin);
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
        const r = await env.DB.prepare(`INSERT INTO homework (teacher_id, title, description, subject, due_date, max_score, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
          payload.sub, b.title, b.description || '', b.subject || '', b.due_date || null,
          b.max_score ?? 10, b.status || 'active'
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
          const subs = (await env.DB.prepare('SELECT * FROM homework_submissions WHERE homework_id = ? ORDER BY submitted_at DESC').bind(hid).all()).results || [];
          return json({ success: true, homework: hw, submissions: subs }, 200, origin);
        }
        if (method === 'PUT') {
          const b = await request.json();
          await env.DB.prepare(`UPDATE homework SET title = COALESCE(?, title), description = COALESCE(?, description),
            subject = COALESCE(?, subject), due_date = ?, max_score = COALESCE(?, max_score),
            status = COALESCE(?, status) WHERE id = ? AND teacher_id = ?`).bind(
            b.title ?? null, b.description ?? null, b.subject ?? null, b.due_date ?? null,
            b.max_score ?? null, b.status ?? null, hid, payload.sub
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

      // Grade homework (teacher)
      const hwGradeMatch = path.match(/^\/api\/homework-submissions\/(\d+)\/grade$/);
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
      const pubHwMatch = path.match(/^\/api\/public\/homework\/(\d+)$/);
      if (pubHwMatch && method === 'GET') {
        const hid = Number(pubHwMatch[1]);
        const hw = await env.DB.prepare('SELECT id, title, description, subject, due_date, max_score, status FROM homework WHERE id = ? AND status = ?').bind(hid, 'active').first();
        if (!hw) return error('تکلیف یافت نشد.', 404, origin);
        return json({ success: true, homework: hw }, 200, origin);
      }

      const pubHwSubMatch = path.match(/^\/api\/public\/homework\/(\d+)\/submit$/);
      if (pubHwSubMatch && method === 'POST') {
        const hid = Number(pubHwSubMatch[1]);
        const hw = await env.DB.prepare('SELECT id FROM homework WHERE id = ?').bind(hid).first();
        if (!hw) return error('تکلیف یافت نشد.', 404, origin);
        const b = await request.json();
        if (!b.student_name) return error('نام دانش‌آموز الزامی است.', 400, origin);
        await env.DB.prepare(`INSERT INTO homework_submissions (homework_id, student_name, student_family, school, class_name, answer_text, files_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
          hid, b.student_name, b.student_family || '', b.school || '', b.class_name || '',
          b.answer_text || '', JSON.stringify(b.files || [])
        ).run();
        return json({ success: true }, 201, origin);
      }

      return error('مسیر یافت نشد.', 404, origin);
    } catch (err) {
      console.error(err);
      return json({ success: false, message: err.message || 'خطای سرور' }, 500, origin);
    }
  },
};
