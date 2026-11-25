// GLUCOSE Bot admin panel — plain JS, no build step.
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STAGE_LABELS = {
  new: "Новая",
  qualifying: "Выявление потребностей",
  presented: "Презентация",
  price_sent: "Озвучена цена",
  ready_to_pay: "Готов оплатить",
  parent_call: "Звонок родителям",
  paid: "Оплачено",
  not_interested: "Не интересно",
};
const MODEL_LABELS = {
  "claude-haiku-5-5": "Claude Haiku 5.5 — $0.10 / $0.50 за 1M токенов",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 — $2 / $10 за 1M токенов",
  "claude-opus-5-5": "Claude Opus 5.5 — $4 / $20 за 1M токенов",
};
const HOT = new Set(["ready_to_pay", "parent_call", "paid"]);

async function api(path, opts = {}) {
  const res = await fetch(`/admin/api/${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== "login") {
    showLogin();
    throw new Error("Требуется вход");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка запроса (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 2800);
}

// ---------- phone mask: +7 (7XX) XXX-XX-XX ----------
/** Format digits as a Kazakhstan number, as far as they go. 8XXXXXXXXXX is treated as 7XXXXXXXXXX. */
function formatPhone(value) {
  let d = String(value ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d[0] === "8") d = "7" + d.slice(1);
  if (d[0] !== "7") d = "7" + d;
  d = d.slice(0, 11);
  const p = [d.slice(1, 4), d.slice(4, 7), d.slice(7, 9), d.slice(9, 11)];
  let out = "+7";
  if (p[0]) out += ` (${p[0]}${p[0].length === 3 ? ")" : ""}`;
  if (p[1]) out += ` ${p[1]}`;
  if (p[2]) out += `-${p[2]}`;
  if (p[3]) out += `-${p[3]}`;
  return out;
}
const phoneDigits = (value) => {
  const d = String(value ?? "").replace(/\D/g, "");
  return d[0] === "8" ? "7" + d.slice(1) : d;
};
const isFullPhone = (value) => /^7\d{10}$/.test(phoneDigits(value));

function maskPhoneInput(input) {
  input.addEventListener("input", (e) => {
    // Let backspace remove a digit even when it lands on a formatting character.
    const deleting = e.inputType?.startsWith("delete");
    let digits = phoneDigits(input.value);
    if (deleting && formatPhone(digits) === input.value + ")") digits = digits.slice(0, -1);
    // Typed "8 701…" after the "+7 (" prefix: Kazakh codes never start with 8, so drop it.
    if (!deleting && digits[1] === "8") digits = "7" + digits.slice(2);
    input.value = formatPhone(digits);
  });
  input.addEventListener("focus", () => {
    if (!input.value) input.value = "+7 (";
    // Put the cursor after the prefix (a click would otherwise place it inside "+7 (").
    setTimeout(() => input.setSelectionRange(input.value.length, input.value.length));
  });
  input.addEventListener("blur", () => {
    if (phoneDigits(input.value).length <= 1) input.value = "";
  });
}
document.querySelectorAll("input[data-phone]").forEach(maskPhoneInput);

const phone = (chatId) => {
  const d = String(chatId).split("@")[0];
  return /^7\d{10}$/.test(d) ? formatPhone(d) : "+" + d;
};
const time = (iso) => (iso ? new Date(iso).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "");
const money = (n) => "$" + (n ?? 0).toFixed(2);
const num = (n) => (n ?? 0).toLocaleString("ru-RU");
const bytes = (n) => (n / 1024 ** 3).toFixed(1) + " ГБ";
const duration = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
};

// ---------- auth ----------
function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#password").focus();
}
function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("login", { method: "POST", body: { password: $("#password").value } });
    $("#password").value = "";
    start();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});
$("#logout").addEventListener("click", async () => {
  await api("logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ---------- routing ----------
// URLs: /admin/overview, /admin/chats, /admin/chats/<chat id>, /admin/leads?stage=<stage>,
//       /admin/tuning, /admin/whatsapp, /admin/server
const TABS = ["overview", "chats", "leads", "questions", "tuning", "whatsapp", "server"];
const TAB_TITLES = { overview: "Обзор", chats: "Чаты", leads: "Заявки", questions: "Вопросы", tuning: "Настройка бота", whatsapp: "WhatsApp", server: "Сервер" };
const BASE = "/admin";
let currentTab = "overview";
const loaders = {};

const chatPath = (id) => encodeURIComponent(id).replace(/%40/g, "@");

function parseRoute() {
  const parts = location.pathname.slice(BASE.length).split("/").filter(Boolean);
  const tab = TABS.includes(parts[0]) ? parts[0] : "overview";
  return {
    tab,
    chatId: tab === "chats" && parts[1] ? decodeURIComponent(parts[1]) : null,
    questionId: tab === "questions" && parts[1] ? Number(parts[1]) : null,
    stage: new URLSearchParams(location.search).get("stage") ?? "",
  };
}

/** Change the URL (adds a browser history entry) and show the matching page. */
function navigate(path, { replace = false } = {}) {
  const url = `${BASE}/${path}`;
  if (url !== location.pathname + location.search) history[replace ? "replaceState" : "pushState"](null, "", url);
  applyRoute();
}

function applyRoute() {
  const r = parseRoute();
  const tabChanged = r.tab !== currentTab;
  currentTab = r.tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === r.tab));
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== r.tab));
  document.title = `${TAB_TITLES[r.tab]} — GLUCOSE Bot`;

  if (r.tab === "chats") {
    if (r.chatId !== openChatId) {
      openChatId = r.chatId;
      if (!r.chatId) $("#chat-view").innerHTML = '<p class="muted">Выберите диалог.</p>';
    }
    loaders.chats();
  } else if (r.tab === "questions") {
    loaders.questions(r.questionId);
  } else if (r.tab === "leads") {
    $("#lead-filter").value = r.stage;
    loaders.leads();
  } else if (tabChanged || !loaded.has(r.tab)) {
    loaders[r.tab]?.();
  }
  loaded.add(r.tab);
}
const loaded = new Set();

window.addEventListener("popstate", applyRoute);
$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  if (tab === "chats" && openChatId && currentTab !== "chats") return navigate(`chats/${chatPath(openChatId)}`);
  navigate(tab === "leads" && $("#lead-filter").value ? `leads?stage=${$("#lead-filter").value}` : tab);
});

// ---------- header: WhatsApp pill + bot switch ----------
async function refreshHeader() {
  api("questions?status=open").then((r) => setQuestionBadge(r.open)).catch(() => {});
  try {
    const s = await api("whatsapp");
    const pill = $("#wa-pill");
    const map = { CONNECTED: ["WhatsApp подключён", "ok"], SCAN_QR_CODE: ["WhatsApp: отсканируйте QR", "warn"], STARTING: ["WhatsApp запускается…", "warn"] };
    const [text, cls] = map[s.status] ?? [s.status === "STOPPED" ? "WhatsApp не подключён" : "WhatsApp: ошибка", "bad"];
    pill.textContent = text;
    pill.className = `pill ${cls}`;
  } catch {}
}
$("#bot-enabled").addEventListener("change", async (e) => {
  try {
    await api("settings", { method: "PUT", body: { botEnabled: e.target.checked } });
    toast(e.target.checked ? "Бот отвечает клиентам" : "Бот на паузе: автоответы отключены");
  } catch (err) {
    toast(err.message);
    e.target.checked = !e.target.checked;
  }
});

// ---------- overview ----------
loaders.overview = async () => {
  const s = await api("stats");
  const t = s.totals;
  const conv = t.leads ? Math.round((t.readyToPay / t.leads) * 100) : 0;
  $("#kpis").innerHTML = [
    ["Сообщений сегодня", num(t.messagesToday), `новых чатов сегодня: ${num(t.newChatsToday)}`],
    ["Диалоги", num(t.chats), `ведёт менеджер: ${num(t.paused)}`],
    ["Заявки", num(t.leads), "с сохранёнными данными"],
    ["Готовы оплатить / оплатили", num(t.readyToPay), `${conv}% от заявок`],
    ["Расход Claude сегодня", money(s.cost.today.usd), `${money(s.cost.month.usd)} за 30 дней`],
  ]
    .map(([l, v, sub]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`)
    .join("");

  const max = Math.max(1, ...s.daily.map((d) => Math.max(d.incoming, d.new_chats)));
  $("#chart").innerHTML = s.daily
    .map(
      (d) => `<div class="col" title="${d.day}: сообщений ${d.incoming}, новых чатов ${d.new_chats}, готовы оплатить ${d.ready}, ${money(d.cost)}">
        <div class="bars"><div class="bar a" style="height:${(d.incoming / max) * 100}%"></div><div class="bar b" style="height:${(d.new_chats / max) * 100}%"></div></div>
        <div class="day">${d.day.slice(8)}</div></div>`,
    )
    .join("");

  const fmax = Math.max(1, ...s.stages.map((x) => x.n));
  $("#funnel").innerHTML = s.stages
    .map(
      (x) => `<div class="funnel-row"><span>${STAGE_LABELS[x.stage] ?? x.stage}</span>
        <div class="funnel-track"><div class="funnel-bar" style="width:${(x.n / fmax) * 100}%"></div></div><span class="n">${x.n}</span></div>`,
    )
    .join("");

  $("#costs").innerHTML = [
    ["Сегодня", s.cost.today],
    ["За 7 дней", s.cost.week],
    ["За 30 дней", s.cost.month],
  ]
    .map(
      ([l, c]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${money(c.usd)}</div>
        <div class="sub">запросов: ${num(c.calls)} · токенов: ${num(c.input)} вход / ${num(c.output)} выход · из кэша: ${num(c.cache_read)}</div></div>`,
    )
    .join("");
};

// ---------- chats ----------
let chats = [];
let openChatId = null;

function renderChatList() {
  const q = $("#chat-search").value.trim().toLowerCase();
  $("#chat-list").innerHTML = chats
    .filter((c) => !q || `${c.lead_name ?? ""} ${c.name ?? ""} ${c.chat_id}`.toLowerCase().includes(q))
    .map((c) => {
      const tags = [
        c.paused ? '<span class="tag paused">Менеджер</span>' : "",
        c.stage ? `<span class="tag ${HOT.has(c.stage) ? "hot" : ""}">${esc(STAGE_LABELS[c.stage] ?? c.stage)}</span>` : "",
      ].join(" ");
      return `<li data-id="${esc(c.chat_id)}" class="${c.chat_id === openChatId ? "active" : ""}">
        <div class="name"><span>${esc(c.lead_name || c.name || phone(c.chat_id))}</span><span>${tags}</span></div>
        <div class="preview">${c.last_direction !== "in" ? "↪ " : ""}${esc(c.last_text)}</div>
        <div class="preview">${esc(phone(c.chat_id))} · ${time(c.last_message_at)}</div></li>`;
    })
    .join("") || '<li class="muted">Пока нет диалогов.</li>';
}

loaders.chats = async () => {
  chats = await api("chats");
  renderChatList();
  if (openChatId) openChat(openChatId, true);
};
$("#chat-search").addEventListener("input", renderChatList);
$("#chat-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) navigate(`chats/${chatPath(li.dataset.id)}`);
});

async function openChat(id, keepScroll = false) {
  openChatId = id;
  renderChatList();
  const [{ chat, messages }, leads] = await Promise.all([api(`chats/${encodeURIComponent(id)}/messages`), api("leads")]);
  const lead = leads.find((l) => l.chatId === id);
  const view = $("#chat-view");
  const prevScroll = keepScroll && view.dataset.chat === id ? view.querySelector(".bubbles")?.scrollTop : null;
  view.dataset.chat = id;
  const leadBits = lead
    ? [
        lead.name && `👤 ${lead.name}`,
        lead.grade && `${lead.grade} сынып`,
        lead.subjects && `📚 ${lead.subjects}`,
        lead.specialty && `🎓 ${lead.specialty}`,
        lead.targetScore && `🎯 ${lead.targetScore}`,
        lead.parentPhone && `📞 ${lead.parentPhone}`,
        lead.paymentPreference && `💳 ${lead.paymentPreference}`,
      ].filter(Boolean)
    : [];
  view.innerHTML = `
    <div class="chat-head">
      <div><strong>${esc(lead?.name || chat?.name || phone(id))}</strong> <span class="muted">${esc(phone(id))}</span></div>
      <div class="row">
        <button class="btn" id="chat-pause">${chat?.paused ? "▶ Вернуть бота" : "⏸ Взять диалог (пауза бота)"}</button>
        <button class="btn ghost" id="chat-reset" title="Бот забудет этот диалог (сообщения останутся здесь)">Сбросить память бота</button>
      </div>
    </div>
    ${leadBits.length ? `<div class="lead-box">${leadBits.map(esc).join(" · ")}</div>` : ""}
    <div class="bubbles">${messages
      .map(
        (m) => `<div class="bubble ${m.direction}">${esc(m.text)}<div class="meta">${
          m.direction === "in" ? "Ученик" : m.direction === "out" ? "Бот" : "Менеджер"
        } · ${time(m.created_at)}</div></div>`,
      )
      .join("")}</div>
    <form id="chat-send" class="row">
      <input id="chat-text" placeholder="Написать от менеджера… (бот в этом чате встанет на паузу)" autocomplete="off" />
      <button class="btn primary" type="submit">Отправить</button>
    </form>`;
  const bubbles = view.querySelector(".bubbles");
  bubbles.scrollTop = keepScroll && prevScroll != null ? prevScroll : bubbles.scrollHeight;

  $("#chat-pause").onclick = async () => {
    await api(`chats/${encodeURIComponent(id)}/pause`, { method: "POST", body: { paused: !chat?.paused } });
    toast(chat?.paused ? "Бот снова отвечает в этом чате" : "Бот на паузе в этом чате");
    loaders.chats();
  };
  $("#chat-reset").onclick = async () => {
    if (!confirm("Бот забудет этот диалог и начнёт заново со следующего сообщения. Продолжить?")) return;
    await api(`chats/${encodeURIComponent(id)}/reset`, { method: "POST" });
    toast("Память бота для этого чата сброшена");
  };
  $("#chat-send").onsubmit = async (e) => {
    e.preventDefault();
    const text = $("#chat-text").value.trim();
    if (!text) return;
    try {
      await api(`chats/${encodeURIComponent(id)}/send`, { method: "POST", body: { text } });
      loaders.chats();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- leads ----------
let leads = [];
$("#lead-filter").innerHTML += Object.entries(STAGE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
$("#lead-filter").addEventListener("change", () => {
  const stage = $("#lead-filter").value;
  history.replaceState(null, "", stage ? `${BASE}/leads?stage=${stage}` : `${BASE}/leads`);
  renderLeads();
});

function renderLeads() {
  const f = $("#lead-filter").value;
  const rows = leads.filter((l) => !f || l.stage === f);
  const stageSelect = (l) =>
    `<select data-lead="${esc(l.chatId)}">${Object.entries(STAGE_LABELS)
      .map(([k, v]) => `<option value="${k}" ${k === l.stage ? "selected" : ""}>${v}</option>`)
      .join("")}</select>`;
  $("#leads-table").innerHTML = `
    <tr><th>Имя</th><th>Телефон</th><th>Класс</th><th>Предметы</th><th>Специальность</th><th>Цель (балл)</th><th>Телефон родителя</th><th>Оплата</th><th>Этап</th><th>Обновлено</th></tr>
    ${rows
      .map(
        (l) => `<tr>
          <td>${esc(l.name || l.whatsappName || "—")}</td><td>${esc(phone(l.chatId))}</td><td>${esc(l.grade)}</td>
          <td>${esc(l.subjects)}</td><td>${esc(l.specialty)}</td><td>${esc(l.targetScore)}</td>
          <td>${esc(l.parentPhone)}</td><td>${esc(l.paymentPreference)}</td><td>${stageSelect(l)}</td><td>${time(l.updatedAt)}</td></tr>`,
      )
      .join("") || '<tr><td colspan="10" class="muted">Пока нет заявок.</td></tr>'}`;
}
$("#leads-table").addEventListener("change", async (e) => {
  const id = e.target.dataset?.lead;
  if (!id) return;
  try {
    await api(`leads/${encodeURIComponent(id)}/stage`, { method: "POST", body: { stage: e.target.value } });
    toast("Этап обновлён");
  } catch (err) {
    toast(err.message);
  }
});
loaders.leads = async () => {
  leads = await api("leads");
  renderLeads();
};

// ---------- questions & knowledge base ----------
function setQuestionBadge(n) {
  const b = $("#q-badge");
  b.textContent = n;
  b.classList.toggle("hidden", !n);
}

let questionsCache = [];
loaders.questions = async (highlightId = null) => {
  if (highlightId) {
    // Opened from the WhatsApp link: make sure that question is in the list.
    $("#q-filter").value = "";
  }
  const status = $("#q-filter").value;
  const [{ questions, open }, { items }] = await Promise.all([
    api(`questions${status ? `?status=${status}` : ""}`),
    api("knowledge"),
  ]);
  questionsCache = questions;
  setQuestionBadge(open);
  renderQuestions(highlightId);
  renderKnowledge(items);
};
$("#q-filter").addEventListener("change", () => loaders.questions());

function renderQuestions(highlightId) {
  const STATUS = { open: "Новый", answered: "Отвечен", dismissed: "Отклонён" };
  $("#q-list").innerHTML =
    questionsCache
      .map(
        (q) => `<div class="q-item ${q.id === highlightId ? "highlight" : ""}" data-q="${q.id}">
          <div class="q-head">
            <span>#${q.id} · ${esc(q.customer_name || "без имени")} · <a href="/admin/chats/${chatPath(q.chat_id)}" data-chat="${esc(q.chat_id)}">${esc(phone(q.chat_id))}</a></span>
            <span>${STATUS[q.status]} · ${time(q.created_at)}</span>
          </div>
          <div class="q-text">${esc(q.question)}</div>
          ${
            q.status === "open"
              ? `<textarea class="q-answer-input" placeholder="Ответ ученику…"></textarea>
                 <div class="checks">
                   <label><input type="checkbox" class="q-send" checked /> Отправить ученику в WhatsApp</label>
                   <label><input type="checkbox" class="q-kb" checked /> Добавить в базу знаний</label>
                 </div>
                 <div class="row between">
                   <button class="btn ghost q-dismiss">Отклонить</button>
                   <button class="btn primary q-submit">Ответить</button>
                 </div>`
              : q.answer
              ? `<div class="q-answer">${esc(q.answer)}</div>`
              : ""
          }
        </div>`,
      )
      .join("") || '<p class="muted">Вопросов нет 🎉</p>';
  if (highlightId) document.querySelector(`[data-q="${highlightId}"]`)?.scrollIntoView({ block: "center" });
}

$("#q-list").addEventListener("click", async (e) => {
  const link = e.target.closest("a[data-chat]");
  if (link) {
    e.preventDefault();
    return navigate(`chats/${chatPath(link.dataset.chat)}`);
  }
  const item = e.target.closest(".q-item");
  if (!item) return;
  const id = Number(item.dataset.q);
  try {
    if (e.target.classList.contains("q-submit")) {
      const answer = item.querySelector(".q-answer-input").value.trim();
      if (!answer) return toast("Напишите ответ");
      e.target.disabled = true;
      await api(`questions/${id}/answer`, {
        method: "POST",
        body: {
          answer,
          sendToCustomer: item.querySelector(".q-send").checked,
          addToKnowledge: item.querySelector(".q-kb").checked,
        },
      });
      toast(item.querySelector(".q-send").checked ? "Ответ отправлен ученику" : "Ответ сохранён");
      loaders.questions();
    } else if (e.target.classList.contains("q-dismiss")) {
      await api(`questions/${id}/dismiss`, { method: "POST" });
      toast("Вопрос отклонён");
      loaders.questions();
    }
  } catch (err) {
    e.target.disabled = false;
    toast(err.message);
  }
});

function renderKnowledge(items) {
  $("#kb-count").textContent = items.length ? `записей: ${items.length}` : "";
  $("#kb-list").innerHTML =
    items
      .map(
        (k) => `<div class="kb-item" data-kb="${k.id}">
          <input class="kb-edit-q" value="${esc(k.question)}" />
          <textarea class="kb-edit-a">${esc(k.answer)}</textarea>
          <div class="row between">
            <button class="btn ghost danger kb-delete">Удалить</button>
            <button class="btn kb-save">Сохранить</button>
          </div>
        </div>`,
      )
      .join("") || '<p class="muted small">Пока пусто. Записи появятся, когда вы ответите на вопросы, или добавьте их сами.</p>';
}

$("#kb-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("knowledge", { method: "POST", body: { question: $("#kb-q").value, answer: $("#kb-a").value } });
    $("#kb-q").value = "";
    $("#kb-a").value = "";
    toast("Добавлено в базу знаний");
    loaders.questions();
  } catch (err) {
    toast(err.message);
  }
});

$("#kb-list").addEventListener("click", async (e) => {
  const item = e.target.closest(".kb-item");
  if (!item) return;
  const id = item.dataset.kb;
  try {
    if (e.target.classList.contains("kb-save")) {
      await api(`knowledge/${id}`, {
        method: "PUT",
        body: { question: item.querySelector(".kb-edit-q").value, answer: item.querySelector(".kb-edit-a").value },
      });
      toast("Сохранено");
    } else if (e.target.classList.contains("kb-delete")) {
      if (!confirm("Удалить эту запись из базы знаний?")) return;
      await api(`knowledge/${id}`, { method: "DELETE" });
      toast("Удалено");
      loaders.questions();
    }
  } catch (err) {
    toast(err.message);
  }
});

// ---------- tuning ----------
loaders.tuning = async () => {
  const [{ script }, { settings, efforts, models }] = await Promise.all([api("script"), api("settings")]);
  $("#model").innerHTML = models
    .map((m) => `<option value="${m}" ${m === settings.model ? "selected" : ""}>${MODEL_LABELS[m] ?? m}</option>`)
    .join("");
  $("#script").value = script;
  $("#script-status").textContent = "";
  $("#effort").innerHTML = efforts.map((e) => `<option ${e === settings.effort ? "selected" : ""}>${e}</option>`).join("");
  $("#paymentLink").value = settings.paymentLink;
  $("#adminPhone").value = formatPhone(settings.adminPhone);
};
$("#script").addEventListener("input", () => ($("#script-status").textContent = "Есть несохранённые изменения"));
$("#save-script").addEventListener("click", async () => {
  try {
    await api("script", { method: "PUT", body: { script: $("#script").value } });
    $("#script-status").textContent = `Сохранено в ${new Date().toLocaleTimeString("ru-RU")}`;
    toast("Скрипт сохранён: бот использует его со следующего сообщения");
  } catch (err) {
    toast(err.message);
  }
});
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("#adminPhone").value && !isFullPhone($("#adminPhone").value)) return toast("Введите номер менеджера полностью: +7 (7XX) XXX-XX-XX");
  try {
    await api("settings", {
      method: "PUT",
      body: { model: $("#model").value, effort: $("#effort").value, paymentLink: $("#paymentLink").value, adminPhone: phoneDigits($("#adminPhone").value) },
    });
    toast("Настройки сохранены");
  } catch (err) {
    toast(err.message);
  }
});

let testHistory = [];
function renderTest() {
  const log = $("#test-log");
  log.innerHTML = testHistory
    .map((t) => `<div class="bubble ${t.role === "user" ? "in" : "out"}">${esc(t.text)}</div>`)
    .join("") || '<p class="muted small">Начните с приветствия, как написал бы ученик.</p>';
  log.scrollTop = log.scrollHeight;
}
$("#test-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#test-input").value.trim();
  if (!text) return;
  $("#test-input").value = "";
  testHistory.push({ role: "user", text });
  renderTest();
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const { reply } = await api("test", { method: "POST", body: { history: testHistory } });
    testHistory.push({ role: "assistant", text: reply || "(нет ответа)" });
  } catch (err) {
    testHistory.push({ role: "assistant", text: `⚠️ ${err.message}` });
  } finally {
    btn.disabled = false;
    btn.textContent = "Отправить";
    renderTest();
  }
});
$("#test-reset").addEventListener("click", () => {
  testHistory = [];
  renderTest();
});
renderTest();

// ---------- WhatsApp ----------
let qrTimer = null;
async function refreshWhatsApp() {
  const s = await api("whatsapp");
  const labels = {
    CONNECTED: "✅ Подключён",
    SCAN_QR_CODE: "📷 Ожидает сканирования QR",
    STARTING: "⏳ Запускается…",
    STOPPED: "⏹ Не подключён",
    FAILED: "❌ Ошибка",
  };
  const me = s.me?.id ? ` — ${esc(s.me.pushName ?? "")} ${esc(phone(s.me.id.replace(/:\d+/, "")))}` : "";
  $("#wa-status").innerHTML = `<strong>${labels[s.status] ?? s.status}</strong>${me}${
    s.detail && s.status !== "CONNECTED" ? `<div class="muted small">${esc(s.detail)}</div>` : ""
  }`;
  if (s.status === "SCAN_QR_CODE" || s.status === "STARTING") {
    // WAHA sometimes still says STARTING while the QR is already available.
    const { qr } = await api("whatsapp/qr").catch(() => ({}));
    $("#wa-qr").innerHTML = qr ? `<img alt="QR-код WhatsApp" src="${qr}" />` : '<p class="muted">Загрузка QR…</p>';
  } else if (s.status === "CONNECTED") {
    $("#wa-qr").innerHTML = '<p class="muted">✅ Номер привязан. Сканировать ничего не нужно.</p>';
  }
  refreshHeader();
  return s;
}
function pollWhatsApp() {
  clearInterval(qrTimer);
  qrTimer = setInterval(() => {
    if (currentTab !== "whatsapp") return clearInterval(qrTimer);
    refreshWhatsApp().then((s) => s.status === "CONNECTED" && clearInterval(qrTimer)).catch(() => {});
  }, 4000);
}
loaders.whatsapp = async () => {
  const s = await refreshWhatsApp();
  if (s.status !== "CONNECTED") pollWhatsApp();
};
$("#wa-connect").addEventListener("click", async () => {
  try {
    await api("whatsapp/connect", { method: "POST" });
    toast("Запуск сессии… QR появится через несколько секунд");
    pollWhatsApp();
    setTimeout(refreshWhatsApp, 1500);
  } catch (err) {
    toast(err.message);
  }
});
$("#wa-restart").addEventListener("click", async () => {
  try {
    await api("whatsapp/restart", { method: "POST" });
    toast("Сессия перезапускается");
    pollWhatsApp();
  } catch (err) {
    toast(err.message);
  }
});
$("#wa-logout").addEventListener("click", async () => {
  if (!confirm("Отвязать номер WhatsApp от бота? Потом нужно будет снова сканировать QR.")) return;
  try {
    await api("whatsapp/logout", { method: "POST" });
    toast("Номер отвязан");
    refreshWhatsApp();
  } catch (err) {
    toast(err.message);
  }
});
$("#pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (!isFullPhone($("#pair-phone").value)) return toast("Введите номер полностью: +7 (7XX) XXX-XX-XX");
    const { code } = await api("whatsapp/pairing-code", { method: "POST", body: { phone: phoneDigits($("#pair-phone").value) } });
    $("#pair-code").textContent = code;
  } catch (err) {
    toast(err.message);
  }
});

// ---------- server ----------
loaders.server = async () => {
  const s = await api("server");
  const memUsed = s.memory.total - s.memory.free;
  const diskUsed = s.disk.total - s.disk.free;
  $("#server-kpis").innerHTML = [
    ["Бот работает", duration(s.uptimeSec), `сервер: ${duration(s.hostUptimeSec)}`],
    ["Нагрузка CPU", s.load[0].toFixed(2), `ядер: ${s.cpus} · за 5 мин ${s.load[1].toFixed(2)}`],
    ["Память", `${Math.round((memUsed / s.memory.total) * 100)}%`, `${bytes(memUsed)} из ${bytes(s.memory.total)} · бот ${Math.round(s.memory.process / 1048576)} МБ`],
    ["Диск", `${Math.round((diskUsed / s.disk.total) * 100)}%`, `свободно ${bytes(s.disk.free)} из ${bytes(s.disk.total)}`],
    ["Конфигурация", s.provider.toUpperCase(), `${esc(s.model)} · Node ${esc(s.node)}`],
  ]
    .map(([l, v, sub]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`)
    .join("");
  await loadLogs();
};
async function loadLogs() {
  const { lines } = await api("logs");
  const pre = $("#logs");
  pre.textContent = lines.join("\n") || "Логов пока нет.";
  pre.scrollTop = pre.scrollHeight;
}
$("#logs-refresh").addEventListener("click", loadLogs);
$("#restart-bot").addEventListener("click", async () => {
  if (!confirm("Перезапустить бота? Он будет недоступен несколько секунд.")) return;
  await api("restart", { method: "POST" }).catch(() => {});
  toast("Перезапуск… обновите страницу через ~10 секунд");
});

// ---------- start ----------
async function start() {
  const { authed } = await api("me");
  if (!authed) return showLogin();
  showApp();
  const { settings } = await api("settings");
  $("#bot-enabled").checked = settings.botEnabled;
  refreshHeader();
  currentTab = null; // force the first page load
  applyRoute();
  if (start.timer) return;
  start.timer = setInterval(() => {
    if (document.hidden || $("#app").classList.contains("hidden")) return;
    refreshHeader();
    if (currentTab === "overview" || currentTab === "chats") loaders[currentTab]().catch(() => {});
  }, 15000);
}
start().catch((err) => toast(err.message));
