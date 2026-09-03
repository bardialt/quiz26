-- Quiz26 Migration 002: Enhanced Features
-- Safe migration - only adds columns that don't exist yet

-- Add notification_json column to teachers table
ALTER TABLE teachers ADD COLUMN notification_json TEXT DEFAULT '[]';

-- Add grade column to homework_submissions (for explicit grading type)
ALTER TABLE homework_submissions ADD COLUMN grade TEXT DEFAULT NULL;

-- Create performance indexes (IF NOT EXISTS is safe)
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_name, student_family);
CREATE INDEX IF NOT EXISTS idx_bank_subject ON bank_questions(subject);
CREATE INDEX IF NOT EXISTS idx_bank_grade ON bank_questions(grade);
CREATE INDEX IF NOT EXISTS idx_bank_chapter ON bank_questions(chapter);
CREATE INDEX IF NOT EXISTS idx_homework_due ON homework(due_date);
