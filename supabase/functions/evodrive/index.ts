// Supabase Edge Function — Evodrive shift auto-booking
// Support for multiple accounts with individual schedules

// ─── ACCOUNTS ─────────────────────────────────────────────
//
// For each account:
//   name     — for logging
//   email    — Supabase Secret or direct e-mail for logging into portal
//   password — Supabase Secret or direct e-mail for logging into portal
//   schedule — individual schedule (by day) for each account
//
// station_id can be single number (1) or array ([1, 2, 3])
// if station not available than check another from list in array variant
//
// Secrets Supabase: Dashboard → Edge Functions → Secrets
//   supabase secrets set ACCOUNT_1_EMAIL="user1@email.com"
//   supabase secrets set ACCOUNT_1_PASSWORD="pass1"
//   supabase secrets set ACCOUNT_2_EMAIL="user2@email.com"
//   supabase secrets set ACCOUNT_2_PASSWORD="pass2"

type DaySchedule = {
// station_id can be single number (1) or array ([1, 2, 3])
// if station not available than check another from list in array variant
  station_id: number | number[];
  start_time: string;
  duration_hours: number;
  skip: boolean;
};

function getStationIds(config: DaySchedule): number[] {
  return Array.isArray(config.station_id) ? config.station_id : [config.station_id];
}

type Account = {
  name: string;
  email: string;
  password: string;
  schedule: Record<string, DaySchedule>;
};

