// GLUCOSE Bot admin panel — plain JS, no build step.
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STAGE_LABELS = {
  new: "New",
  qualifying: "Qualifying",
  presented: "Presented",
  price_sent: "Price sent",
  ready_to_pay: "Ready to pay",
  parent_call: "Parent call",
  paid: "Paid",
  not_interested: "Not interested",
};
const HOT = new Set(["ready_to_pay", "parent_call", "paid"]);

async function api(path, opts = {}) {
  const res = await fetch(`api/${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== "login") {
    showLogin();
    throw new Error("Not logged in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 2800);
}

const phone = (chatId) => "+" + String(chatId).split("@")[0];
const time = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "");
const money = (n) => "$" + (n ?? 0).toFixed(2);
const num = (n) => (n ?? 0).toLocaleString();
const bytes = (n) => (n / 1024 ** 3).toFixed(1) + " GB";
const duration = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
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

// ---------- tabs ----------
let currentTab = "overview";
const loaders = {};
$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  currentTab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
  loaders[tab]?.();
});

// ---------- header: WhatsApp pill + bot switch ----------
async function refreshHeader() {
  try {
    const s = await api("whatsapp");
    const pill = $("#wa-pill");
    const map = { CONNECTED: ["WhatsApp connected", "ok"], SCAN_QR_CODE: ["WhatsApp: scan QR", "warn"], STARTING: ["WhatsApp starting…", "warn"] };
    const [text, cls] = map[s.status] ?? [`WhatsApp ${s.status.toLowerCase()}`, "bad"];
    pill.textContent = text;
    pill.className = `pill ${cls}`;
  } catch {}
}
$("#bot-enabled").addEventListener("change", async (e) => {
  try {
    await api("settings", { method: "PUT", body: { botEnabled: e.target.checked } });
    toast(e.target.checked ? "Bot is replying to customers" : "Bot paused: no automatic replies");
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
    ["Messages today", num(t.messagesToday), `${num(t.newChatsToday)} new chats today`],
    ["Conversations", num(t.chats), `${num(t.paused)} handled by a manager`],
    ["Leads", num(t.leads), "with saved details"],
    ["Ready to pay / paid", num(t.readyToPay), `${conv}% of leads`],
    ["Claude cost today", money(s.cost.today.usd), `${money(s.cost.month.usd)} last 30 days`],
  ]
    .map(([l, v, sub]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`)
    .join("");

  const max = Math.max(1, ...s.daily.map((d) => Math.max(d.incoming, d.new_chats)));
  $("#chart").innerHTML = s.daily
    .map(
      (d) => `<div class="col" title="${d.day}: ${d.incoming} messages, ${d.new_chats} new chats, ${d.ready} ready to pay, ${money(d.cost)}">
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
    ["Today", s.cost.today],
    ["Last 7 days", s.cost.week],
    ["Last 30 days", s.cost.month],
  ]
    .map(
      ([l, c]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${money(c.usd)}</div>
        <div class="sub">${num(c.calls)} calls · ${num(c.input)} in / ${num(c.output)} out tokens · ${num(c.cache_read)} cached</div></div>`,
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
        c.paused ? '<span class="tag paused">Manager</span>' : "",
        c.stage ? `<span class="tag ${HOT.has(c.stage) ? "hot" : ""}">${esc(STAGE_LABELS[c.stage] ?? c.stage)}</span>` : "",
      ].join(" ");
      return `<li data-id="${esc(c.chat_id)}" class="${c.chat_id === openChatId ? "active" : ""}">
        <div class="name"><span>${esc(c.lead_name || c.name || phone(c.chat_id))}</span><span>${tags}</span></div>
        <div class="preview">${c.last_direction !== "in" ? "↪ " : ""}${esc(c.last_text)}</div>
        <div class="preview">${esc(phone(c.chat_id))} · ${time(c.last_message_at)}</div></li>`;
    })
    .join("") || '<li class="muted">No conversations yet.</li>';
}

loaders.chats = async () => {
  chats = await api("chats");
  renderChatList();
  if (openChatId) openChat(openChatId, true);
};
$("#chat-search").addEventListener("input", renderChatList);
$("#chat-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) openChat(li.dataset.id);
});

