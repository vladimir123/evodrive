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
  return {
    date:    formatDate(target),
    dayName: DAY_NAMES[target.getDay()],
  };
}

async function login(): Promise<{ cookie: string; token: string }> {
  log("Шаг 1: Страница логина...");
  const loginPage = await fetch(BASE_URL, { redirect: "follow" });
  const csrfLogin = extractCsrf(await loginPage.text());

  log("Шаг 2: Логин...");
  const loginResp = await fetch(BASE_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, _token: csrfLogin }),
  });

  const rawCookies = loginResp.headers.getSetCookie?.() ?? [];
  if (!rawCookies.length) {
    const single = loginResp.headers.get("set-cookie") ?? "";
    if (single) rawCookies.push(single);
  }
  if (!rawCookies.length) throw new Error("Авторизация не прошла");

  const cookieHeader = rawCookies.map((c) => c.split(";")[0].trim()).join("; ");

  log("Шаг 3: Свежий CSRF-токен...");
  const shiftsResp = await fetch(`${BASE_URL}/shifts`, {
    headers: { Cookie: cookieHeader },
  });
  const freshToken = extractCsrf(await shiftsResp.text());

  return { cookie: cookieHeader, token: freshToken };
}

async function runBooking(): Promise<void> {
  log("=".repeat(50));
  log("Evodrive booking запущен (фон)");

  try {
    const { date, dayName } = getBookingTarget();
    const config = SCHEDULE[dayName];

    log(`Цель: ${date} (${dayName})`);

    if (config.skip) {
      log("⏭️  Пропускаем (skip=true)");
      return;
    }

    const { cookie, token } = await login();

    const payload = {
      station_id:     config.station_id,
      date,
      start_time:     config.start_time,
      duration_hours: config.duration_hours,
      _token:         token,
    };

    log(`Проверяем доступность: station=${config.station_id}, time=${config.start_time}`);

    const availResp = await fetch(`${BASE_URL}/shifts/check-availability`, {
      method: "POST",
      headers: {
        "Content-Type":     "application/json",
        "Accept":           "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Cookie":           cookie,
        "Referer":          `${BASE_URL}/shifts`,
      },
      body: JSON.stringify(payload),
    });
    const availability = await availResp.json();
    log(`Доступность: ${JSON.stringify(availability)}`);

    if (availability.available) {
      const confirmResp = await fetch(`${BASE_URL}/shifts/confirm`, {
        method: "POST",
        headers: {
          "Content-Type":     "application/json",
          "Accept":           "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "Cookie":           cookie,
          "Referer":          `${BASE_URL}/shifts`,
        },
        body: JSON.stringify(payload),
      });
      log(`✅ Забронировано! Статус: ${confirmResp.status}`);
    } else {
      log("❌ Слот недоступен");
    }
  } catch (err) {
    log(`❌ Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  }

  log("=".repeat(50));
}

// ─── Entry point ──────────────────────────────────────────────────────────────

Deno.serve((req) => {
  // Запускаем бронирование в фоне — не ждём результата
  // Функция продолжит работать пока runBooking не завершится
  runBooking().catch(console.error);

  // Отвечаем сразу — крон доволен, таймаут не срабатывает
  return new Response(
    JSON.stringify({ started: true, message: "Booking started in background" }),
    { headers: { "Content-Type": "application/json" } }
  );
});