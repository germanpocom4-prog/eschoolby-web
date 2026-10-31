/**
 * Telegram бот для электронного дневника e-schools.by
 * Версия с вебхуками для деплоя на Render
 */

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const qs = require('qs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || BOT_TOKEN === 'ВАШ_ТОКЕН_ОТ_BOTFATHER') {
  console.error('ОШИБКА: Укажите BOT_TOKEN в файле .env (получите у @BotFather)');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error('ОШИБКА: Укажите WEBHOOK_URL в файле .env (ссылка на ваш Render-сервис)');
  process.exit(1);
}

const DIARY_BASE = 'https://diary.e-schools.by';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const app = express();
app.use(express.json());

// Хранилище сессий пользователей: chatId -> { authToken, studentId, schoolId, schoolName }
const userSessions = new Map();
// Состояния при логине: chatId -> { step: 'awaiting_username' | 'awaiting_password', username?: string }
const userStates = new Map();

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ РАБОТЫ С diary.e-schools.by ============

function collectCookies(cookieHeader, headers) {
  const sc = headers['set-cookie'];
  if (!sc) return cookieHeader;
  const parsed = Array.isArray(sc) ? sc : [sc];
  for (const c of parsed) {
    const kv = c.split(';')[0].trim().split('=');
    if (kv.length === 2 && !cookieHeader.includes(`${kv[0]}=`)) {
      cookieHeader += `; ${kv[0]}=${kv[1]}`;
    }
  }
  return cookieHeader;
}

function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractInputs(html) {
  const inputs = {};
  const re = /<input[^>]+>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const nameM = tag.match(/name="([^"]+)"/);
    const typeM = tag.match(/type="([^"]*)"/i);
    const valM = tag.match(/value="([^"]*)"/);
    if (nameM) {
      let value = valM ? decodeHtmlEntities(valM[1]) : '';
      if (nameM[1] === 'Input.RememberLogin' && typeM && typeM[1] === 'checkbox') value = 'true';
      if (!(nameM[1] in inputs)) inputs[nameM[1]] = value;
    }
  }
  return inputs;
}

function getFormAction(html, pageUrl) {
  const formMatch = html.match(/<form[^>]+>/i);
  if (formMatch) {
    const actionMatch = formMatch[0].match(/action\s*=\s*["']([^"']*)["']/i);
    if (actionMatch) {
      try { return new URL(actionMatch[1], pageUrl).toString(); } catch (e) { return pageUrl; }
    }
  }
  return pageUrl;
}

