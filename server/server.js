const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DIARY_BASE = 'https://diary.e-schools.by';
const OAUTH_LOGIN_URL = 'https://diary.e-schools.by/api/v1/admin/auth/login/student';

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  genid: () => uuidv4(),
  secret: 'eschoolby-web-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
// Отключаем кэш для index.html (чтобы изменения CSS применялись сразу)
app.use(function(req, res, next) {
  if (req.path === '/' || req.path.endsWith('index.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '../public')));

// ----- Вспомогательные функции -----

function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&nbsp;/g, ' ');
}

function extractInputs(html) {
  const inputs = {};
  const inputRegex = /<input[^>]+>/gi;
  let match;
  while ((match = inputRegex.exec(html)) !== null) {
    const tag = match[0];
    const nameMatch = tag.match(/name=["']([^"']+)["']/);
    const typeMatch = tag.match(/type=["']([^"']+)["']/i);
    const valueMatch = tag.match(/value=["']([^"']*)["']/);
    if (nameMatch) {
      const name = nameMatch[1];
      const type = typeMatch ? typeMatch[1] : 'text';
      let value = valueMatch ? valueMatch[1] : '';
      value = decodeHtmlEntities(value);
      if (name === 'Input.RememberLogin' && type === 'checkbox') {
        inputs[name] = 'true';
      } else if (!(name in inputs)) {
        inputs[name] = value;
      }
    }
  }
  return inputs;
}

function getFormAction(html, pageUrl) {
  const formMatch = html.match(/<form[^>]+>/i);
  if (formMatch) {
    const actionMatch = formMatch[0].match(/action\s*=\s*["']([^"']*)["']/i);
    if (actionMatch) {
      return new URL(actionMatch[1], pageUrl).toString();
    }
  }
  return pageUrl;
}

function findDataParam(uri) {
  try {
    const urlObj = new URL(uri);
    let data = urlObj.searchParams.get('data');
    if (!data && urlObj.hash) {
      const hashPart = urlObj.hash.replace(/^#/, '').split('?').pop();
      const hashParams = new URLSearchParams(hashPart);
      data = hashParams.get('data');
    }
    return data;
  } catch (e) {
    return null;
  }
}

function base64UrlDecode(str) {
  try {
    return Buffer.from(str, 'base64').toString('utf-8');
  } catch (e) {
    return str;
  }
}

// ----- Вход -----
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }

  try {
    // Куки, которые будем передавать по цепочке запросов
    let cookieHeader = 'usr_type=student';

    // Шаг 1: запросить форму авторизации (редирект на OAuth)
    console.log('[1/5] Запрос формы авторизации...');
    const startResp = await axios.get(OAUTH_LOGIN_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': cookieHeader,
        'Referer': 'https://diary.e-schools.by/',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });

    // Сохранить Set-Cookie из первого ответа
    const startCookies = startResp.headers['set-cookie'];
    if (startCookies) {
      const parsed = Array.isArray(startCookies) ? startCookies : [startCookies];
      for (const c of parsed) {
        const kv = c.split(';')[0].trim().split('=');
        if (kv.length === 2) cookieHeader += `; ${kv[0]}=${kv[1]}`;
      }
    }

    let oauthUrl;
    if (startResp.status >= 300 && startResp.status < 400) {
      const loc = startResp.headers['location'];
      if (!loc) throw new Error('Не получен адрес страницы входа OAuth');
      oauthUrl = new URL(loc, DIARY_BASE).toString();
    } else {
      oauthUrl = OAUTH_LOGIN_URL;
    }

    // Шаг 2: загрузить HTML форму входа
    console.log('[*] Загрузка HTML формы входа:', oauthUrl);
    const formResp = await axios.get(oauthUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': cookieHeader,
        'Referer': 'https://diary.e-schools.by/',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });

    const formCookies = formResp.headers['set-cookie'];
    if (formCookies) {
      const parsed = Array.isArray(formCookies) ? formCookies : [formCookies];
      for (const c of parsed) {
        const kv = c.split(';')[0].trim().split('=');
        if (kv.length === 2) cookieHeader += `; ${kv[0]}=${kv[1]}`;
      }
    }

    const html = formResp.data;
    const inputs = extractInputs(html);
    const postUrl = getFormAction(html, oauthUrl);

    const payload = { ...inputs };
    // Добавляем все поля как в Flutter приложении
    payload['Username'] = username;
    payload['Input.Username'] = username;
    payload['Password'] = password;
    payload['Input.Password'] = password;
    payload['RememberLogin'] = 'true';
    payload['Input.RememberLogin'] = 'true';
    payload['button'] = 'login';
    payload['Input.Button'] = 'login';

    console.log('[2/5] Отправка учетных данных на', postUrl);

    let currentResp = await axios.post(postUrl, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://oauth.rios.unibel.by',
        'Referer': oauthUrl,
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });

    const postCookies = currentResp.headers['set-cookie'];
    if (postCookies) {
      const parsed = Array.isArray(postCookies) ? postCookies : [postCookies];
      for (const c of parsed) {
        const kv = c.split(';')[0].trim().split('=');
        if (kv.length === 2) cookieHeader += `; ${kv[0]}=${kv[1]}`;
      }
    }

    // Шаг 3: следовать редиректам, пока не найдем токен data
    let dataUuid = null;
    let redirectSteps = 0;

    while (currentResp.status >= 300 && currentResp.status < 400 && redirectSteps < 10) {
      redirectSteps++;
      const location = currentResp.headers['location'];
      console.log(`[Редирект #${redirectSteps}] (HTTP ${currentResp.status}) ->`, location);
      if (!location) break;

      const nextUri = new URL(location, currentResp.request._currentUrl || postUrl).toString();

      const candidateData = findDataParam(nextUri);

      if (candidateData) {
        // Проверить на ошибку
        if (nextUri.includes('error')) {
          try {
            const decoded = base64UrlDecode(candidateData);
            console.log('[-] Ошибка от сервера:', decoded);
            throw new Error(decoded);
          } catch (e) {
            if (!(e instanceof Error && e.message.includes('Invalid'))) throw e;
          }
        }

        if (candidateData.length === 36 && candidateData.includes('-')) {
          dataUuid = candidateData;
          console.log('[+] Токен data получен:', dataUuid);
          break;
        }
      }

      // Обновить куки из ответа
      const stepCookies = currentResp.headers['set-cookie'];
      if (stepCookies) {
        const parsed = Array.isArray(stepCookies) ? stepCookies : [stepCookies];
        for (const c of parsed) {
          const kv = c.split(';')[0].trim().split('=');
          if (kv.length === 2) cookieHeader += `; ${kv[0]}=${kv[1]}`;
        }
      }

      currentResp = await axios.get(nextUri, {
        headers: {
          'Cookie': cookieHeader,
          'Referer': 'https://diary.e-schools.by/',
          'Origin': 'https://diary.e-schools.by',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        maxRedirects: 0,
        validateStatus: (s) => s < 500,
      });

      const stepCookies2 = currentResp.headers['set-cookie'];
      if (stepCookies2) {
        const parsed = Array.isArray(stepCookies2) ? stepCookies2 : [stepCookies2];
        for (const c of parsed) {
          const kv = c.split(';')[0].trim().split('=');
          if (kv.length === 2) cookieHeader += `; ${kv[0]}=${kv[1]}`;
        }
      }
    }

    if (!dataUuid) {
      const finalCandidate = findDataParam(currentResp.request._currentUrl || postUrl);
      if (finalCandidate && finalCandidate.length === 36 && finalCandidate.includes('-')) {
        dataUuid = finalCandidate;
      }
    }

    if (!dataUuid) {
      // Попробовать найти ошибку в HTML
      if (typeof currentResp.data === 'string') {
        const alertMatch = currentResp.data.match(/class="(validation-summary-errors|alert-danger|field-validation-error)"[^>]*>(.*?)<\/[^>]+>/s);
        if (alertMatch && alertMatch[2].trim()) {
          throw new Error(alertMatch[2].replace(/<[^>]+>/g, ' ').trim());
        }
      }
      throw new Error('Неверный логин или пароль');
    }

    // Шаг 4: запрос данных профиля
    console.log('[3/5] Запрос данных профиля (data_for_login)...');
    const dataResp = await axios.get(`https://diary.e-schools.by/api/v1/admin/auth/data_for_login/${dataUuid}`, {
      headers: {
        'Cookie': `usr_type=student; cvrf_id=${dataUuid}`,
        'Referer': 'https://diary.e-schools.by/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });

    if (dataResp.status !== 200) {
      throw new Error(`Ошибка загрузки данных профиля: ${dataResp.status}`);
    }

    const loginData = dataResp.data;
    const studentId = String(loginData.profile_id || loginData.student_id || '');
    const schools = loginData.schools || [];
    const schoolId = String(schools[0]?.id || '');
    const schoolName = String(schools[0]?.name || '');
    console.log('[+] Профиль: studentId=' + studentId + ', школа="' + schoolName + '"');

    // Шаг 5: обмен Base64 на JWT auth_token
    console.log('[4/5] Обмен Base64 на JWT auth_token...');
    const tokenRaw = `${studentId}:${schoolId}:student`;
    const tokenB64 = Buffer.from(tokenRaw).toString('base64');

    const exchangeResp = await axios.get(`https://diary.e-schools.by/api/v1/auth/login?token=${tokenB64}`, {
      headers: {
        'Referer': 'https://diary.e-schools.by/',
        'Origin': 'https://diary.e-schools.by',
        'Cookie': `usr_type=student; cvrf_id=${dataUuid}`,
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });

    const authToken = exchangeResp.data?.auth_token;
    if (!authToken) {
      throw new Error('Сервер не вернул auth_token: ' + JSON.stringify(exchangeResp.data));
    }

    // Декодировать JWT claims
    let jwtClaims = {};
    try {
      const parts = authToken.split('.');
      if (parts.length >= 2) {
        const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(payloadB64, 'base64').toString('utf-8');
        jwtClaims = JSON.parse(decoded);
      }
    } catch (e) {
      console.log('[!] Ошибка декодирования JWT:', e.message);
    }
    console.log('[DEBUG JWT CLAIMS]', JSON.stringify(jwtClaims));
    console.log('[5/5] Вход успешен! JWT auth_token получен.');

    // Сохранить в сессии
    req.session.authToken = authToken;
    req.session.studentId = studentId;
    req.session.schoolId = schoolId;
    req.session.schoolName = schoolName;
    req.session.username = username;
    req.session.password = password;
    req.session.loginData = loginData;
    req.session.jwtClaims = jwtClaims;
    req.session.dataUuid = dataUuid;

    // Извлечь ФИО из JWT
    let firstName = (jwtClaims.given_name || jwtClaims.name || '').toString().trim();
    let lastName = (jwtClaims.family_name || '').toString().trim();
    let middleName = (jwtClaims.middle_name || '').toString().trim();

    res.json({
      authToken,
      studentId,
      schoolId,
      schoolName,
      firstName,
      lastName,
      middleName,
      loginData,
      jwtClaims,
    });
  } catch (err) {
    console.error('[!] Ошибка входа:', err.message);
    res.status(401).json({ error: err.message || 'Не удалось войти' });
  }
});

// ----- Проверка авторизации -----
function requireAuth(req, res, next) {
  if (!req.session.authToken) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  next();
}

// ----- Прокси: учебные недели -----
app.get('/api/weeks', requireAuth, async (req, res) => {
  try {
    const resp = await axios.get(`${DIARY_BASE}/api/v1/education/diary/time_activities/week_activities`, {
      headers: {
        'Authorization': req.session.authToken,
        'Cookie': 'usr_type=student',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });
    res.json(resp.data);
  } catch (err) {
    console.error('[!] fetchWeeks:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----- Прокси: класс ученика -----
app.post('/api/class', requireAuth, async (req, res) => {
  const { schoolId, studentId, startTs } = req.body;
  if (!schoolId || !studentId || startTs == null) {
    return res.status(400).json({ error: 'Необходимы schoolId, studentId, startTs' });
  }

  const fromDate = new Date(startTs);
  const toDate = new Date(fromDate.getTime() + 6 * 24 * 60 * 60 * 1000);
  const yearStart = fromDate.getMonth() >= 7 ? fromDate.getFullYear() : fromDate.getFullYear() - 1;
  const yearEnd = yearStart + 1;
  const periodStr = `00000000-0000-${yearStart}-${yearEnd}-000000000000`;

  const pad = (n) => String(n).padStart(2, '0');
  const formatDate = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;

  try {
    const resp = await axios.post(`${DIARY_BASE}/api/v1/education/diary/schools/${schoolId}/students/${studentId}/classes`, {
      from: formatDate(fromDate),
      to: formatDate(toDate),
      school_period: periodStr,
    }, {
      headers: {
        'Authorization': req.session.authToken,
        'Cookie': 'usr_type=student',
        'Content-Type': 'application/json',
        'Referer': 'https://diary.e-schools.by/',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });

    if (resp.status === 200 && resp.data.classes) {
      const classes = resp.data.classes;
      if (classes.length > 0) {
        const active = classes[0];
        const cId = String(active.uuid || active.id || '');
        const cName = String(active.class_number || `${active.level || ''}${active.label || ''}`);
        console.log('[+] Класс:', cName, '(' + cId + ')');
        return res.json({ classId: cId, className: cName });
      }
    }
    res.json({ classId: '', className: '' });
  } catch (err) {
    console.error('[!] fetchClass:', err.message);
    res.json({ classId: '', className: '' });
  }
});

// ----- Прокси: список учеников класса -----
app.get('/api/class-students', requireAuth, async (req, res) => {
  const { schoolId, classId } = req.query;
  if (!schoolId || !classId) {
    return res.status(400).json({ error: 'Необходимы schoolId, classId' });
  }

  try {
    const resp = await axios.get(`${DIARY_BASE}/api/v1/education/diary/schools/${schoolId}/classes/${classId}/students`, {
      headers: {
        'Authorization': req.session.authToken,
        'Cookie': 'usr_type=student',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });

    if (resp.status === 200 && Array.isArray(resp.data)) {
      return res.json(resp.data);
    }
    res.json([]);
  } catch (err) {
    console.error('[!] fetchClassStudents:', err.message);
    res.json([]);
  }
});

// ----- Прокси: уроки на неделю -----
app.get('/api/lessons', requireAuth, async (req, res) => {
  const { schoolId, classId, studentId, weekUuid } = req.query;
  if (!schoolId || !classId || !studentId || !weekUuid) {
    return res.status(400).json({ error: 'Необходимы schoolId, classId, studentId, weekUuid' });
  }

  try {
    const resp = await axios.get(`${DIARY_BASE}/api/v1/education/diary/schools/${schoolId}/classes/${classId}/students/${studentId}/lessons`, {
      params: { week_activity_uuid: weekUuid },
      headers: {
        'Authorization': req.session.authToken,
        'Cookie': 'usr_type=student',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });

    if (resp.status === 200 && Array.isArray(resp.data)) {
      return res.json(resp.data);
    }
    res.json([]);
  } catch (err) {
    console.error('[!] fetchLessons:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----- Прокси: профиль -----
app.get('/api/profile', requireAuth, (req, res) => {
  res.json({
    studentId: req.session.studentId,
    schoolId: req.session.schoolId,
    schoolName: req.session.schoolName,
    username: req.session.username,
    firstName: req.session.firstName || '',
    lastName: req.session.lastName || '',
    middleName: req.session.middleName || '',
    jwtClaims: req.session.jwtClaims,
    loginData: req.session.loginData,
  });
});

// ----- Выход -----
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ----- Статус авторизации -----
app.get('/api/auth-status', (req, res) => {
  res.json({
    authenticated: !!req.session.authToken,
    studentId: req.session.studentId || null,
    schoolId: req.session.schoolId || null,
    schoolName: req.session.schoolName || null,
    username: req.session.username || null,
  });
});

app.listen(PORT, () => {
  console.log(`eSchoolBY Web server running on http://localhost:${PORT}`);
});
