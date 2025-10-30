from flask import Flask, request, jsonify
from PIL import Image
from typing import List, Tuple
import pytesseract
import io, cv2, numpy as np
import re

try:
    from pdf2image import convert_from_bytes
    HAS_PDF = True
except Exception:
    HAS_PDF = False

app = Flask(__name__)

def _resize_if_needed(gray: np.ndarray, target_max: int = 2200) -> np.ndarray:
    """Upscale smaller scans so tesseract sees text with enough resolution."""
    h, w = gray.shape
    if max(h, w) >= target_max:
        return gray
    scale = target_max / max(h, w)
    new_size = (int(w * scale), int(h * scale))
    return cv2.resize(gray, new_size, interpolation=cv2.INTER_CUBIC)

def preprocess_variants(img: Image.Image) -> List[Tuple[str, Image.Image]]:
    cv = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(cv, cv2.COLOR_BGR2GRAY)
    gray = _resize_if_needed(gray)

    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    gray_clahe = clahe.apply(gray)
    blur = cv2.GaussianBlur(gray_clahe, (5, 5), 0)
    _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    adaptive = cv2.adaptiveThreshold(
        gray_clahe,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        35,
        11,
    )
    variants: List[Tuple[str, np.ndarray]] = [
        ("clahe", gray_clahe),
        ("clahe_inv", cv2.bitwise_not(gray_clahe)),
        ("otsu", otsu),
        ("otsu_inv", cv2.bitwise_not(otsu)),
        ("adaptive", adaptive),
        ("adaptive_inv", cv2.bitwise_not(adaptive)),
    ]
    return [(name, Image.fromarray(arr)) for name, arr in variants]

def _score_text(txt: str) -> int:
    if not txt:
        return 0
    return len(re.findall(r"[A-Za-z0-9]", txt))

def run_ocr_with_variants(variants: List[Tuple[str, Image.Image]], original: Image.Image) -> str:
    configs = [
        "--oem 3 --psm 6 -c preserve_interword_spaces=1",
        "--oem 3 --psm 4 -c preserve_interword_spaces=1",
        "--oem 3 --psm 3 -c preserve_interword_spaces=1",
        "--oem 3 --psm 11 -c preserve_interword_spaces=1",
    ]
    collected: dict[str, Tuple[int, str]] = {}
    best_key = ""
    best_score = 0
    for name, variant in variants:
        for cfg in configs:
            txt = pytesseract.image_to_string(variant, lang='spa+eng', config=cfg).strip()
            if not txt:
                continue
            score = _score_text(txt)
            key = " ".join(txt.split())
            if key not in collected or score > collected[key][0]:
                collected[key] = (score, txt)
            if score > best_score:
                best_score = score
                best_key = key

    if not collected:
        fallback = pytesseract.image_to_string(
            original, lang='spa+eng', config="--oem 3 --psm 6 -c preserve_interword_spaces=1"
        ).strip()
        return fallback

    # Combine top candidates to preserve lines que aparecen en distintas variantes
    ordered = sorted(collected.values(), key=lambda item: item[0], reverse=True)
    top_texts = [item[1] for item in ordered[:3]]
    merged = "\n".join(dict.fromkeys(sum((t.splitlines() for t in top_texts), [])))
    return merged or collected[best_key][1]

@app.route('/ocr', methods=['POST'])
def ocr():
    f = request.files.get('file') or request.files.get('archivo')
    if not f:
        return jsonify({'error': 'No se envió archivo'}), 400
    name = (f.filename or '').lower()
    try:
        if name.endswith('.pdf'):
            if not HAS_PDF:
                return jsonify({'error': 'PDF no soportado'}), 400
            data = f.read()
            pages = convert_from_bytes(data, first_page=1, last_page=1, fmt="png")
            if not pages:
                return jsonify({'error': 'PDF vacío'}), 400
            img = pages[0].convert("RGB")
        else:
            img = Image.open(io.BytesIO(f.read())).convert("RGB")
        variants = preprocess_variants(img)
        text = run_ocr_with_variants(variants, img)
        return jsonify({'text': text})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
