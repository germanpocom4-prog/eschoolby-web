# Telegram бот электронного дневника e-schools.by (webhook для Render)

Бот подключается к `diary.e-schools.by` и отправляет пользователям в Telegram:
- дневник на неделю
- домашнее задание на завтра
- оценки за четверть со средним баллом
- профиль ученика

## Как запустить на Render (бесплатно, постоянно)

### 1. Создайте бота в Telegram
Напишите [@BotFather](https://t.me/botfather) в Telegram:
- `/newbot` → придумайте имя и username (например, `eschoolby_bot`)
- Скопируйте полученный **HTTP API токен**

### 2. Создайте отдельный веб-сервис на Render
1. Зайдите на [render.com](https://render.com) и войдите.
2. Нажмите **New + → Web Service**.
3. Подключите GitHub-репозиторий `germanpocom4-prog/eschoolby-web`.
4. Настройте:
   - **Runtime**: `Node`
   - **Root Directory**: `telegram-bot` (важно! бот в подпапке)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Добавьте переменные окружения (Environment Variables):
   - `BOT_TOKEN` — ваш токен от @BotFather
   - `WEBHOOK_URL` — ссылка на этот сервис на Render (например, `https://eschoolby-bot.onrender.com`)
6. Нажмите **Create Web Service**.

### 3. Установите вебхук (автоматически)
При первом запуске бот сам вызовет `setWebHook` и Telegram начнёт слать обновления на ваш Render-сервис.

### 4. Пользуйтесь
Напишите своему боту в Telegram:
- `/start` — приветствие и меню
- `/login` — вход под своим аккаунтом schools.by / e-schools.by
- `/diary` — дневник на неделю
- `/homework` — Д/З на завтра
- `/grades` — оценки за четверть
- `/profile` — профиль
- `/logout` — выход

## Важно

- **Бесплатный Render засыпает после 15 минут без посетителей.** Первый запрос к боту после простоя может идти 10–30 секунд (холодный старт), потом работает быстро.
- Бот работает круглосуточно (пока Render не убрали бесплатный тариф).
- Пароли не хранятся постоянно — только в памяти пока пользователь не выйдет.

## Локальный запуск (для теста)

```powershell
cd "C:\Users\germa\OneDrive\Документы\eschoolby-web\telegram-bot"
copy .env.example .env
# отредактируйте .env: вставьте BOT_TOKEN и WEBHOOK_URL
npm install
node bot.js
```

Локально вебхук не будет работать без публичного URL, для теста можно использовать ngrok или Cloudflare Tunnel.
