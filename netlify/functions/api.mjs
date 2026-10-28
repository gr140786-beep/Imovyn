// imovyn: servidor de cobrança pelo Mercado Pago (mesmo método do OrçaHub), cobrando por IMOBILIÁRIA.
//   /api/assinatura  -> o app pede para assinar ou cancelar
//   /api/mp-webhook  -> o Mercado Pago avisa quando uma assinatura é autorizada ou uma cobrança é paga
// Variáveis na Netlify: MP_ACCESS_TOKEN e FIREBASE_SERVICE_ACCOUNT (opcional: PRECO_MENSAL, PRECO_ANUAL).
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export const PLANOS = (env = {}) => ({
  mensal: { valor: Number(env.PRECO_MENSAL || 229.9), meses: 1, nome: "imovyn Mensal" },
  anual: { valor: Number(env.PRECO_ANUAL || 1890), meses: 12, nome: "imovyn Anual" },
});
const TID_PRINCIPAL = "principal"; // cliente fundador (Alto Lar): dados na raiz do banco
export function addMonthsISO(iso, months, extraDays = 0) {
  const d = new Date(String(iso).slice(0, 10) + "T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
}
const dia = (s) => String(s || "").slice(0, 10);
const tidValido = (t) => /^[a-z0-9]{6,40}$/.test(String(t || ""));

// POST /api/assinatura  { acao: "assinar"|"cancelar", plano, forma: "cartao"|"pix", tid, site }
export async function handleAssinatura(body, token, deps, env = {}) {
  if (!token) return { status: 401, json: { erro: "Entre com sua conta para assinar." } };
  let user;
  try { user = await deps.verify(token); } catch (e) { return { status: 401, json: { erro: "Sua sessão expirou. Entre de novo." } }; }
  const tid = String(body.tid || "");
  if (!tidValido(tid)) return { status: 400, json: { erro: "Imobiliária não encontrada." } };
  if (!(await deps.ehAdmin(tid, String(user.email || "").toLowerCase()))) return { status: 403, json: { erro: "Só o administrador da imobiliária pode assinar." } };
  const cur = (await deps.db.get(tid)) || {};
  const hoje = deps.today();

  if (body.acao === "cancelar") {
    if (!cur.mpAssinatura || cur.status === "cancelada") return { status: 400, json: { erro: "Você não tem assinatura ativa." } };
    await deps.mp("/preapproval/" + cur.mpAssinatura, { method: "PUT", body: { status: "cancelled" } });
    await deps.db.set(tid, { status: "cancelada", canceladaEm: hoje }, true);
    return { status: 200, json: { ok: true } };
  }

  const plano = PLANOS(env)[body.plano];
  if (!plano) return { status: 400, json: { erro: "Escolha um plano." } };
  if (!user.email) return { status: 400, json: { erro: "Sua conta precisa ter um e-mail para assinar." } };
  const site = String(body.site || "").replace(/\/+$/, "") || "https://imovyn.netlify.app";

  // Pix ou débito: pagamento avulso (Checkout Pro), vale 1 período e não renova sozinho.
  if (body.forma === "pix") {
    const pref = await deps.mp("/checkout/preferences", { method: "POST", body: {
      items: [{ id: "imovyn-" + body.plano, title: plano.nome, quantity: 1, unit_price: plano.valor, currency_id: "BRL" }],
      payer: { email: user.email },
      external_reference: tid + "|" + body.plano,
      payment_methods: { excluded_payment_types: [{ id: "credit_card" }, { id: "ticket" }, { id: "prepaid_card" }], installments: 1 },
      back_urls: { success: site + "/?assinatura=ok", pending: site + "/?assinatura=ok", failure: site + "/" },
      auto_return: "approved",
      notification_url: site + "/api/mp-webhook?source=pix",
    } });
    if (!pref || !pref.init_point) return { status: 502, json: { erro: "O Mercado Pago não abriu o pagamento agora. Tente de novo em instantes." } };
    await deps.db.set(tid, { pixPendente: pref.id, atualizado: hoje }, true);
    return { status: 200, json: { url: pref.init_point } };
  }

  // Cartão de crédito: assinatura com renovação automática.
  const auto = { frequency: plano.meses, frequency_type: "months", transaction_amount: plano.valor, currency_id: "BRL" };
  if (cur.validoAte && cur.validoAte > hoje && cur.status !== "cancelada") auto.start_date = cur.validoAte + "T12:00:00.000-03:00";
  const pre = await deps.mp("/preapproval", { method: "POST", body: {
    reason: plano.nome, external_reference: tid, payer_email: user.email,
    auto_recurring: auto, back_url: site + "/?assinatura=ok", status: "pending",
  } });
  if (!pre || !pre.init_point) return { status: 502, json: { erro: "O Mercado Pago não abriu o pagamento agora. Tente de novo em instantes." } };
  await deps.db.set(tid, { mpPendente: pre.id, planoPendente: body.plano, linkPagamento: pre.init_point, atualizado: hoje }, true);
  return { status: 200, json: { url: pre.init_point } };
}

// POST /api/mp-webhook. Nada do aviso é usado direto: o servidor sempre consulta o Mercado Pago de novo.
export async function handleWebhook(evento, query, deps, env = {}) {
  const tipo = (evento && (evento.type || evento.topic)) || (query && (query.type || query.topic)) || "";
  const id = String((evento && evento.data && evento.data.id) || (query && (query["data.id"] || query.id)) || "");
  if (!id) return { status: 200, text: "ignorado" };

  if (tipo === "payment") {
    const pg = await deps.mp("/v1/payments/" + id, { method: "GET" });
    const ref = String((pg && pg.external_reference) || "");
    if (!ref.includes("|")) return { status: 200, text: "ignorado" };
    const [ptid, pk] = ref.split("|");
    const pl = PLANOS(env)[pk];
    if (!pl || !tidValido(ptid)) return { status: 200, text: "plano desconhecido" };
    const cur0 = (await deps.db.get(ptid)) || {};
    const hist0 = cur0.historico || [];
    if (pg.status === "approved") {
      if (hist0.some((h) => h.id === String(pg.id) && h.evento === "PAYMENT_RECEIVED")) return { status: 200, text: "ja processado" };
      const hoje = deps.today();
      const base = cur0.validoAte && cur0.validoAte > hoje ? cur0.validoAte : hoje;
      const h = { id: String(pg.id), valor: pg.transaction_amount, vencimento: dia(pg.date_approved || pg.date_created) || hoje, evento: "PAYMENT_RECEIVED", em: hoje };
      await deps.db.set(ptid, { status: "ativa", plano: pk, forma: "pix", valor: pg.transaction_amount, validoAte: addMonthsISO(base, pl.meses, 0), pixPendente: null, linkPagamento: "",
        historico: [h, ...hist0.filter((x) => x.id !== h.id)].slice(0, 24) }, true);
      return { status: 200, text: "ok" };
    }
    return { status: 200, text: "aguardando" };
  }

  let pre, pagamento = null;
  if (tipo === "subscription_preapproval" || tipo === "preapproval") {
    pre = await deps.mp("/preapproval/" + id, { method: "GET" });
  } else if (tipo === "subscription_authorized_payment" || tipo === "authorized_payment") {
    pagamento = await deps.mp("/authorized_payments/" + id, { method: "GET" });
    if (!pagamento || !pagamento.preapproval_id) return { status: 200, text: "sem assinatura" };
    pre = await deps.mp("/preapproval/" + pagamento.preapproval_id, { method: "GET" });
  } else {
    return { status: 200, text: "ignorado" };
  }
  const tid = pre && pre.external_reference;
  if (!tid || !tidValido(tid)) return { status: 200, text: "sem imobiliaria" };
  const cur = (await deps.db.get(tid)) || {};
  const plano = (pre.auto_recurring && pre.auto_recurring.frequency) === 12 ? "anual" : "mensal";
  const meses = plano === "anual" ? 12 : 1;
  const ehNova = cur.mpPendente === pre.id;
  const ehAtual = cur.mpAssinatura === pre.id;
  if (!ehNova && !ehAtual) return { status: 200, text: "assinatura antiga" };

  const upd = {};
  if (ehNova && pre.status === "authorized") {
    if (cur.mpAssinatura && cur.mpAssinatura !== pre.id) {
      try { await deps.mp("/preapproval/" + cur.mpAssinatura, { method: "PUT", body: { status: "cancelled" } }); } catch (e) { /* já encerrada */ }
    }
    Object.assign(upd, { mpAssinatura: pre.id, mpPendente: null, plano, forma: "cartao", valor: pre.auto_recurring.transaction_amount, linkPagamento: "" });
    if (cur.status !== "ativa") upd.status = "pendente";
  }
  if (pagamento) {
    const hist = { id: String(pagamento.id), valor: pagamento.transaction_amount, vencimento: dia(pagamento.debit_date || pagamento.date_created), evento: "", em: deps.today() };
    const pst = (pagamento.payment && pagamento.payment.status) || pagamento.status;
    if (pst === "approved" || pst === "processed") {
      hist.evento = "PAYMENT_RECEIVED";
      const ate = addMonthsISO(dia(pagamento.debit_date || pagamento.date_created) || deps.today(), meses, 3);
      upd.validoAte = cur.validoAte && cur.validoAte > ate ? cur.validoAte : ate;
      upd.status = "ativa";
    } else if (pst === "rejected" || pst === "recycling" || pst === "cancelled") {
      hist.evento = "PAYMENT_OVERDUE";
      if (cur.status === "ativa") upd.status = "atrasada";
    } else {
      hist.evento = "PAYMENT_CREATED";
    }
    upd.historico = [hist, ...((cur.historico || []).filter((h) => h.id !== hist.id))].slice(0, 24);
  } else if (ehAtual || (ehNova && pre.status === "authorized")) {
    if (pre.status === "cancelled") upd.status = "cancelada";
    else if (pre.status === "paused") upd.status = "atrasada";
  }
  if (Object.keys(upd).length) await deps.db.set(tid, upd, true);
  return { status: 200, text: "ok" };
}

const env = process.env;
function firebase() {
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
  return { auth: getAuth(), store: getFirestore() };
}
async function mp(path, opts = {}) {
  const r = await fetch("https://api.mercadopago.com" + path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.MP_ACCESS_TOKEN },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || (j.cause && j.cause[0] && j.cause[0].description) || "Mercado Pago respondeu " + r.status);
  return j;
}
function realDeps() {
  const { auth, store } = firebase();
  const col = store.collection("assinaturas");
  return {
    mp,
    verify: async (token) => { const u = await auth.verifyIdToken(token); return { uid: u.uid, email: u.email, name: u.name }; },
    ehAdmin: async (tid, email) => {
      const pre = tid === TID_PRINCIPAL ? "" : "imob/" + tid + "/";
      const dono = await store.doc(pre + "meta/dono").get();
      if (dono.exists && String(dono.data().email || "").toLowerCase() === email) return true;
      const m = await store.doc(pre + "membros/" + email).get();
      return m.exists && m.data().papel === "admin" && m.data().ativo !== false;
    },
    db: {
      get: async (tid) => { const s = await col.doc(tid).get(); return s.exists ? s.data() : null; },
      set: async (tid, data, merge) => col.doc(tid).set(data, { merge: !!merge }),
    },
    today: () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10),
  };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/mp-webhook")) {
    if (req.method !== "POST") return new Response("ok");
    try {
      const evento = await req.json().catch(() => ({}));
      const r = await handleWebhook(evento, Object.fromEntries(url.searchParams), realDeps(), env);
      return new Response(r.text, { status: r.status });
    } catch (e) {
      return new Response("erro: " + (e.message || ""), { status: 500 });
    }
  }
  if (req.method !== "POST") return json({ erro: "Use POST" }, 405);
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const body = await req.json().catch(() => ({}));
    const r = await handleAssinatura(body, token, realDeps(), env);
    return json(r.json, r.status);
  } catch (e) {
    return json({ erro: "Não deu para concluir agora: " + (e.message || "erro") }, 500);
  }
};
export const config = { path: ["/api/assinatura", "/api/mp-webhook"] };
