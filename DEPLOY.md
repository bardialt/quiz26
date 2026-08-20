# راهنمای استقرار Quiz26 روی Cloudflare

## فاز ۱: پیش‌نیازها

```bash
# نصب Wrangler CLI
npm i -g wrangler

# ورود به حساب Cloudflare
wrangler login
```

---

## فاز ۲: دیتابیس D1

```bash
# ایجاد دیتابیس
wrangler d1 create quiz26-db

# کپی database_id دریافتی و جایگزینی در wrangler.toml
# سپس اجرای schema
wrangler d1 execute quiz26-db --remote --file=./schema.sql
```

---

## فاز ۳: متغیرهای محیطی (Secrets)

```bash
# رمز JWT (یک رشته تصادفی بلند مثلاً 32 کاراکتر)
wrangler secret put JWT_SECRET
# مثال: MySuperSecretJWTKey2024!@#$%^&*

# کلید API OpenRouter
wrangler secret put OPENROUTER_KEY
# مثال: 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

# مدل هوش مصنوعی
wrangler secret put AI_MODEL
# مثال: nvidia/nemotron-3-ultra-550b-a55b:free
```

---

## فاز ۴: استقرار Worker (API)

```bash
# بررسی صحت
wrangler dev

# استقرار
wrangler deploy
```

### تنظیم Route برای API

در فایل `wrangler.toml`:
```toml
routes = [
  { pattern = "quiz26.dpdns.org/api/*", zone_name = "dpdns.org" }
]
```

یا از Dashboard:
- Workers → quiz26-api → Domains & Routes → Add Route
- Pattern: `quiz26.dpdns.org/api/*`

---

## فاز ۵: استقرار Frontend (Pages)

### روش ۱: از طریق Dashboard

1. به Cloudflare Pages بروید
2. Create a new project
3. نام: `quiz26`
4. Framework preset: None
5. Build command: خالی
6. Output directory: `/`
7. Upload فقط فایل‌های پوشه `quiz26/`:
   - `index.html`
   - `_redirects`
   - `_routes.json`
8. Custom domain: `quiz26.dpdns.org`

### روش ۲: با Wrangler

```bash
# آپلود از پوشه quiz26
wrangler pages deploy quiz26 --project-name=quiz26

# تنظیم دامنه
wrangler pages deployment create quiz26 --branch=main
```

---

## فاز ۷: تنظیم DNS

در Cloudflare DNS:
```
Type  Name              Content              Proxy
A     quiz26.dpdns.org  192.0.2.1 (مثلاً)    Proxied
CNAME deepseek          YOUR_TUNNEL_ID.cfargotunnel.com  Proxied
```

---

## فاز ۸: تست نهایی

1. باز کردن `https://quiz26.dpdns.org/#/login`
2. ساخت حساب اولین معلم
3. ساخت آزمون تستی
4. تست AI: تولید سوال با هوش مصنوعی
5. باز کردن لینک آزمون در مرورگر دیگر
6. شرکت در آزمون
7. بررسی کارنامه
8. تست تصحیح تشریحی با AI

---

## عیب‌یابی

### CORS Error
- Route Worker روی همان هاست باشد: `quiz26.dpdns.org/api/*`
- Origin در CORS_ORIGINS اضافه شده باشد

### AI کار نمی‌کند
- Tunnel فعال باشد: `cloudflared tunnel run quiz26-ai`
- DEEPSEEK_URL صحیح باشد: `https://deepseek.quiz26.dpdns.org/v1`
- DEEPSEEK_KEY تنظیم شده باشد

### SPA 404
- فایل `_redirects` در Pages منتشر شده باشد

### DB Error
- `schema.sql` روی D1 remote اجرا شده باشد
- database_id در wrangler.toml صحیح باشد

---

## ساختار فایل‌ها

```
quiz26-complete/
├── worker.js          # Cloudflare Worker (API + AI)
├── schema.sql         # D1 Database Schema
├── wrangler.toml      # تنظیمات Cloudflare
├── README.md          # مستندات کلی
├── DEPLOY.md          # این راهنما
└── quiz26/            # Frontend (Cloudflare Pages)
    ├── index.html     # SPA اصلی
    ├── _redirects     # مسیرهای SPA
    └── _routes.json   # فیلتر مسیرها
```
