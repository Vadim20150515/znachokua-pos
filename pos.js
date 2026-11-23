// Каса ЗначокUA: вхід, ролі, склад, продажі. Підключається в server.js
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const FILE = process.env.POS_DB || path.join(__dirname, "pos-data.json");
const OWNER = (process.env.POS_OWNER_EMAIL || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const OWNER_PW = process.env.POS_OWNER_PASSWORD || process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.SITE_KEY || crypto.randomBytes(32).toString("hex");
let db = { users: [], products: [], sales: [], log: [], settings: { name: "ЗначокUA" } };
try { Object.assign(db, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch {}
if (!db.products.length) db.products = [["Маленький значок", 15], ["Середній значок", 25], ["Великий значок", 35]].map(([name, price], i) => ({ id: i + 1, name, price, stock: 100, code: "", min: 10 }));
const save = () => { try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(db)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { console.error("pos save:", e.message); } };
const cfg = () => ({ name: "ЗначокUA", methods: { cash: true, card: true }, receipt: { head: "", foot: "Дякуємо за покупку! 💛", showCashier: true }, ...db.settings });
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const hash = pw => { const s = crypto.randomBytes(16).toString("hex"); return s + ":" + crypto.scryptSync(pw, s, 32).toString("hex"); };
const check = (pw, h) => { if (!h) return false; const [s, x] = h.split(":"); return crypto.timingSafeEqual(crypto.scryptSync(pw, s, 32), Buffer.from(x, "hex")); };
const sign = e => { const p = Buffer.from(JSON.stringify({ e, x: Date.now() + 12 * 36e5 })).toString("base64url"); return p + "." + crypto.createHmac("sha256", SECRET).update(p).digest("base64url"); };
const who = req => {
  const [p, sg] = (req.headers.authorization || "").replace("Bearer ", "").split(".");
  if (!p || !sg || !same(sg, crypto.createHmac("sha256", SECRET).update(p).digest("base64url"))) return null;
  let d; try { d = JSON.parse(Buffer.from(p, "base64url")); } catch { return null; }
  if (d.x < Date.now()) return null;
  if (OWNER && d.e === OWNER) return { email: OWNER, name: "Власник", role: "owner" };
  const u = db.users.find(u => u.email === d.e && u.hash);
  return u ? { email: u.email, name: u.name, role: u.role } : null;
};
const fails = {};
const locked = k => fails[k] && fails[k].n >= 5 && Date.now() - fails[k].t < 6e5;
const fail = k => { const f = fails[k]; fails[k] = { n: (f && Date.now() - f.t < 6e5 ? f.n : 0) + 1, t: Date.now() }; };

module.exports = async (req, res, url) => {
  const send = (c, o) => { res.writeHead(c, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); };
  try {
    const p = url.pathname.slice(9);
    let b = {};
    if (req.method === "POST") { let s = ""; for await (const c of req) { s += c; if (s.length > 2e5) throw new Error("Завеликий запит"); } b = s ? JSON.parse(s) : {}; }
    const em = String(b.email || "").trim().toLowerCase();

    if (p === "login") {
      if (locked(em)) return send(429, { error: "Забагато спроб. Спробуйте через 10 хвилин" });
      const u = db.users.find(x => x.email === em);
      const ok = OWNER && OWNER_PW && em === OWNER ? same(b.password || "", OWNER_PW) : u && check(String(b.password || ""), u.hash);
      if (!ok) { fail(em); return send(401, { error: "Невірний email або пароль" }); }
      delete fails[em];
      return send(200, { token: sign(em) });
    }
    if (p === "register") {
      const k = "r:" + em, u = db.users.find(x => x.email === em);
      if (locked(k)) return send(429, { error: "Забагато спроб. Спробуйте через 10 хвилин" });
      if (!u || !u.otp || !check(String(b.otp || "").trim().toUpperCase(), u.otp)) { fail(k); return send(401, { error: "Невірний email або одноразовий пароль" }); }
      if (String(b.password || "").length < 10) throw new Error("Пароль має містити щонайменше 10 символів");
      u.hash = hash(String(b.password)); u.otp = null; save();
      return send(200, { token: sign(em) });
    }

    const me = who(req);
    if (!me) return send(401, { error: "Потрібен вхід" });
    const need = (...r) => { if (!r.includes(me.role)) throw new Error("Недостатньо прав для цієї дії"); };
    const log = a => { db.log.unshift({ t: new Date().toISOString(), u: me.name, a }); if (db.log.length > 1000) db.log.length = 1000; };
    const prod = id => db.products.find(x => x.id === id);

    if (p === "verify") { // пароль відповідального (власник / адміністратор / заступник)
      const k = "v:" + me.email;
      if (locked(k)) return send(429, { error: "Забагато спроб. Спробуйте через 10 хвилин" });
      const pw = String(b.password || ""); let by = null;
      if (OWNER && OWNER_PW && same(pw, OWNER_PW)) by = "Власник";
      else { const u = db.users.find(x => ["admin", "deputy"].includes(x.role) && x.hash && check(pw, x.hash)); if (u) by = u.name; }
      if (!by) { fail(k); return send(403, { error: "Невірний пароль відповідального" }); }
      delete fails[k]; log(`Правка чека (${String(b.what || "").slice(0, 60)}), схвалив: ${by}`); save(); return send(200, { by });
    }
    if (p === "state") return send(200, {
      user: me, settings: cfg(), products: db.products,
      sales: (me.role === "cashier" ? db.sales.filter(s => s.by === me.email) : db.sales).slice(0, 1000),
      log: me.role === "cashier" ? [] : db.log.slice(0, 600),
      partners: ["owner", "admin", "deputy"].includes(me.role) ? db.partners || [] : [],
      promos: ["owner", "admin"].includes(me.role) ? db.promos || [] : [],
      expenses: ["owner", "admin"].includes(me.role) ? db.expenses || [] : [],
      users: ["owner", "admin"].includes(me.role) ? db.users.map(u => ({ email: u.email, name: u.name, role: u.role, active: !!u.hash })) : []
    });

    if (p === "product") {
      need("owner", "admin", "deputy");
      const name = String(b.name || "").trim().slice(0, 80), price = Math.round(+b.price * 100) / 100;
      if (!name || !(price >= 0)) throw new Error("Вкажіть назву та ціну");
      let x = prod(b.id);
      if (!x) { x = { id: Date.now(), stock: Math.max(0, Math.floor(+b.stock || 0)) }; db.products.push(x); }
      Object.assign(x, { name, price, cat: String(b.cat || "").trim().slice(0, 40) || "Значки", code: String(b.code || "").slice(0, 40), min: Math.max(0, Math.floor(+b.min || 0)) });
      log("Товар збережено: " + name); save(); return send(200, { products: db.products });
    }
    if (p === "product/del") {
      need("owner", "admin"); const x = prod(b.id); if (!x) throw new Error("Товар не знайдено");
      db.products = db.products.filter(y => y !== x); log("Товар видалено: " + x.name); save(); return send(200, { products: db.products });
    }
    if (p === "stock") {
      need("owner", "admin", "deputy"); const x = prod(b.id), q = Math.floor(+b.qty);
      if (!x || !(q >= 0) || !["supply", "make", "inv"].includes(b.type)) throw new Error("Некоректні дані");
      if (b.type === "inv") { log(`Інвентаризація: ${x.name} було ${x.stock}, стало ${q}`); x.stock = q; }
      else { x.stock += q; log(`${b.type === "supply" ? "Постачання" : "Виробництво"}: ${x.name} +${q}${b.note ? " (" + String(b.note).slice(0, 80) + ")" : ""}`); }
      save(); return send(200, { products: db.products });
    }
    if (p === "sale") {
      const bak = db.products.map(x => x.stock);
      try {
        const items = []; let sum = 0;
        for (const i of b.items || []) {
          const x = prod(i.id), q = Math.floor(+i.q);
          if (!x || !(q >= 1)) throw new Error("Некоректний товар у чеку");
          if (x.stock < q) throw new Error("Недостатньо на складі: " + x.name);
          x.stock -= q; items.push({ id: x.id, name: x.name, price: x.price, q }); sum += x.price * q;
        }
        if (!items.length) throw new Error("Чек порожній");
        let disc = Math.min(90, Math.max(0, +b.disc || 0));
        if (b.promo) { const pr = (db.promos || []).find(x => x.code === String(b.promo).trim().toUpperCase()); if (!pr) throw new Error("Промокод не знайдено"); disc = pr.percent; }
        sum = Math.round(sum * (100 - disc)) / 100;
        const method = b.method === "card" ? "card" : "cash", given = method === "cash" ? Math.max(0, +b.given || 0) : 0;
        if (!cfg().methods[method]) throw new Error("Цей метод оплати вимкнений");
        if (given && given < sum) throw new Error("Отримана сума менша за суму чеку");
        const s = { no: db.sales.reduce((m, y) => Math.max(m, y.no), 0) + 1, t: new Date().toISOString(), items, disc, sum, method, given, client: String(b.client || "").slice(0, 100), by: me.email, byName: me.name };
        db.sales.unshift(s); log(`Продаж №${s.no} на ${sum} ₴`); save(); return send(200, { sale: s, products: db.products });
      } catch (e) { db.products.forEach((x, i) => { x.stock = bak[i]; }); throw e; }
    }
    if (p === "sale/del") {
      need("owner", "admin"); const s = db.sales.find(x => x.no === b.no); if (!s) throw new Error("Чек не знайдено");
      s.items.forEach(i => { const x = prod(i.id); if (x) x.stock += i.q; });
      db.sales = db.sales.filter(x => x !== s); log("Чек видалено №" + s.no); save(); return send(200, { products: db.products });
    }

    if (p === "user/invite") {
      need("owner", "admin");
      const allowed = me.role === "owner" ? ["admin", "deputy", "cashier"] : ["deputy", "cashier"], name = String(b.name || "").trim().slice(0, 60);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || !name) throw new Error("Вкажіть email та ім'я");
      if (!allowed.includes(b.role)) throw new Error("Ви не можете створити цю роль");
      if (em === OWNER) throw new Error("Цей email належить власнику");
      let u = db.users.find(x => x.email === em);
      if (u && u.hash) throw new Error("Працівник з таким email уже зареєстрований");
      if (!u) { u = { email: em }; db.users.push(u); }
      const otp = Array.from(crypto.randomBytes(8), x => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x % 32]).join("");
      Object.assign(u, { name, role: b.role, hash: null, otp: hash(otp) });
      log(`Запрошено працівника ${name} (${b.role})`); save(); return send(200, { otp });
    }
    if (p === "user/del") {
      need("owner", "admin"); const u = db.users.find(x => x.email === em);
      if (!u) throw new Error("Працівника не знайдено");
      if (me.role === "admin" && !["deputy", "cashier"].includes(u.role)) throw new Error("Недостатньо прав");
      db.users = db.users.filter(x => x !== u); log("Працівника видалено: " + u.name); save(); return send(200, { ok: 1 });
    }
    if (p === "password") {
      if (me.role === "owner") throw new Error("Пароль власника змінюється в налаштуваннях сервера (змінна POS_OWNER_PASSWORD)");
      const u = db.users.find(x => x.email === me.email);
      if (!check(String(b.old || ""), u.hash)) throw new Error("Старий пароль невірний");
      if (String(b.new || "").length < 10) throw new Error("Пароль має містити щонайменше 10 символів");
      u.hash = hash(String(b.new)); save(); return send(200, { ok: 1 });
    }
    if (p === "promo/check") {
      const pr = (db.promos || []).find(x => x.code === String(b.code || "").trim().toUpperCase());
      if (!pr) throw new Error("Промокод не знайдено"); return send(200, { percent: pr.percent });
    }
    if (p === "coll") { // партнери / промокоди / витрати
      const RL = { partners: ["owner", "admin", "deputy"], promos: ["owner", "admin"], expenses: ["owner", "admin"] };
      if (!RL[b.c]) throw new Error("Невідомий розділ"); need(...RL[b.c]);
      const L = db[b.c] = db[b.c] || [];
      if (b.del) { db[b.c] = L.filter(x => x.id !== b.id); log("Видалено запис (" + b.c + ")"); }
      else {
        const d = b.d || {}, t = (v, n) => String(v || "").trim().slice(0, n); const x = { id: Date.now() };
        if (b.c === "partners") { x.name = t(d.name, 80); x.phone = t(d.phone, 30); x.note = t(d.note, 200); if (!x.name) throw new Error("Вкажіть назву"); }
        if (b.c === "promos") {
          x.code = t(d.code, 20).toUpperCase(); x.percent = Math.floor(+d.percent);
          if (!/^[A-Z0-9_-]{3,20}$/.test(x.code) || !(x.percent >= 1 && x.percent <= 90)) throw new Error("Код: 3-20 латинських літер або цифр; знижка 1-90%");
          if (L.some(y => y.code === x.code)) throw new Error("Такий код уже є");
        }
        if (b.c === "expenses") { x.t = new Date().toISOString(); x.cat = t(d.cat, 40) || "Інше"; x.amount = Math.round(+d.amount * 100) / 100; x.note = t(d.note, 120); if (!(x.amount > 0)) throw new Error("Вкажіть суму витрат"); }
        L.unshift(x); log("Додано запис (" + b.c + ")");
      }
      save(); return send(200, { coll: db[b.c] });
    }
    if (p === "settings") {
      need("owner");
      if (b.name !== undefined) db.settings.name = String(b.name || "ЗначокUA").slice(0, 40);
      if (b.methods) { const m = { cash: !!b.methods.cash, card: !!b.methods.card }; if (!m.cash && !m.card) throw new Error("Має бути увімкнений хоча б один метод оплати"); db.settings.methods = m; }
      if (b.receipt) db.settings.receipt = { head: String(b.receipt.head || "").slice(0, 120), foot: String(b.receipt.foot || "").slice(0, 160), showCashier: !!b.receipt.showCashier };
      log("Налаштування змінено"); save(); return send(200, { settings: cfg() });
    }
    send(404, { error: "Маршрут не знайдено" });
  } catch (e) { if (!res.headersSent) send(400, { error: e.message || "Помилка запиту" }); }
};
