import express from "express";

const app = express();
app.use(express.json());
const PORT = 4000;

function normNumber(s) {
  if (!s) return "";
  s = s.replace(/\s+/g, "");
  if (/[\d]\.[\d]{3}[\.,]/.test(s)) s = s.replace(/\./g, "");
  s = s.replace(",", ".");
  s = s.replace(/[^0-9.\-]/g, "");
  return s;
}
const pick = (...v)=>v.find(Boolean);

function cleanKey(line){
  return line
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g," ")
    .replace(/\bi\s+v\s+a\b/g,"iva")
    .replace(/\bc\s+u\s+i\s+t\b/g,"cuit")
    .replace(/\s+/g," ")
    .trim();
}

function cloneRegex(re){
  return new RegExp(re.source, re.flags);
}

function matchGroup(text, regex, group = 1){
  const re = cloneRegex(regex);
  const match = re.exec(text);
  return match ? match[group] : "";
}

function formatCuitFromDigits(digits){
  if (digits.length !== 11) return "";
  return `${digits.slice(0,2)}-${digits.slice(2,10)}-${digits.slice(10)}`;
}

function parseCliente(text){
  const rawLines = text.split(/\r?\n/);
  const trimmed = rawLines.map(l=>l.trim());
  let razon = "";
  let razonIndex = -1;
  let domicilio = "";

  for (let i = 0; i < trimmed.length; i++) {
    const m = trimmed[i].match(/Raz[oó]n\s*Social[:\s-]+(.+)/i);
    if (m && m[1].trim()) {
      razon = m[1].trim();
      razonIndex = i;
      break;
    }
  }

  if (!razon) {
    for (let i = 1; i < trimmed.length; i++) {
      if (/CUIT/i.test(trimmed[i]) && trimmed[i - 1] && !/Factura|Comprobante|TOTAL|IVA/i.test(trimmed[i - 1])) {
        razon = trimmed[i - 1];
        razonIndex = i - 1;
        break;
      }
    }
  }

  if (!razon) {
    for (let i = 0; i < trimmed.length; i++) {
      const line = trimmed[i];
      if (!line) continue;
      if (/^[A-ZÁÉÍÓÚÑ&\s\.]{6,}$/.test(line) && !/FACTURA|COMPROBANTE|DOMICILIO|IVA|TOTAL|SUBTOTAL|CONDICI[ÓO]N|CUIT|RESPONSABLE/i.test(line)) {
        razon = line;
        razonIndex = i;
        break;
      }
    }
  }

  razon = razon.replace(/Domicilio.*$/i,"").replace(/\s{2,}/g," ").trim();

  const domicilioRegex = /Domicilio[:\s-]+(.+)/i;
  function sanitizeAddress(value){
    return value.replace(/^\s*[:\-]/,"").replace(/\s{2,}/g," ").trim();
  }

  if (razonIndex >= 0) {
    for (let j = razonIndex; j < Math.min(trimmed.length, razonIndex + 8); j++) {
      const line = trimmed[j];
      if (!line) continue;
      const dm = line.match(domicilioRegex);
      if (dm && dm[1].trim()) {
        domicilio = sanitizeAddress(dm[1]);
        if (!domicilio && trimmed[j + 1]) domicilio = sanitizeAddress(trimmed[j + 1]);
        break;
      }
      if (/^Domicilio$/i.test(line) && trimmed[j + 1]) {
        domicilio = sanitizeAddress(trimmed[j + 1]);
        break;
      }
    }
  }

  if (!domicilio) {
    const dm = text.match(/Domicilio[:\s-]+([^\n\r]+)/i);
    if (dm && dm[1].trim()) domicilio = sanitizeAddress(dm[1]);
  }

  domicilio = domicilio.replace(/Domicilio[:\s-]*/i,"").trim();

  const cuitRegex = /(\d{2})\D?(\d{8})\D?(\d)/;
  let cuit = "";

  if (razonIndex >= 0) {
    for (let j = razonIndex; j < Math.min(trimmed.length, razonIndex + 6); j++) {
      const m = trimmed[j].match(cuitRegex);
      if (m) {
        cuit = `${m[1]}-${m[2]}-${m[3]}`;
        break;
      }
      const digits = trimmed[j].replace(/\D/g, "");
      if (digits.length === 11) {
        cuit = formatCuitFromDigits(digits);
        break;
      }
    }
  }

  if (!cuit) {
    const matches = Array.from(text.matchAll(/(\d{2})\D?(\d{8})\D?(\d)/g)).map(m => ({
      value: `${m[1]}-${m[2]}-${m[3]}`,
      index: m.index ?? 0
    }));
    if (matches.length) {
      if (razonIndex >= 0) {
        const anchor = trimmed[razonIndex];
        const anchorPos = anchor ? text.indexOf(anchor) : -1;
        const after = anchorPos >= 0 ? matches.filter(m => m.index >= anchorPos) : [];
        cuit = (after[0] || matches[matches.length - 1]).value;
      } else {
        cuit = matches[matches.length - 1].value;
      }
    }
  }

  return { razon_social: razon, cuit, domicilio };
}

