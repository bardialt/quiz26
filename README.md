# Quiz26 — سامانه آزمون آنلاین هوشمند با هوش مصنوعی (Persian RTL)

**Domain:** [https://quiz26.dpdns.org](https://quiz26.dpdns.org)

سامانهٔ کامل ساخت و برگزاری آزمون آنلاین روی Cloudflare با هوش مصنوعی DeepSeek:

| لایه | پلتفرم |
|------|--------|
| Frontend | Cloudflare Pages (`index.html` — SPA) |
| Backend API | Cloudflare Workers (`worker.js`) |
| Database | Cloudflare D1 (`schema.sql`) |
| AI Engine | Nemotron 3 Ultra (از طریق OpenRouter) |

---

## امکانات

### معلم / مدیر
- ورود با JWT (PBKDF2 + HS256)
- اولین ورود → ساخت خودکار حساب ادمین
- داشبورد حرفه‌ای با کارت‌های آمار و انیمیشن
- استودیوی آزمون: عنوان، زمان، نمره قبولی، وضعیت، shuffle، ضدتقلب
- انواع سوال: چندگزینه‌ای تک/چند جواب، درست/نادرست، پاسخ کوتاه، **تشریحی**
- وزن نمره، توضیح پاسخ
- لینک اشتراک `https://quiz26.dpdns.org/quiz/:id`
- جدول نتایج + خروجی CSV (UTF-8 مناسب اکسل)
- بانک سوال شخصی

### هوش مصنوعی (OpenRouter - Nemotron 3 Ultra)
- **تولید خودکار سوال**: ساخت سوالات چندگزینه‌ای، درست/نادرست، پاسخ کوتاه با AI
- **تصحیح تشریحی**: نمره‌دهی خودکار پاسخ‌های بلند با هوش مصنوعی
- **تحلیل آزمون**: بررسی سوالات سخت/آسان، توزیع نمرات و پیشنهادات
- **پیشنهاد بهبود**: شناسایی سوالات ضعیف و پیشنهاد جایگزین

### دانش‌آموز
- ثبت‌نام سریع: نام، نام‌خانوادگی، مدرسه، کلاس
- تایمر، ناوبری، پالت وضعیت، نشان‌گذاری
- **نوار پیشرفت** در محیط آزمون
- ضدتقلب: مسدود کپی/راست‌کلیک + هشدار ترک تب (۳ بار → ارسال اجباری)
- ارسال خودکار پایان زمان
- کارنامه آنی + چاپ

---

## استقرار گام‌به‌گام

### پیش‌نیاز
```bash
npm i -g wrangler
wrangler login
```

### ۱) دیتابیس D1
```bash
wrangler d1 create quiz26-db
```
`database_id` را در `wrangler.toml` جایگزین کنید، سپس:
```bash
wrangler d1 execute quiz26-db --remote --file=./schema.sql
```

### ۲) Worker (API)
```bash
wrangler secret put JWT_SECRET   # یک رشتهٔ تصادفی بلند
wrangler deploy
```

### ۳) Route دامنه برای API
Dashboard → Workers → quiz26-api → Domains & Routes → Add Route  
`quiz26.dpdns.org/api/*`

یا در `wrangler.toml`:
```toml
routes = [
  { pattern = "quiz26.dpdns.org/api/*", zone_name = "dpdns.org" }
]
```

### ۴) Frontend روی Pages
- Build command: خالی
- Output directory: `/` (ریشه پروژه)
- Custom domain: `quiz26.dpdns.org`

فایل‌های لازم: `index.html`, `_redirects`, `_routes.json`

### ۵) اولین ورود
باز کردن `https://quiz26.dpdns.org/#/login`  
هر نام کاربری + رمز (≥۶ کاراکتر) وقتی جدول معلمان خالی است → ادمین ساخته می‌شود.

---

## توسعه محلی
```bash
wrangler d1 execute quiz26-db --local --file=./schema.sql
wrangler dev
# API: http://127.0.0.1:8787
```
در `index.html` برای لوکال، `API_BASE` خودکار به `8787` می‌رود.

---

## API خلاصه

| Method | Path | Auth | توضیح |
|--------|------|------|-------|
| GET | `/api/health` | — | سلامت |
| POST | `/api/auth/login` | — | ورود / bootstrap |
| POST | `/api/auth/setup` | — | فقط وقتی جدول خالی |
| GET | `/api/auth/me` | JWT | کاربر جاری |
| GET | `/api/dashboard` | JWT | آمار + لیست |
| GET/POST | `/api/quizzes` | JWT | لیست / ساخت |
| GET/PUT/DELETE | `/api/quizzes/:id` | JWT | CRUD |
| GET/POST | `/api/quizzes/:id/questions` | JWT | سوالات |
| PUT/DELETE | `/api/questions/:id` | JWT | ویرایش/حذف سوال |
| GET | `/api/quizzes/:id/submissions` | JWT | نتایج |
| GET | `/api/public/quiz/:id` | — | بارگذاری آزمون |
| POST | `/api/public/quiz/:id/submit` | — | ارسال پاسخ |
| GET | `/api/public/result/:id` | — | کارنامه |
| GET/POST | `/api/bank` | JWT | بانک سوال |

---

## امنیت
1. همیشه `JWT_SECRET` را با `wrangler secret put` تنظیم کنید.
2. رمزهای قوی برای معلمان.
3. D1 فقط از طریق Worker در دسترس است.
4. CORS محدود به دامنهٔ شما + localhost.
5. ضدتقلب سمت کلاینت بازدارنده است، نه پروکتورینگ رمزنگاری‌شده.

---

## عیب‌یابی
- **CORS**: Route ورکر روی همان هاست باشد.
- **API 404 روی Pages**: Route `quiz26.dpdns.org/api/*` تنظیم نشده.
- **DB is not defined**: binding نام `DB` و deploy با D1.
- **SPA 404 روی /quiz/id**: `_redirects` منتشر شده باشد.
- **لاگین خالی**: `schema.sql` روی D1 **remote** اجرا شده باشد.

---

استفادهٔ آموزشی آزاد روی Cloudflare.