async function openChat(id, keepScroll = false) {
  openChatId = id;
  renderChatList();
  const [{ chat, messages }, leads] = await Promise.all([api(`chats/${encodeURIComponent(id)}/messages`), api("leads")]);
  const lead = leads.find((l) => l.chatId === id);
  const view = $("#chat-view");
  const prevScroll = view.querySelector(".bubbles")?.scrollTop;
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
        <button class="btn" id="chat-pause">${chat?.paused ? "▶ Let bot reply" : "⏸ Take over (pause bot)"}</button>
        <button class="btn ghost" id="chat-reset" title="The bot forgets this conversation (messages stay here)">Reset bot memory</button>
      </div>
    </div>
    ${leadBits.length ? `<div class="lead-box">${leadBits.map(esc).join(" · ")}</div>` : ""}
    <div class="bubbles">${messages
      .map(
        (m) => `<div class="bubble ${m.direction}">${esc(m.text)}<div class="meta">${
          m.direction === "in" ? "Student" : m.direction === "out" ? "Bot" : "Manager"
        } · ${time(m.created_at)}</div></div>`,
      )
      .join("")}</div>
    <form id="chat-send" class="row">
      <input id="chat-text" placeholder="Write as the manager… (pauses the bot in this chat)" autocomplete="off" />
      <button class="btn primary" type="submit">Send</button>
    </form>`;
  const bubbles = view.querySelector(".bubbles");
  bubbles.scrollTop = keepScroll && prevScroll != null ? prevScroll : bubbles.scrollHeight;

  $("#chat-pause").onclick = async () => {
    await api(`chats/${encodeURIComponent(id)}/pause`, { method: "POST", body: { paused: !chat?.paused } });
    toast(chat?.paused ? "Bot will reply in this chat again" : "Bot paused in this chat");
    loaders.chats();
  };
  $("#chat-reset").onclick = async () => {
    if (!confirm("The bot will forget this conversation and start over with the next message. Continue?")) return;
    await api(`chats/${encodeURIComponent(id)}/reset`, { method: "POST" });
    toast("Bot memory reset for this chat");
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
$("#lead-filter").addEventListener("change", renderLeads);

function renderLeads() {
  const f = $("#lead-filter").value;
  const rows = leads.filter((l) => !f || l.stage === f);
  const stageSelect = (l) =>
    `<select data-lead="${esc(l.chatId)}">${Object.entries(STAGE_LABELS)
      .map(([k, v]) => `<option value="${k}" ${k === l.stage ? "selected" : ""}>${v}</option>`)
      .join("")}</select>`;
  $("#leads-table").innerHTML = `
    <tr><th>Name</th><th>Phone</th><th>Grade</th><th>Subjects</th><th>Specialty</th><th>Target</th><th>Parent phone</th><th>Payment</th><th>Stage</th><th>Updated</th></tr>
    ${rows
      .map(
        (l) => `<tr>
          <td>${esc(l.name || l.whatsappName || "—")}</td><td>${esc(phone(l.chatId))}</td><td>${esc(l.grade)}</td>
          <td>${esc(l.subjects)}</td><td>${esc(l.specialty)}</td><td>${esc(l.targetScore)}</td>
          <td>${esc(l.parentPhone)}</td><td>${esc(l.paymentPreference)}</td><td>${stageSelect(l)}</td><td>${time(l.updatedAt)}</td></tr>`,
      )
      .join("") || '<tr><td colspan="10" class="muted">No leads yet.</td></tr>'}`;
}
$("#leads-table").addEventListener("change", async (e) => {
  const id = e.target.dataset?.lead;
  if (!id) return;
  try {
    await api(`leads/${encodeURIComponent(id)}/stage`, { method: "POST", body: { stage: e.target.value } });
    toast("Stage updated");
  } catch (err) {
    toast(err.message);
  }
});
loaders.leads = async () => {
  leads = await api("leads");
  renderLeads();
};

// ---------- tuning ----------
loaders.tuning = async () => {
  const [{ script }, { settings, efforts, model }] = await Promise.all([api("script"), api("settings")]);
  $("#script").value = script;
  $("#script-status").textContent = "";
  $("#effort").innerHTML = efforts.map((e) => `<option ${e === settings.effort ? "selected" : ""}>${e}</option>`).join("");
  $("#paymentLink").value = settings.paymentLink;
  $("#adminPhone").value = settings.adminPhone;
  $("#model-name").textContent = `Model: ${model}`;
};
$("#script").addEventListener("input", () => ($("#script-status").textContent = "Unsaved changes"));
$("#save-script").addEventListener("click", async () => {
  try {
    await api("script", { method: "PUT", body: { script: $("#script").value } });
    $("#script-status").textContent = `Saved ${new Date().toLocaleTimeString()}`;
    toast("Script saved: the bot uses it from the next message");
  } catch (err) {
    toast(err.message);
  }
});
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("settings", {
      method: "PUT",
      body: { effort: $("#effort").value, paymentLink: $("#paymentLink").value, adminPhone: $("#adminPhone").value },
    });
    toast("Settings saved");
  } catch (err) {
    toast(err.message);
  }
});

let testHistory = [];
function renderTest() {
  const log = $("#test-log");
  log.innerHTML = testHistory
    .map((t) => `<div class="bubble ${t.role === "user" ? "in" : "out"}">${esc(t.text)}</div>`)
    .join("") || '<p class="muted small">Start by greeting the bot like a student would.</p>';
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
    testHistory.push({ role: "assistant", text: reply || "(no reply)" });
  } catch (err) {
    testHistory.push({ role: "assistant", text: `⚠️ ${err.message}` });
  } finally {
    btn.disabled = false;
    btn.textContent = "Send";
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
    CONNECTED: "✅ Connected",
    SCAN_QR_CODE: "📷 Waiting for QR scan",
    STARTING: "⏳ Starting…",
    STOPPED: "⏹ Not connected",
    FAILED: "❌ Failed",
  };
  const me = s.me?.id ? ` — ${esc(s.me.pushName ?? "")} ${esc(phone(s.me.id.replace(/:\d+/, "")))}` : "";
  $("#wa-status").innerHTML = `<strong>${labels[s.status] ?? s.status}</strong>${me}${
    s.detail && s.status !== "CONNECTED" ? `<div class="muted small">${esc(s.detail)}</div>` : ""
  }`;
  if (s.status === "SCAN_QR_CODE") {
    const { qr } = await api("whatsapp/qr");
    $("#wa-qr").innerHTML = qr ? `<img alt="WhatsApp QR code" src="${qr}" />` : '<p class="muted">Loading QR…</p>';
  } else if (s.status === "CONNECTED") {
    $("#wa-qr").innerHTML = '<p class="muted">✅ The number is linked. Nothing to scan.</p>';
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
    toast("Starting session… the QR appears in a few seconds");
    pollWhatsApp();
    setTimeout(refreshWhatsApp, 1500);
  } catch (err) {
    toast(err.message);
  }
});
$("#wa-restart").addEventListener("click", async () => {
  try {
    await api("whatsapp/restart", { method: "POST" });
    toast("Session restarting");
    pollWhatsApp();
  } catch (err) {
    toast(err.message);
  }
});
$("#wa-logout").addEventListener("click", async () => {
  if (!confirm("Unlink the store's WhatsApp number from the bot? You will need to scan a QR again.")) return;
  try {
    await api("whatsapp/logout", { method: "POST" });
    toast("Number unlinked");
    refreshWhatsApp();
  } catch (err) {
    toast(err.message);
  }
});
$("#pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const { code } = await api("whatsapp/pairing-code", { method: "POST", body: { phone: $("#pair-phone").value } });
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
    ["Bot uptime", duration(s.uptimeSec), `server up ${duration(s.hostUptimeSec)}`],
    ["CPU load", s.load[0].toFixed(2), `${s.cpus} cores · 5m ${s.load[1].toFixed(2)}`],
    ["Memory", `${Math.round((memUsed / s.memory.total) * 100)}%`, `${bytes(memUsed)} of ${bytes(s.memory.total)} · bot ${Math.round(s.memory.process / 1048576)} MB`],
    ["Disk", `${Math.round((diskUsed / s.disk.total) * 100)}%`, `${bytes(s.disk.free)} free of ${bytes(s.disk.total)}`],
    ["Setup", s.provider.toUpperCase(), `${esc(s.model)} · Node ${esc(s.node)}`],
  ]
    .map(([l, v, sub]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`)
    .join("");
  await loadLogs();
};
async function loadLogs() {
  const { lines } = await api("logs");
  const pre = $("#logs");
  pre.textContent = lines.join("\n") || "No logs yet.";
  pre.scrollTop = pre.scrollHeight;
}
$("#logs-refresh").addEventListener("click", loadLogs);
$("#restart-bot").addEventListener("click", async () => {
  if (!confirm("Restart the bot? It will be offline for a few seconds.")) return;
  await api("restart", { method: "POST" }).catch(() => {});
  toast("Restarting… reload the page in ~10 seconds");
});

// ---------- start ----------
async function start() {
  const { authed } = await api("me");
  if (!authed) return showLogin();
  showApp();
  const { settings } = await api("settings");
  $("#bot-enabled").checked = settings.botEnabled;
  refreshHeader();
  loaders[currentTab]();
  setInterval(() => {
    if (document.hidden) return;
    refreshHeader();
    if (currentTab === "overview" || currentTab === "chats") loaders[currentTab]().catch(() => {});
  }, 15000);
}
start().catch((err) => toast(err.message));
