<div align="center">

# 🎓 Quiz26

### سامانه حرفه‌ای آزمون آنلاین هوشمند برای مدارس ایران

**پایه‌های هفتم، هشتم و نهم · هوش مصنوعی · کارنامه لوکس PDF · ضدتقلب**

[![Live Demo](https://img.shields.io/badge/🌐_لایو-quiz26.dpdns.org-10b981?style=for-the-badge&labelColor=0f172a)](https://quiz26.dpdns.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white&labelColor=0f172a)](https://workers.cloudflare.com)
[![D1 Database](https://img.shields.io/badge/D1-SQLite-4f46e5?style=for-the-badge&labelColor=0f172a)](https://developers.cloudflare.com/d1/)
[![License](https://img.shields.io/badge/License-MIT-8b5cf6?style=for-the-badge&labelColor=0f172a)](LICENSE)

</div>

---

<div align="center">

| ✨ | ویژگی شاخص |
|:-:|:---|
| 🤖 | **تولید خودکار سوال با AI** — از کتاب درسی ایران، فصل‌به‌فصل |
| 📄 | **کارنامه PDF لوکس** — تم سرمه‌ای، مهر GRADE طلایی، چندصفحه‌ای |
| ⏳ | **انتشار کارنامه با تأخیر** — مخفی تا پایان مهلت آزمون |
| 🔐 | **ضدتقلب** — رصد ترک تب، مسدود کپی، تمام‌صفحه |
| 🇮🇷 | **کاملاً فارسی** — تاریخ شمسی، RTL، اعداد فارسی |

</div>

## 📸 نگاهی به محصول

<div align="center">

| لندینگ مدرن با تم شیشه‌ای | پنل معلم با آمار زنده |
|:---:|:---:|
| 🖼️ Liquid Glass + Blobs متحرک | 📊 داشبورد، بانک سوال، حضور و غیاب |

| کارنامه PDF با مهر GRADE | آزمون امن دانش‌آموز |
|:---:|:---:|
| 🏆 قابل دانلود و چاپ | ⏱️ تایمر، پالت سوال، نشان‌گذاری |

</div>

## 🚀 امکانات کامل

### 👨‍🏫 برای معلم

- **آزمون‌ساز** — ۵ نوع سوال (تستی، چندجوابی، ص/غ، کوتاه، تشریحی) + LaTeX + تصویر/ویدیو پیوست
- **تولید انبوه با AI** — انتخاب پایه → درس → فصل از برنامهٔ درسی رسمی، تا ۲۰۰ سوال یک‌جا
- **بانک سوال هوشمند** — فیلتر پایه/درس/فصل/سطح (تا المپیادی) + چاپ
- **انتشار کارنامه با تأخیر** ⏳ — دانش‌آموز تا پایان تاریخ تنظیمی نمره‌اش را نمی‌بیند
- **تصحیح تشریحی با AI** — نمره‌دهی خودکار با بازخورد فارسی
- **تحلیل آزمون با AI** — سوالات سخت، پیشنهاد بهبود، دانش‌آموزان در خطر
- **حضور و غیاب** — آمار زنده + تاریخچه
- **تکالیف** — با تحویل فایل و تصحیح
- **حساب دانش‌آموزی** — ساخت دسته‌ای یوزر/پسورد برای آزمون‌های محرمانه
- **پشتیبان‌گیری کامل** — خروجی JSON با یادآوری هفتگی

### 🎒 برای دانش‌آموز

- ورود با **شماره موبایل به‌عنوان شناسه کارنامه** 📱
- تایمر هوشمند با هشدار صوتی و رنگی
- **پالت سوالات** — پاسخ‌داده / نشان‌دار / بی‌پاسخ
- **مرور قبل از تحویل** + کیبورد شورتکات (۱-۹، فلش‌ها، Space)
- **ذخیره خودکار** — برق قطع شد؟ ادامه از همان سوال
- **دانلود کارنامه PDF** با تم لوکس
- مشاهده مجدد کارنامه بعد از پایان آزمون با شماره

## 🧱 معماری

```
quiz26.dpdns.org
├── Cloudflare Pages ──── index.html (SPA تک‌فایل، بدون build)
├── Cloudflare Worker ─── worker.js (REST API کامل)
└── Cloudflare D1 ─────── SQLite (۹ جدول، مهاجرت خودکار)
```

<div align="center">

**Cloudflare Pages** + **Workers** + **D1** + **Workers AI (Llama 3.1)**

`صفر هزینه سرور` · `بدون دیتابیس خارجی` · `TLS خودکار` · `CDN جهانی`

</div>

## ⚙️ دیپلوی سریع

```bash
# ۱. نصب Wrangler
npm install -g wrangler && wrangler login

# ۲. ساخت دیتابیس D1
wrangler d1 create quiz26-db
wrangler d1 execute quiz26-db --remote --file=schema.sql

# ۳. دیپلوی API
wrangler deploy
wrangler secret put JWT_SECRET

# ۴. دیپلوی فرانت‌اند
wrangler pages deploy quiz26 --project-name=quiz26
```

### متغیرهای محیطی (Secrets)

| کلید | توضیح | الزامی |
|------|-------|:------:|
| `JWT_SECRET` | کلید امضای توکن‌ها (قوی انتخاب کنید) | ✅ |
| `OPENROUTER_KEY` | fallback هوش مصنوعی (اختیاری) | ➖ |

> 💡 اولین کاربر که ثبت‌نام کند، مالک سامانه می‌شود.

## 🗂️ ساختار پروژه

```
quiz26-complete/
├── quiz26/                  # فرانت‌اند (Pages)
│   ├── index.html           # کل اپلیکیشن — تک‌فایل، RTL، دارک/لایت
│   ├── _redirects           # SPA fallback
│   └── _routes.json         # مسیریابی API
├── worker.js                # بک‌اند کامل (REST + AI + Auth)
├── schema.sql               # اسکیمای D1
├── migrations/              # مهاجرت‌های افزونه‌ای
└── wrangler.toml            # تنظیمات Cloudflare
```

## 🔒 امنیت

- رمزها با **PBKDF2** (۱۰۰,۰۰۰ تکرار + salt) هش می‌شوند
- JWT با **HS256** و انقضای ۷ روزه
- هر معلم فقط به **داده‌های خودش** دسترسی دارد (جداسازی در سطح کوئری)
- escape همه‌جانبهٔ XSS + کلید کارنامه با نرمال‌سازی شماره

## 📊 آمار پروژه

| | |
|---|---|
| 📦 حجم فرانت‌اند | ~۲۴۰KB (تک‌فایل) |
| 🛣️ تعداد API Endpoint | ۴۵+ |
| 🗄️ جداول دیتابیس | ۹ |
| 🤖 مدل AI | Llama 3.1 70B (رایگان Cloudflare) |
| 🌍 زبان‌ها | فارسی (RTL) |

---

<div align="center">

**ساخته شده با 💚 توسط [BardiaLT](https://github.com/bardialt)**

⭐ اگر مفید بود، ستاره بدهید!

</div>