function findAmount(lines, keywords){
  function extractAmount(str){
    const decimal = str.match(/(\d[\d\s\.]*[.,]\d{2})/);
    if (decimal) return decimal[1];
    const bigInt = str.match(/(\d{5,})/);
    return bigInt ? bigInt[1] : "";
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const key = cleanKey(raw);
    if (!key) continue;
    if (keywords.some(k => key.includes(k))) {
      const found = extractAmount(raw);
      if (found) return normNumber(found);
      const next = lines[i + 1] || "";
      const nextFound = extractAmount(next);
      if (nextFound) return normNumber(nextFound);
    }
  }
  return "";
}

const AMOUNT_MAP = [
  { key: "importe_neto_gravado", keywords: ["importe neto gravado", "importe neto grabado", "neto gravado", "neto grabado", "subtotal"] },
  { key: "importe_neto_no_gravado", keywords: ["importe neto no gravado", "importe neto no grabado", "no gravado", "no grabado", "neto no gravado", "neto no grabado"] },
  { key: "importe_exento", keywords: ["importe exento", "neto exento"] },
  { key: "importe_otros_conceptos", keywords: ["importe otros conceptos", "otros conceptos"] },
  { key: "iva_27", keywords: ["iva 27", "iva 27%"] },
  { key: "iva_105", keywords: ["iva 105", "iva 10 5", "iva 10,5", "iva 10.5", "iva 10"] },
  { key: "iva_21", keywords: ["iva 21", "iva21", "iva 21%"] },
  { key: "iva", keywords: ["iva"] },
];

function collectAmounts(lines){
  const results = {};

  function extractAmount(str){
    if (!str) return "";
    const decimal = str.match(/(\d[\d\s\.]*[.,]\d{2})/);
    if (decimal) return decimal[1];
    const bigInt = str.match(/(\d{5,})/);
    return bigInt ? bigInt[1] : "";
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const key = cleanKey(raw);
    if (!key) continue;
    for (const item of AMOUNT_MAP) {
      if (results[item.key]) continue;
      if (item.key.startsWith("iva") && key.includes("iva 21") && item.key === "iva") {
        continue;
      }
      if (item.key.startsWith("iva") && item.key !== "iva" && key === "iva") continue;
      if (item.key === "iva" && (key.includes("iva 21") || key.includes("iva 105") || key.includes("iva 27"))) continue;

      if (item.key !== "iva" && key === "iva") continue;

      if (item.key === "iva" && key === "iva") {
        const amount = extractAmount(raw) || extractAmount(lines[i + 1] || "");
        if (amount) results[item.key] = normNumber(amount);
        continue;
      }

      if (item.keywords.some(k => key.includes(k))) {
        const amount = extractAmount(raw) || extractAmount(lines[i + 1] || "");
        if (amount) results[item.key] = normNumber(amount);
      }
    }
  }
  return results;
}

function matchAmountInText(text, patterns){
  for (const pattern of patterns) {
    const re = new RegExp(`${pattern}[\\s:\\$]{0,10}([\\d\\.\\s,]+)`, "i");
    const match = re.exec(text);
    if (match) {
      const raw = match[1] || "";
      if (/\d/.test(raw)) {
        return normNumber(raw);
      }
    }
  }
  return "";
}

