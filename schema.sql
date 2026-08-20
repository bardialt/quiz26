-- ============================================================
-- Quiz26 — Safe Schema v2
-- این فایل دیتاها رو پاک نمی‌کنه! فقط جداول جدید رو می‌سازه
-- ============================================================

CREATE TABLE IF NOT EXISTS teachers (
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
);

CREATE TABLE IF NOT EXISTS quizzes (
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
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quizzes_teacher ON quizzes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_status ON quizzes(status);

CREATE TABLE IF NOT EXISTS questions (
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
);

CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id);

CREATE TABLE IF NOT EXISTS bank_questions (
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
  difficulty    TEXT    DEFAULT 'medium',
  tags          TEXT    DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_teacher ON bank_questions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_bank_subject ON bank_questions(subject);
CREATE INDEX IF NOT EXISTS idx_bank_grade ON bank_questions(grade);

-- New columns (safe to run multiple times - D1 ignores duplicate ADD COLUMN)
ALTER TABLE bank_questions ADD COLUMN chapter TEXT DEFAULT '';
ALTER TABLE bank_questions ADD COLUMN is_public INTEGER DEFAULT 0;
ALTER TABLE bank_questions ADD COLUMN use_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bank_chapter ON bank_questions(chapter);

CREATE TABLE IF NOT EXISTS submissions (
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
  finished_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_quiz ON submissions(quiz_id);
CREATE INDEX IF NOT EXISTS idx_submissions_finished ON submissions(finished_at);

CREATE TABLE IF NOT EXISTS homework (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL,
  title         TEXT    NOT NULL,
  description   TEXT    DEFAULT '',
  subject       TEXT    DEFAULT '',
  due_date      TEXT,
  max_score     REAL    NOT NULL DEFAULT 10,
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_homework_teacher ON homework(teacher_id);

CREATE TABLE IF NOT EXISTS homework_submissions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  homework_id     INTEGER NOT NULL,
  student_name    TEXT    NOT NULL,
  student_family  TEXT    NOT NULL DEFAULT '',
  school          TEXT    DEFAULT '',
  class_name      TEXT    DEFAULT '',
  answer_text     TEXT    DEFAULT '',
  files_json      TEXT    DEFAULT '[]',
  score           REAL,
  feedback        TEXT    DEFAULT '',
  graded_at       TEXT,
  submitted_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hw_sub_homework ON homework_submissions(homework_id);

CREATE TABLE IF NOT EXISTS attendance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL,
  class_name    TEXT    NOT NULL,
  date          TEXT    NOT NULL,
  student_name  TEXT    NOT NULL,
  student_family TEXT NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'present',
  note          TEXT    DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attendance_teacher ON attendance(teacher_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);

CREATE TABLE IF NOT EXISTS branding (
  teacher_id    INTEGER PRIMARY KEY,
  brand_name    TEXT    DEFAULT 'Quiz26',
  primary_color TEXT    DEFAULT '#6366f1',
  subdomain     TEXT,
  logo_url      TEXT
);

CREATE TABLE IF NOT EXISTS ai_generations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL,
  quiz_id       INTEGER,
  type          TEXT    NOT NULL DEFAULT 'generate',
  prompt        TEXT,
  response_json TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_teacher ON ai_generations(teacher_id);
