import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const {
  META_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  FACTURAPI_KEY,
  EMISOR_RFC,
  EMISOR_REGIMEN,
  LUGAR_EXP
} = process.env;

// Sesiones en memoria (para demo)
const sessions = new Map();

// 1) Verificación del webhook de Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Recepción de mensajes de WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from; // número del cliente
    const text = (msg.text?.body || "").trim();

    // Pasos mínimos CFDI 4.0
    const steps = [
      { key: "rfc",        q: "Para facturar, comparte tu RFC (receptor)." },
      { key: "cp",         q: "¿Cuál es tu Código Postal fiscal (SAT)?" },
      { key: "regimen",    q: "¿Tu régimen fiscal (clave, ej. 612/601/605)?" },
      { key: "nombre",     q: "Nombre/Razón social EXACTO como en SAT." },
      { key: "uso",        q: "Uso CFDI (ej. G03)." },
      { key: "metodo",     q: "Método de pago (PUE o PPD)." },
      { key: "forma",      q: "Forma de pago SAT (01 Efectivo, 03 Transferencia, 04 TDC, etc.)." },
      { key: "descripcion",q: "Descripción del servicio/venta." },
      { key: "importe",    q: "Importe SIN IVA (ej. 1008.62)." }
    ];

    // Sesión del usuario
    const s = sessions.get(from) || { step: 0, data: {} };

    // Arranque
    if (s.step === 0 && /factura/i.test(text)) {
      s.step = 1;
      sessions.set(from, s);
      await waText(from, steps[0].q);
      return res.sendStatus(200);
    }

    // Guardar respuesta actual
    if (s.step > 0 && s.step <= steps.length && text) {
      const prev = steps[s.step - 1];
      s.data[prev.key] = text;
    }

    // ¿Faltan pasos?
    if (s.step < steps.length) {
      s.step++;
      sessions.set(from, s);
      await waText(from, steps[s.step - 1].q);
      return res.sendStatus(200);
    }

    // 3) Emitir CFDI en Facturapi
    const customer = await facturapiCreateCustomer({
      legal_name: s.data.nombre,
      tax_id: s.data.rfc,
      tax_system: s.data.regimen,
      address: { zip: s.data.cp, country: "MEX" }
    });

    const invoice = await facturapiCreateInvoice({
      customer: customer.id,
      items: [{
        quantity: 1,
        product: {
          description: s.data.descripcion,
          product_key: 80141600,   // Servicios profesionales (ejemplo)
          unit_key: "E48",
          price: parseFloat(s.data.importe),
          tax_included: false,
          taxability: "01",
          taxes: [{ type: "IVA", rate: 0.16 }]
        }
      }],
      payment_form: s.data.forma,
      payment_method: s.data.metodo.toUpperCase(),
      use: s.data.uso,
      type: "I",
      external_id: `WA-${from}-${Date.now()}`,
      issuer: {
        tax_id: EMISOR_RFC,
        tax_system: EMISOR_REGIMEN,
        address: { zip: LUGAR_EXP, country: "MEX" }
      }
    });

    await waText(from, `✅ Factura emitida.\nUUID: ${invoice.uuid}\nVerificación SAT: ${invoice.verification_url}`);

    sessions.delete(from);
    res.sendStatus(200);

  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// === WhatsApp ===
async function waText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${META_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } })
  });
}

// === Facturapi ===
const FACTURAPI_BASE = "https://www.facturapi.io/v2";

async function facturapiCreateCustomer(payload) {
  const r = await fetch(`${FACTURAPI_BASE}/customers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${FACTURAPI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function facturapiCreateInvoice(payload) {
  const r = await fetch(`${FACTURAPI_BASE}/invoices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${FACTURAPI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const listener = app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor listo en puerto", listener.address().port);
});