function findDataParam(uri) {
  try {
    const url = new URL(uri);
    let data = url.searchParams.get('data');
    if (!data && url.hash) {
      const hp = new URLSearchParams(url.hash.replace(/^#/, '').split('?').pop());
      data = hp.get('data');
    }
    return data;
  } catch (e) { return null; }
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(normalized, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    }
  } catch (e) {}
  return {};
}

async function performLogin(username, password) {
  let cookieHeader = 'usr_type=student';
  const client = axios.create({
    headers: { 'User-Agent': UA },
    maxRedirects: 0,
    validateStatus: (s) => s < 500,
  });

  let r = await client.get(`${DIARY_BASE}/api/v1/admin/auth/login/student`, {
    headers: { Cookie: cookieHeader, 'Referer': 'https://diary.e-schools.by/' },
  });
  cookieHeader = collectCookies(cookieHeader, r.headers);

  let oauthUrl = r.headers['location']
    ? new URL(r.headers['location'], DIARY_BASE).toString()
    : `${DIARY_BASE}/api/v1/admin/auth/login/student`;

  r = await client.get(oauthUrl, {
    headers: { Cookie: cookieHeader, 'Referer': 'https://diary.e-schools.by/' },
  });
  cookieHeader = collectCookies(cookieHeader, r.headers);

  const html = r.data;
  const inputs = extractInputs(html);
  const postUrl = getFormAction(html, oauthUrl);

  const payload = { ...inputs };
  payload['Username'] = username;
  payload['Input.Username'] = username;
  payload['Password'] = password;
  payload['Input.Password'] = password;
  payload['RememberLogin'] = 'true';
  payload['Input.RememberLogin'] = 'true';
  payload['button'] = 'login';
  payload['Input.Button'] = 'login';

  r = await client.post(postUrl, qs.stringify(payload), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://oauth.rios.unibel.by',
      'Referer': oauthUrl,
      'Cookie': cookieHeader,
      'User-Agent': UA,
    },
  });
  cookieHeader = collectCookies(cookieHeader, r.headers);

  let dataUuid = null;
  let currentUrl = r.request._currentUrl || postUrl;
  let steps = 0;

  while (r.status >= 300 && r.status < 400 && steps < 8) {
    steps++;
    const loc = r.headers['location'];
    if (!loc) break;
    const nextUrl = new URL(loc, currentUrl).toString();

    const cand = findDataParam(nextUrl);
    if (cand && cand.length === 36 && cand.includes('-')) {
      dataUuid = cand;
      break;
    }

    cookieHeader = collectCookies(cookieHeader, r.headers);
    const isDiary = nextUrl.includes('e-schools.by');
    const headers = {
      'Cookie': cookieHeader,
      'Referer': 'https://diary.e-schools.by/',
      'User-Agent': UA,
    };
    if (isDiary) {
      headers['Origin'] = 'https://diary.e-schools.by';
    }

    r = await client.get(nextUrl, { headers });
    cookieHeader = collectCookies(cookieHeader, r.headers);
    currentUrl = nextUrl;
  }

  if (!dataUuid) {
    const cand = findDataParam(currentUrl);
    if (cand && cand.length === 36 && cand.includes('-')) dataUuid = cand;
  }

  if (!dataUuid) {
    throw new Error('Не удалось получить токен авторизации (возможно, неверный логин или пароль)');
  }

  r = await client.get(`${DIARY_BASE}/api/v1/admin/auth/data_for_login/${dataUuid}`, {
    headers: {
      Cookie: `usr_type=student; cvrf_id=${dataUuid}`,
      'Referer': 'https://diary.e-schools.by/',
      'User-Agent': UA,
    },
  });

  if (r.status !== 200) {
    throw new Error(`Ошибка загрузки профиля: HTTP ${r.status}`);
  }

  const profile = r.data;
  const studentId = String(profile.profile_id);
  const schoolId = String(profile.schools?.[0]?.id);
  const schoolName = String(profile.schools?.[0]?.name);

  if (!studentId || !schoolId) {
    throw new Error('Не удалось определить ученика и школу');
  }

  const tokenRaw = `${studentId}:${schoolId}:student`;
  const tokenB64 = Buffer.from(tokenRaw).toString('base64');

  r = await client.get(`${DIARY_BASE}/api/v1/auth/login?token=${tokenB64}`, {
    headers: {
      Cookie: `usr_type=student; cvrf_id=${dataUuid}`,
      'Referer': 'https://diary.e-schools.by/',
      'Origin': 'https://diary.e-schools.by',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': UA,
    },
  });

  const authToken = r.data?.auth_token;
  if (!authToken) {
    throw new Error('Сервер не вернул auth_token');
  }

  return { authToken, studentId, schoolId, schoolName };
}

async function fetchWeeks(authToken) {
  const client = axios.create({
    headers: {
      'User-Agent': UA,
      'Authorization': authToken,
      'Cookie': 'usr_type=student',
      'Accept': 'application/json, text/plain, */*',
    },
    maxRedirects: 0,
    validateStatus: (s) => s < 500,
  });

  const r = await client.get(`${DIARY_BASE}/api/v1/education/diary/time_activities/week_activities`);
  return Array.isArray(r.data) ? r.data : [];
}

