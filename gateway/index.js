import express from "express";
import fetch from "node-fetch";
import multer from "multer";
import FormData from "form-data";
import fs from "fs";
import path from "path";

const app = express();
const upload = multer({ dest: "uploads/" });
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "public")));

app.post("/procesar-lote", upload.array("files", 20), async (req, res) => {
  const files = req.files || [];
  const out = [];
  try {
    for (const f of files) {
      const form = new FormData();
      form.append("file", fs.createReadStream(f.path));
      const ocr = await fetch("http://ocr:5000/ocr", { method: "POST", body: form });
      const ocrJson = await ocr.json();
      const ai = await fetch("http://ai:4000/analizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ocrJson.text || "" })
      });
      const aiJson = await ai.json();
      console.log("Archivo procesado:", f.originalname, aiJson);
      aiJson.__file = f.originalname;
      out.push(aiJson);
    }
    return res.json({ items: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  } finally {
    for (const f of (req.files || [])) { try{ fs.unlinkSync(f.path) }catch{} }
  }
});

app.listen(5001, ()=>console.log("Gateway en 5001"));
