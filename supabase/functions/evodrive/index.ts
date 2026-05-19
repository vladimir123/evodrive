// Supabase Edge Function — Evodrive shift auto-booking
// Запускается каждый день в 00:00 по Риге
// Отвечает 200 сразу, бронирование происходит в фоне

// ─── РАСПИСАНИЕ — настраивай здесь ───────────────────────────────────────────
//
//  station_id     — ID станции
//  start_time     — время начала в формате "HH:MM" (24ч)
//  duration_hours — длительность смены в часах
//  skip: true     — этот день недели не бронируем
//
// ─── РАСПИСАНИЕ ───────────────────────────────────────────────────────────────
const SCHEDULE: Record<string, {
  station_id: number;
  start_time: string;
  duration_hours: number;
  skip: boolean;
}> = {
  monday:    { station_id: 23, start_time: "19:00", duration_hours: 5, skip: false },
  tuesday:   { station_id: 23, start_time: "19:00", duration_hours: 5, skip: false },
  wednesday: { station_id: 23, start_time: "19:00", duration_hours: 5, skip: false },
  thursday:  { station_id: 23, start_time: "19:00", duration_hours: 5, skip: false },
  friday:    { station_id: 23, start_time: "19:00", duration_hours: 5, skip: false },
  saturday:  { station_id: 23, start_time: "14:00", duration_hours: 10, skip: false },
  sunday:    { station_id: 23, start_time: "14:00", duration_hours: 10, skip: false },
};
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = "https://evodrive.lv/ru/driverportal";
const EMAIL    = Deno.env.get("EVODRIVE_EMAIL")    ?? "";
const PASSWORD = Deno.env.get("EVODRIVE_PASSWORD") ?? "";

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function extractCsrf(html: string): string {
  const patterns = [
    /<input[^>]+name="_token"[^>]+value="([^"]+)"/,
    /<input[^>]+value="([^"]+)"[^>]+name="_token"/,
    /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  throw new Error("CSRF-токен не найден в HTML");
}

function getSetCookies(headers: Headers): string[] {
  if (typeof (headers as any).getSetCookie === "function") {
    return (headers as any).getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

/**
 * Объединяет куки — новые перезаписывают старые с тем же именем.
 * Возвращает Map<name, "name=value"> и строку для заголовка Cookie.
 */
function mergeCookies(existing: Map<string, string>, incoming: string[]): Map<string, string> {
  const result = new Map(existing);
  for (const raw of incoming) {
    const pair = raw.split(";")[0].trim(); // "name=value"
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx);
    result.set(name, pair);
  }
  return result;
}

function cookieString(jar: Map<string, string>): string {
  return Array.from(jar.values()).join("; ");
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getBookingTarget(): { date: string; dayName: string } {
  const nowRiga = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Riga" })
  );
  const target = new Date(nowRiga);
  target.setDate(nowRiga.getDate() + 14);
  return { date: formatDate(target), dayName: DAY_NAMES[target.getDay()] };
}

async function login(): Promise<{ cookie: string; xsrfToken: string; csrfToken: string }> {
  let jar = new Map<string, string>();

  // Шаг 1: GET страница логина
  log("Шаг 1: Страница логина...");
  const loginPageResp = await fetch(BASE_URL, { redirect: "follow" });
  jar = mergeCookies(jar, getSetCookies(loginPageResp.headers));
  const loginHtml = await loginPageResp.text();
  const csrfLogin = extractCsrf(loginHtml);
  log(`  CSRF: ${csrfLogin.slice(0, 15)}... | Куки: [${Array.from(jar.keys()).join(", ")}]`);

  // Шаг 2: POST логин — redirect:manual чтобы поймать куки из 302
  log("Шаг 2: Логин...");
  const loginResp = await fetch(BASE_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie":       cookieString(jar),
      "Referer":      BASE_URL,
      "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, _token: csrfLogin }),
  });

  jar = mergeCookies(jar, getSetCookies(loginResp.headers));
  log(`  Статус: ${loginResp.status} | Куки: [${Array.from(jar.keys()).join(", ")}]`);

  if (!jar.has("evodrive-session")) {
    throw new Error(`evodrive-session не найден после логина. Куки: [${Array.from(jar.keys()).join(", ")}]`);
  }

  // Получаем XSRF-TOKEN значение (без имени) для заголовка X-XSRF-TOKEN
  const xsrfRaw = jar.get("XSRF-TOKEN") ?? "";
  const xsrfValue = decodeURIComponent(xsrfRaw.replace("XSRF-TOKEN=", ""));

  // Шаг 3: GET /shifts — получаем свежий CSRF-токен
  log("Шаг 3: Страница смен...");
  const shiftsResp = await fetch(`${BASE_URL}/shifts`, {
    redirect: "follow",
    headers: {
      "Cookie":     cookieString(jar),
      "Referer":    BASE_URL,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  jar = mergeCookies(jar, getSetCookies(shiftsResp.headers));
  log(`  Статус: ${shiftsResp.status} | URL финальный: ${shiftsResp.url}`);

  const shiftsHtml = await shiftsResp.text();

  // Проверяем что мы действительно на странице смен, а не на странице логина
  if (shiftsResp.url.includes("login") || !shiftsHtml.includes("shift")) {
    log(`  ⚠️  Похоже что нас редиректнуло на логин. Первые 200 символов: ${shiftsHtml.slice(0, 200)}`);
    throw new Error("Сессия не создана — сервер вернул страницу логина вместо /shifts");
  }

  const freshToken = extractCsrf(shiftsHtml);
  log(`  CSRF токен: ${freshToken.slice(0, 15)}... | Куки: [${Array.from(jar.keys()).join(", ")}]`);

  return { cookie: cookieString(jar), xsrfToken: xsrfValue, csrfToken: freshToken };
}

async function runBooking(): Promise<void> {
  log("=".repeat(50));
  log("Evodrive booking запущен");

  try {
    const { date, dayName } = getBookingTarget();
    const config = SCHEDULE[dayName];
    log(`Цель: ${date} (${dayName})`);

    if (config.skip) {
      log("⏭️  Пропускаем (skip=true)");
      return;
    }

    const { cookie, xsrfToken, csrfToken } = await login();

    const payload = {
      station_id:     config.station_id,
      date,
      start_time:     config.start_time,
      duration_hours: config.duration_hours,
      _token:         csrfToken,
    };

    const apiHeaders = {
      "Content-Type":     "application/json",
      "Accept":           "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "Cookie":           cookie,
      "Referer":          `${BASE_URL}/shifts`,
      "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "X-XSRF-TOKEN":     xsrfToken, // Laravel иногда проверяет этот заголовок
    };

    log(`Проверяем доступность: station=${config.station_id}, time=${config.start_time}`);
    const availResp = await fetch(`${BASE_URL}/shifts/check-availability`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify(payload),
    });

    const availText = await availResp.text();
    log(`Доступность (${availResp.status}): ${availText}`);

    const availability = JSON.parse(availText);

    if (availability.available) {
      const confirmResp = await fetch(`${BASE_URL}/shifts/confirm`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify(payload),
      });
      const confirmText = await confirmResp.text();
      log(`✅ Забронировано! Статус: ${confirmResp.status} | Ответ: ${confirmText}`);
    } else {
      log("❌ Слот недоступен");
    }
  } catch (err) {
    log(`❌ Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  }

  log("=".repeat(50));
}

Deno.serve((_req) => {
  runBooking().catch(console.error);
  return new Response(
    JSON.stringify({ started: true }),
    { headers: { "Content-Type": "application/json" } }
  );
});