async function fetchClass(authToken, studentId, schoolId, startTs) {
  const client = axios.create({
    headers: {
      'User-Agent': UA,
      'Authorization': authToken,
      'Cookie': 'usr_type=student',
      'Accept': 'application/json, text/plain, */*',
    },
    maxRedirects: 0,
    validateStatus: (s) => s < 500,
  });

  const fromDate = new Date(startTs);
  const toDate = new Date(fromDate.getTime() + 6 * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  const yearStart = fromDate.getMonth() >= 7 ? fromDate.getFullYear() : fromDate.getFullYear() - 1;
  const periodStr = `00000000-0000-${yearStart}-${yearStart + 1}-000000000000`;

  const r = await client.post(
    `${DIARY_BASE}/api/v1/education/diary/schools/${schoolId}/students/${studentId}/classes`,
    { from: fmt(fromDate), to: fmt(toDate), school_period: periodStr },
    { headers: { 'Content-Type': 'application/json', 'Referer': 'https://diary.e-schools.by/' } }
  );

  const classes = r.data?.classes || [];
  if (classes.length > 0) {
    const active = classes[0];
    return {
      classId: String(active.uuid || active.id || ''),
      className: String(active.class_number || `${active.level || ''}${active.label || ''}`),
    };
  }
  return { classId: '', className: '' };
}

async function fetchLessons(authToken, schoolId, classId, studentId, weekUuid) {
  const client = axios.create({
    headers: {
      'User-Agent': UA,
      'Authorization': authToken,
      'Cookie': 'usr_type=student',
      'Accept': 'application/json, text/plain, */*',
    },
    maxRedirects: 0,
    validateStatus: (s) => s < 500,
  });

  const r = await client.get(
    `${DIARY_BASE}/api/v1/education/diary/schools/${schoolId}/classes/${classId}/students/${studentId}/lessons`,
    { params: { week_activity_uuid: weekUuid } }
  );

  return Array.isArray(r.data) ? r.data : [];
}

// ============ ФОРМАТИРОВАНИЕ ДАННЫХ ============

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function formatDayFull(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}

function getMarkEmoji(mark) {
  const m = parseInt(mark);
  if (isNaN(m)) return '⚪';
  if (m >= 9) return '🟢';
  if (m >= 7) return '🟡';
  if (m >= 4) return '🔴';
  return '⚪';
}

// ============ КНОПКИ / МЕНЮ ============

const mainMenu = {
  reply_markup: {
    keyboard: [
      [{ text: '📅 Дневник на неделю' }, { text: '📚 Д/З на завтра' }],
      [{ text: '📊 Оценки за четверть' }, { text: '👤 Мой профиль' }],
      [{ text: '🔄 Обновить данные' }, { text: '🚪 Выйти' }],
    ],
    resize_keyboard: true,
  },
};

function getWelcomeMessage(firstName) {
  return `Привет, ${firstName || 'ученик'}! 👋

Я бот электронного дневника Школа.by.

Я могу показать:
📅 Расписание и дневник на неделю
📚 Домашнее задание
📊 Оценки и средний балл
👤 Информацию о профиле

Все данные подгружаются из diary.e-schools.by.

Нажмите /login чтобы войти под своим аккаунтом schools.by / e-schools.by.`;
}

// ============ ОБРАБОТЧИКИ КОМАНД ============

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || '';
  bot.sendMessage(chatId, getWelcomeMessage(firstName), mainMenu);
});

bot.onText(/\/login/, (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, { step: 'awaiting_username' });
  bot.sendMessage(chatId, 'Введите свой логин от schools.by / e-schools.by:');
});

bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  userSessions.delete(chatId);
  userStates.delete(chatId);
  bot.sendMessage(chatId, 'Вы вышли из аккаунта. Чтобы войти снова — нажмите /login', mainMenu);
});

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  userStates.delete(chatId);
  bot.sendMessage(chatId, 'Вход отменён.', mainMenu);
});

bot.onText(/\/diary/, async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  if (!session) {
    bot.sendMessage(chatId, 'Сначала войдите через /login', mainMenu);
    return;
  }

  try {
    const weeks = await fetchWeeks(session.authToken);
    if (!weeks.length) {
      bot.sendMessage(chatId, 'Не удалось загрузить учебные недели.', mainMenu);
      return;
    }

    const now = Date.now();
    let currentWeek = weeks.find(w => {
      const end = (weeks.indexOf(w) < weeks.length - 1) ? weeks[weeks.indexOf(w) + 1].start_ts : w.start_ts + 7 * 24 * 60 * 60 * 1000;
      return now >= w.start_ts && now < end;
    }) || weeks[weeks.length - 1];

    const classInfo = await fetchClass(session.authToken, session.studentId, session.schoolId, currentWeek.start_ts);
    if (!classInfo.classId) {
      bot.sendMessage(chatId, 'Не удалось определить класс.', mainMenu);
      return;
    }

    const lessons = await fetchLessons(session.authToken, session.schoolId, classInfo.classId, session.studentId, currentWeek.uuid);

    let text = `📅 <b>Дневник: ${currentWeek.summary || 'Учебная неделя'}</b>\n`;
    text += `<b>Класс:</b> ${classInfo.className}\n\n`;

    for (const day of lessons) {
      const dayName = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][new Date(day.date).getDay()];
      text += `<b>${dayName}, ${formatDate(day.date)}</b>\n`;
      if (!day.slots || day.slots.length === 0) {
        text += 'Уроков нет\n\n';
        continue;
      }
      for (const slot of day.slots) {
        const markInfo = slot.lesson_mark || {};
        const mark = markInfo.mark != null ? String(markInfo.mark) : '';
        const homework = slot.homework ? ` 📝 ДЗ: ${slot.homework}` : '';
        text += `  ${slot.number}. ${slot.subject_title} ${mark ? getMarkEmoji(mark) + ' ' + mark : ''}${homework}\n`;
      }
      text += '\n';
    }

    bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...mainMenu });
  } catch (e) {
    bot.sendMessage(chatId, `Ошибка: ${e.message}`, mainMenu);
  }
});