const ACCOUNTS: Account[] = [
  //account 1
  {
    name:     `Аккаунт 1 ${Deno.env.get("ACCOUNT_1_EMAIL")}`,
    email:    Deno.env.get("ACCOUNT_1_EMAIL")    ?? "",
    password: Deno.env.get("ACCOUNT_1_PASSWORD") ?? "",
    schedule: {
      monday:    { station_id: 33, start_time: "18:00", duration_hours: 6, skip: true },
      tuesday:   { station_id: 33, start_time: "18:00", duration_hours: 6, skip: false },
      wednesday: { station_id: 33, start_time: "18:00", duration_hours: 6, skip: false },
      thursday:  { station_id: 33, start_time: "18:00", duration_hours: 6, skip: false },
      friday:    { station_id: 33, start_time: "18:00", duration_hours: 6, skip: false },
      saturday:  { station_id: 33, start_time: "14:00", duration_hours: 10, skip: false },
      sunday:    { station_id: 33, start_time: "14:00", duration_hours: 10, skip: false },
    },
  },
  //account 2
  {
    name:     `Аккаунт 4 ${Deno.env.get("ACCOUNT_4_EMAIL")}`,
    email:    Deno.env.get("ACCOUNT_4_EMAIL")    ?? "",
    password: Deno.env.get("ACCOUNT_4_PASSWORD") ?? "",
    schedule: {
      monday:    { station_id: 11, start_time: "06:00", duration_hours: 6, skip: true },
      tuesday:   { station_id: 11, start_time: "06:00", duration_hours: 6, skip: true },
      wednesday: { station_id: 11, start_time: "06:00", duration_hours: 6, skip: true },
      thursday:  { station_id: 11, start_time: "06:00", duration_hours: 6, skip: true },
      friday:    { station_id: 11, start_time: "13:00", duration_hours: 17, skip: true },
      saturday:  { station_id: [11, 26, 35, 8], start_time: "17:00", duration_hours: 13, skip: false  },
      sunday:    { station_id: [11, 26, 35, 8], start_time: "17:00", duration_hours: 12, skip: false  },
    },
  },
  //other accounts
];
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL  = "https://evodrive.lv/ru/driverportal";
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function log(prefix: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${prefix}] ${msg}`);
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

function mergeCookies(existing: Map<string, string>, incoming: string[]): Map<string, string> {
  const result = new Map(existing);
  for (const raw of incoming) {
    const pair  = raw.split(";")[0].trim();
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    result.set(pair.slice(0, eqIdx), pair);
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
  target.setDate(nowRiga.getDate() + 13);
  return { date: formatDate(target), dayName: DAY_NAMES[target.getDay()] };
}

async function loginAccount(
  account: Account
): Promise<{ cookie: string; xsrfToken: string; csrfToken: string }> {
  const tag = account.name;
  let jar   = new Map<string, string>();

  log(tag, "Шаг 1: Страница логина...");
  const loginPageResp = await fetch(BASE_URL, { redirect: "follow" });
  jar = mergeCookies(jar, getSetCookies(loginPageResp.headers));
  const csrfLogin = extractCsrf(await loginPageResp.text());

  log(tag, "Шаг 2: Логин...");
  const loginResp = await fetch(BASE_URL, {
    method:   "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie":       cookieString(jar),
      "Referer":      BASE_URL,
      "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    body: new URLSearchParams({
      email:    account.email,
      password: account.password,
      _token:   csrfLogin,
    }),
  });

  jar = mergeCookies(jar, getSetCookies(loginResp.headers));
  log(tag, `  Статус: ${loginResp.status} | Куки: [${Array.from(jar.keys()).join(", ")}]`);

  if (!jar.has("evodrive-session")) {
    throw new Error(`evodrive-session не найден. Куки: [${Array.from(jar.keys()).join(", ")}]`);
  }

  const xsrfValue = decodeURIComponent((jar.get("XSRF-TOKEN") ?? "").replace("XSRF-TOKEN=", ""));

  log(tag, "Шаг 3: Страница смен...");
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
  log(tag, `  Статус: ${shiftsResp.status} | URL: ${shiftsResp.url}`);

  const shiftsHtml = await shiftsResp.text();
  if (shiftsResp.url.includes("login")) {
    throw new Error("Сессия не создана — сервер вернул страницу логина");
  }

  const freshToken = extractCsrf(shiftsHtml);
  return { cookie: cookieString(jar), xsrfToken: xsrfValue, csrfToken: freshToken };
}

async function bookForAccount(account: Account, date: string, dayName: string): Promise<void> {
  const tag        = account.name;
  const config     = account.schedule[dayName];
  const stationIds = getStationIds(config);

  log(tag, `Бронируем ${date} (${dayName}) | станции=[${stationIds.join(", ")}] time=${config.start_time}`);

  const { cookie, xsrfToken, csrfToken } = await loginAccount(account);

  const headers = {
    "Content-Type":     "application/json",
    "Accept":           "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-XSRF-TOKEN":     xsrfToken,
    "Cookie":           cookie,
    "Referer":          `${BASE_URL}/shifts`,
    "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };

  for (const stationId of stationIds) {
    const payload = {
      station_id:     stationId,
      date,
      start_time:     config.start_time,
      duration_hours: config.duration_hours,
      _token:         csrfToken,
    };

    const availResp = await fetch(`${BASE_URL}/shifts/check-availability`, {
      method: "POST", headers, body: JSON.stringify(payload),
    });
    const availText = await availResp.text();
    log(tag, `Станция ${stationId} — доступность (${availResp.status}): ${availText}`);

    const availability = JSON.parse(availText);
    if (!availability.available) {
      log(tag, `⏭️  Станция ${stationId} занята — пробуем следующую`);
      continue;
    }

    const confirmResp = await fetch(`${BASE_URL}/shifts/confirm`, {
      method: "POST", headers, body: JSON.stringify(payload),
    });
    const confirmText = await confirmResp.text();
    log(tag, `✅ Забронировано на станции ${stationId}! Статус: ${confirmResp.status} | ${confirmText}`);
    return;
  }

  log(tag, `❌ Все станции [${stationIds.join(", ")}] заняты — бронирование не выполнено`);
}

async function runBooking(): Promise<void> {
  log("MAIN", "=".repeat(50));
  log("MAIN", `Запуск для ${ACCOUNTS.length} аккаунтов`);

  const { date, dayName } = getBookingTarget();
  log("MAIN", `Цель: ${date} (${dayName})`);

  for (let i = 0; i < ACCOUNTS.length; i++) {
    const account = ACCOUNTS[i];
    const config  = account.schedule[dayName];

    try {
      if (config.skip) {
        log(account.name, `⏭️  ${date} (${dayName}) — пропускаем`);
        continue; // пауза не нужна — сервер не трогали
      }
      await bookForAccount(account, date, dayName);
    } catch (err) {
      log(account.name, `❌ Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }

    //timeout
    if (i < ACCOUNTS.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  log("MAIN", "=".repeat(50));
}

Deno.serve((_req) => {
  runBooking().catch(console.error);
  return new Response(
    JSON.stringify({ started: true }),
    { headers: { "Content-Type": "application/json" } }
  );
});
