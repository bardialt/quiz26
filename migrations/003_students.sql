-- ============================================================
-- Quiz26 — Migration 003: Student accounts & exam access control
-- فقط یک بار اجرا شود:
-- wrangler d1 execute quiz26-db --remote --file=./migrations/003_students.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS students (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL,
  username      TEXT    NOT NULL COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  full_name     TEXT    DEFAULT '',
  class_name    TEXT    DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(teacher_id, username)
);

CREATE INDEX IF NOT EXISTS idx_students_teacher ON students(teacher_id);

-- اگر این خطا داد که ستون وجود دارد، مشکلی نیست (قبلاً اضافه شده)
ALTER TABLE quizzes ADD COLUMN require_login INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN student_user_id INTEGER;