bot.onText(/\/grades/, async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  if (!session) {
    bot.sendMessage(chatId, 'Сначала войдите через /login', mainMenu);
    return;
  }

  try {
    const weeks = await fetchWeeks(session.authToken);
    if (!weeks.length) {
      bot.sendMessage(chatId, 'Не удалось загрузить недели.', mainMenu);
      return;
    }

    const now = Date.now();
    let currentWeek = weeks.find(w => {
      const end = (weeks.indexOf(w) < weeks.length - 1) ? weeks[weeks.indexOf(w) + 1].start_ts : w.start_ts + 7 * 24 * 60 * 60 * 1000;
      return now >= w.start_ts && now < end;
    }) || weeks[weeks.length - 1];

    const classInfo = await fetchClass(session.authToken, session.studentId, session.schoolId, currentWeek.start_ts);
    if (!classInfo.classId) {
      bot.sendMessage(chatId, 'Не удалось определить класс.', mainMenu);
      return;
    }

    const allDays = [];
    for (let i = 0; i <= weeks.indexOf(currentWeek); i++) {
      const lessons = await fetchLessons(session.authToken, session.schoolId, classInfo.classId, session.studentId, weeks[i].uuid);
      allDays.push(...lessons);
    }

    const subjects = {};
    let totalMarks = 0;
    let sumMarks = 0;

    for (const day of allDays) {
      if (!day.slots) continue;
      for (const slot of day.slots) {
        const markInfo = slot.lesson_mark || {};
        const mark = markInfo.mark != null ? String(markInfo.mark) : '';
        const m = parseInt(mark);
        if (!isNaN(m)) {
          if (!subjects[slot.subject_title]) subjects[slot.subject_title] = [];
          subjects[slot.subject_title].push(m);
          totalMarks++;
          sumMarks += m;
        }
      }
    }

    let text = `📊 <b>Оценки за четверть</b>\n`;
    text += `<b>Школа:</b> ${session.schoolName}\n`;
    text += `<b>Класс:</b> ${classInfo.className}\n`;
    text += `<b>Всего оценок:</b> ${totalMarks}\n`;
    text += `<b>Средний балл:</b> ${totalMarks > 0 ? (sumMarks / totalMarks).toFixed(2) : '—'}\n\n`;

    const sortedSubjects = Object.keys(subjects).sort();
    for (const subj of sortedSubjects) {
      const marks = subjects[subj];
      const avg = (marks.reduce((a, b) => a + b, 0) / marks.length).toFixed(1);
      const marksStr = marks.map(m => `${getMarkEmoji(m)} ${m}`).join(' ');
      text += `<b>${subj}</b>: ${marksStr} (ср. ${avg})\n`;
    }

    bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...mainMenu });
  } catch (e) {
    bot.sendMessage(chatId, `Ошибка: ${e.message}`, mainMenu);
  }
});

bot.onText(/\/homework/, async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  if (!session) {
    bot.sendMessage(chatId, 'Сначала войдите через /login', mainMenu);
    return;
  }

  try {
    const weeks = await fetchWeeks(session.authToken);
    if (!weeks.length) {
      bot.sendMessage(chatId, 'Не удалось загрузить недели.', mainMenu);
      return;
    }

    const now = Date.now();
    let currentWeek = weeks.find(w => {
      const end = (weeks.indexOf(w) < weeks.length - 1) ? weeks[weeks.indexOf(w) + 1].start_ts : w.start_ts + 7 * 24 * 60 * 60 * 1000;
      return now >= w.start_ts && now < end;
    }) || weeks[weeks.length - 1];

    const classInfo = await fetchClass(session.authToken, session.studentId, session.schoolId, currentWeek.start_ts);
    if (!classInfo.classId) {
      bot.sendMessage(chatId, 'Не удалось определить класс.', mainMenu);
      return;
    }

    const lessons = await fetchLessons(session.authToken, session.schoolId, classInfo.classId, session.studentId, currentWeek.uuid);

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDow = tomorrow.getDay() === 0 ? 7 : tomorrow.getDay();

    const day = lessons.find(d => {
      const dDate = new Date(d.date || Date.now());
      const dDow = dDate.getDay || 7;
      return dDow === targetDow;
    });

    let text = `📚 <b>Домашнее задание на ${tomorrow.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</b>\n\n`;

    if (!day || !day.slots || day.slots.length === 0) {
      text += 'Завтра уроков нет.';
    } else {
      const hwTasks = day.slots.filter(s => s.homework && s.homework.trim());
      if (hwTasks.length === 0) {
        text += 'Домашнего задания нет.';
      } else {
        for (const s of hwTasks) {
          text += `• <b>${s.subject_title}</b> (урок ${s.number})\n`;
          text += `  ${s.homework}\n\n`;
        }
      }
    }

    bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...mainMenu });
  } catch (e) {
    bot.sendMessage(chatId, `Ошибка: ${e.message}`, mainMenu);
  }
});