function analizar(text){
  const t = text.normalize("NFKC");
  const lines = t.split(/\r?\n/);

  const fecha = pick(
    matchGroup(t, /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/),
    matchGroup(t, /Fecha\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)
  );

  const numero = pick(
    matchGroup(t, /\b(\d{4}-\d{8})\b/),
    matchGroup(t, /N(?:r[oº°]|[º°]|u(?:m(?:\.|ero)?)?|o)\s*[:\-]?\s*(\d{4}-\d{8})/i)
  );

  const tipo = pick(
    matchGroup(t, /\bFACTURA\s+([ABCEM])\b/i),
    matchGroup(t, /Tipo\s*de\s*Comprobante\s*[:\-]?\s*([ABCEM])/i)
  );

  const cliente = parseCliente(t);
  const razon_social = cliente.razon_social.replace(/CUIT.*$/i,"").trim();

  const amounts = collectAmounts(lines);

  const importe_neto_gravado = pick(
    amounts.importe_neto_gravado,
    matchAmountInText(t, ["Importe\\s+Neto\\s+Gravado", "Neto\\s+Gravado", "Subtotal"]),
    findAmount(lines, ["importe neto gravado", "importe neto grabado", "neto gravado", "neto grabado", "subtotal"])
  );
  const importe_neto_no_gravado = pick(
    amounts.importe_neto_no_gravado,
    matchAmountInText(t, ["Importe\\s+Neto\\s+No\\s+Gravado", "Neto\\s+No\\s+Gravado"]),
    findAmount(lines, ["importe neto no gravado", "importe neto no grabado", "no gravado", "no grabado", "neto no gravado", "neto no grabado"])
  );
  const importe_exento = pick(
    amounts.importe_exento,
    matchAmountInText(t, ["Importe\\s+Exento", "Neto\\s+Exento"]),
    findAmount(lines, ["importe exento", "neto exento"])
  );
  const importe_otros_conceptos = pick(
    amounts.importe_otros_conceptos,
    matchAmountInText(t, ["Importe\\s+Otros\\s+Conceptos", "Otros\\s+Conceptos"]),
    findAmount(lines, ["importe otros conceptos", "otros conceptos"])
  );

  const iva_21 = pick(
    amounts.iva_21,
    matchAmountInText(t, ["I\\.?V\\.?A\\.?\\s*21%?", "IVA\\s*21"]),
    findAmount(lines, ["iva 21", "iva21", "iva 21%"])
  );
  const iva_105 = pick(
    amounts.iva_105,
    matchAmountInText(t, ["I\\.?V\\.?A\\.?\\s*10[,\\.]?5%?", "IVA\\s*10"]),
    findAmount(lines, ["iva 105", "iva 10,5", "iva 10.5", "iva 10"])
  );
  const iva_27 = pick(
    amounts.iva_27,
    matchAmountInText(t, ["I\\.?V\\.?A\\.?\\s*27%?", "IVA\\s*27"]),
    findAmount(lines, ["iva 27", "iva 27%"])
  );
  const iva_general = pick(
    amounts.iva,
    matchAmountInText(t, ["IVA\\s*Total", "I\\.?V\\.?A\\.?\\s*Total", "IVA\\s*:\\s*"]),
    findAmount(lines, ["iva total"])
  );

  const iva = normNumber(pick(iva_general, iva_21, iva_105, iva_27));

  const total = normNumber(pick(
    matchGroup(t, /(Importe\s*Total|TOTAL)\s*[:\s\$]*([\d\.,]+)/i, 2),
    matchGroup(t, /Total\s*\$?\s*([\d\.,]+)/i, 1),
    matchGroup(t, /Importe\s*Total[\s\n\r]+([\d\.,]+)/i, 1)
  ));

  return {
    fecha,
    tipo,
    numero_comprobante: numero,
    cuit: cliente.cuit,
    razon_social: razon_social,
    domicilio_cliente: cliente.domicilio,
    subtotal: importe_neto_gravado,
    importe_neto_gravado,
    importe_neto_no_gravado,
    importe_exento,
    importe_otros_conceptos,
    iva,
    iva_21,
    iva_105,
    iva_27,
    total,
    raw: t.slice(0, 400)
  };
}

app.post("/analizar",(req,res)=>{
  try{
    const { text } = req.body;
    if(!text) return res.status(400).json({error:"Falta texto OCR."});
    const resultado = analizar(text);
    console.log("ANALISIS:", JSON.stringify(resultado, null, 2));
    return res.json(resultado);
  }catch(e){ console.error(e); return res.status(500).json({error:String(e)}); }
});

app.listen(PORT, ()=>console.log("AI regex en 4000"));
