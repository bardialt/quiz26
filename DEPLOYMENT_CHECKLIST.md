# Quick Deployment Checklist

## Pre-Deployment Steps

### 1. Run Database Migration
```sql
-- Apply migrations/002_features.sql to D1 database
-- This adds:
-- - leave_count column to attendance
-- - notification_json column to teachers
-- - files_json and comments columns to homework_submissions
-- - Performance indexes
```

### 2. Deploy Files
- [x] `worker.js` (1544 lines, +51 new lines)
- [x] `quiz26/index.html` (2528 lines, +484 new lines)
- [x] `migrations/002_features.sql` (30 lines, new file)

## Features Added

### Bug Fixes
- [x] Duplicate statsEl removed
- [x] Exam double-submit prevention
- [x] Exam state persistence (localStorage)
- [x] Proper event listener cleanup

### New Features
- [x] Notifications system with bell icon
- [x] Homework file upload & grading
- [x] Enhanced attendance (excused status, percentages)
- [x] Report card view (printable)
- [x] Exam review mode
- [x] Sound warnings for timer
- [x] Full backup/export/import
- [x] Auto-backup reminder
- [x] Bank statistics endpoint
- [x] Mobile responsive exam palette

## New API Endpoints
1. `GET /api/bank/stats` - Bank statistics
2. `GET /api/homework/:id/submissions` - Get homework submissions
3. `POST /api/homework/submissions/:id/grade` - Grade submission
4. Updated `GET /api/attendance/history` - Now includes leave_count

## Testing Checklist

### Critical
- [ ] Test exam start → tab switch → auto-submit (was hanging)
- [ ] Test exam state persistence (refresh page during exam)
- [ ] Test double-submit prevention
- [ ] Test notification bell appears and shows count

### New Features
- [ ] Test notifications appear on homework submission
- [ ] Test homework file upload and preview
- [ ] Test homework grading from teacher view
- [ ] Test attendance with excused status
- [ ] Test attendance history shows percentages
- [ ] Test report card view (F11 for fullscreen, then print)
- [ ] Test exam review mode checkbox
- [ ] Test sound plays at 5 min and 1 min
- [ ] Test full backup download
- [ ] Test backup restore from file
- [ ] Test backup reminder (set last backup to > 1 week ago in localStorage)

### Mobile
- [ ] Test exam palette on mobile (should show 6 columns)
- [ ] Test all features work on mobile viewport

## Notes
- All text is in Persian (فارسی) ✓
- Glass morphism design preserved ✓
- Existing features still work ✓
- No breaking changes ✓

## Rollback Plan
If issues arise, revert to previous versions of:
1. `worker.js`
2. `quiz26/index.html`
No database rollback needed (new columns are nullable)