// ============ ОБРАБОТКА КНОПОК И ТЕКСТОВЫХ СООБЩЕНИЙ ============

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text && text.startsWith('/')) return;

  const state = userStates.get(chatId);
  if (state && state.step === 'awaiting_username') {
    userStates.set(chatId, { step: 'awaiting_password', username: text });
    bot.sendMessage(chatId, 'Введите пароль:');
    return;
  }

  if (state && state.step === 'awaiting_password') {
    const username = state.username;
    const password = text;
    userStates.delete(chatId);

    const statusMsg = await bot.sendMessage(chatId, '🔄 Выполняю вход в дневник... подождите');

    try {
      const session = await performLogin(username, password);
      userSessions.set(chatId, session);

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      bot.sendMessage(
        chatId,
        `✅ Вход выполнен!\n\n<b>${session.schoolName}</b>\nКласс будет определен при загрузке дневника.\n\nТеперь выберите, что показать:`,
        { parse_mode: 'HTML', ...mainMenu }
      );
    } catch (e) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      bot.sendMessage(chatId, `❌ Ошибка входа: ${e.message}\n\nПопробуйте ещё раз: /login`, mainMenu);
    }
    return;
  }

  if (text === '📅 Дневник на неделю') {
    const fakeMsg = { ...msg, text: '/diary' };
    bot.handleUpdate({ message: fakeMsg, update_id: 0 });
    return;
  }
  if (text === '📚 Д/З на завтра') {
    const fakeMsg = { ...msg, text: '/homework' };
    bot.handleUpdate({ message: fakeMsg, update_id: 0 });
    return;
  }
  if (text === '📊 Оценки за четверть') {
    const fakeMsg = { ...msg, text: '/grades' };
    bot.handleUpdate({ message: fakeMsg, update_id: 0 });
    return;
  }
  if (text === '👤 Мой профиль') {
    const session = userSessions.get(chatId);
    if (!session) {
      bot.sendMessage(chatId, 'Сначала войдите через /login', mainMenu);
      return;
    }
    bot.sendMessage(
      chatId,
      `👤 <b>Профиль</b>\n\nШкола: ${session.schoolName}\nУченик ID: ${session.studentId}\nШкола ID: ${session.schoolId}`,
      { parse_mode: 'HTML', ...mainMenu }
    );
    return;
  }
  if (text === '🔄 Обновить данные') {
    const fakeMsg = { ...msg, text: '/diary' };
    bot.handleUpdate({ message: fakeMsg, update_id: 0 });
    return;
  }
  if (text === '🚪 Выйти') {
    const fakeMsg = { ...msg, text: '/logout' };
    bot.handleUpdate({ message: fakeMsg, update_id: 0 });
    return;
  }
});

// ============ ВЕБХУК ДЛЯ RENDER ============

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check для Render
app.get('/', (req, res) => {
  res.send('Eschoolby Telegram Bot is running');
});

async function start() {
  try {
    await bot.setWebHook(`${WEBHOOK_URL}/webhook`);
    console.log(`✅ Webhook установлен: ${WEBHOOK_URL}/webhook`);
  } catch (e) {
    console.error('❌ Ошибка установки вебхука:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`🤖 Бот запущен на порту ${PORT}`);
    console.log(`Вебхук URL: ${WEBHOOK_URL}/webhook`);
  });
}

start().catch((err) => {
  console.error('Ошибка запуска бота:', err);
  process.exit(1);
});
