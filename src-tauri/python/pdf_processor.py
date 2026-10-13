"""
pdf_processor — постраничный PDF-sidecar для AIBookReader.

CLI (stdout — только JSON UTF-8, ошибки/логи — в stderr, код возврата != 0 при ошибке):

  pdf_processor info  <pdf> [--file-name NAME]
  pdf_processor pages <pdf> --from N --to M [--ocr | --auto | --text] [--lang rus+eng]
                      [--body-size X] [--dpi 200]
  pdf_processor <pdf> [out.json] [--ocr]          (legacy: книга целиком, chapters/paragraphs)

Контракт JSON описан в src/engine/parsers/pdfSidecar.ts.
Зависимость: только PyMuPDF (pymupdf4llm не нужен).
"""
import sys
import os
import io
import re
import json
import base64
import shutil
import subprocess
import statistics
from collections import Counter

if sys.platform == "win32":
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import pymupdf as fitz  # PyMuPDF

try:
    fitz.TOOLS.mupdf_display_errors(False)
    fitz.TOOLS.mupdf_display_warnings(False)
except Exception:
    pass


def log(msg: str) -> None:
    try:
        sys.stderr.write(msg + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def emit_json(obj) -> None:
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


# ----------------------------------------------------------------------------
# Детекторы повреждённого текстового слоя (скопировано из pdf_to_book.py)
# ----------------------------------------------------------------------------

def check_corrupted_pseudocyrillic(sample_text: str) -> bool:
    """Псевдокириллица старого OCR: русские буквы сохранены ASCII-символами (Mbl, 3HaeM, KaK, qTo)."""
    if not sample_text or len(sample_text) < 50:
        return False

    cyrillic = len(re.findall(r"[а-яА-ЯёЁ]", sample_text))
    latin = len(re.findall(r"[a-zA-Z]", sample_text))
    total_letters = cyrillic + latin
    if total_letters < 30:
        return False

    cyrillic_ratio = cyrillic / total_letters
    if cyrillic_ratio > 0.7:
        return False

    pseudo_patterns = [
        r"\bMbl\b",
        r"\b3Hae[a-zA-Z]*",
        r"\b[Kk]a[Kk]\b",
        r"\b[qQ][tT]o\b",
        r"\brrer[Kk][Oo]\b",
        r"\b[cC][eE]\s+Mbl\b",
        r"\)[Jj]\(",
        r"\bCTOJIK",
        r"\b[Bb]eqep",
        r"\b[Tt]pe[Bb][Oo]",
        r"[a-zA-Z]{2,};[a-zA-Z]{2,}",
        r"\blilC",
        r"\b3K3a",
        r"\b[Hh]a\s+ymu",
    ]
    matches = sum(1 for p in pseudo_patterns if re.search(p, sample_text))
    return matches >= 2 and cyrillic_ratio < 0.45


_SHIFT_TOKEN = re.compile(r"^[!-/]?[0-9:;<=>?@A-OQ]{3,}[.,;:!?)]*$")
_SHIFT_STRONG = re.compile(r"[A-OQ<=>?@\"#$&*+/]")
_RU_VOWELS = set("аеёиоуыэюя")


def count_shifted_tokens(text: str) -> int:
    """Слова «сдвинутой кириллицы» ('"@52>30' вместо 'Тревога'): шрифт потерял старший байт."""
    count = 0
    for tok in text.split():
        if not _SHIFT_TOKEN.match(tok) or not _SHIFT_STRONG.search(tok) or tok.isdigit():
            continue
        core = tok.rstrip(".,;:!?)")
        if len(core) < 3:
            continue
        try:
            mapped = "".join(chr(ord(c) + 0x400) for c in core).lower()
        except ValueError:
            continue
        if not all("\u0430" <= c <= "\u044f" or c == "\u0451" for c in mapped):
            continue
        vowels = sum(1 for c in mapped if c in _RU_VOWELS)
        ratio = vowels / len(mapped)
        run = best = 0
        for c in mapped:
            run = 0 if c in _RU_VOWELS else run + 1
            best = max(best, run)
        if 0.25 <= ratio <= 0.7 and best <= 4:
            count += 1
    return count


_WEIRD_LAT = re.compile(r"^[A-Za-z0-9;()]+$")


def weird_ascii_ratio(text: str) -> float:
    """Доля «подозрительных» латинских слов (смесь регистров/цифр/';' внутри слова)."""
    toks = [t.strip(".,:!?\"'«»()") for t in text.split()]
    toks = [t for t in toks if len(t) >= 3]
    if len(toks) < 20:
        return 0.0
    weird = 0
    for t in toks:
        if not _WEIRD_LAT.match(t) or not re.search(r"[A-Za-z]", t):
            continue
        trans = len(re.findall(r"[a-z][A-Z]", t))
        if trans >= 2 or re.search(r"[A-Za-z][;][A-Za-z]", t) or re.search(r"[A-Za-z][0-9][A-Za-z]", t):
            weird += 1
    return weird / len(toks)


def is_layer_bad(text: str) -> bool:
    if not text:
        return False
    if check_corrupted_pseudocyrillic(text):
        return True
    if count_shifted_tokens(text) >= 5:
        return True
    if text.count("\ufffd") > 20:
        return True
    if weird_ascii_ratio(text) >= 0.2:
        return True
    return False


# ----------------------------------------------------------------------------
# Tesseract
# ----------------------------------------------------------------------------

def _norm_path(p):
    """Tauri отдаёт пути с verbatim-префиксом Windows; Tesseract (Leptonica) такие пути не открывает."""
    if not p:
        return p
    if p.startswith("\\\\?\\UNC\\"):
        return "\\\\" + p[8:]
    if p.startswith("\\\\?\\"):
        return p[4:]
    return p


def _tess_candidates():
    env_exe = _norm_path(os.environ.get("AIBR_TESSERACT"))
    env_data = _norm_path(os.environ.get("AIBR_TESSDATA"))
    if env_exe:
        yield env_exe, env_data or os.path.join(os.path.dirname(env_exe), "tessdata")

    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    base_dir = os.path.dirname(os.path.abspath(__file__))
    roots = [
        os.path.join(exe_dir, "tesseract"),
        os.path.join(exe_dir, "resources", "tesseract"),
        os.path.join(exe_dir, "_up_", "tesseract"),
        os.path.join(exe_dir, "..", "tesseract"),  # dev: src-tauri/binaries -> src-tauri/tesseract
        os.path.join(base_dir, "..", "tesseract"),
        os.path.join(base_dir, "tesseract"),
    ]
    for r in roots:
        yield os.path.join(r, "tesseract.exe"), os.path.join(r, "tessdata")
    yield r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files\Tesseract-OCR\tessdata"
    yield r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tessdata"


def find_tesseract():
    for exe, data in _tess_candidates():
        exe, data = _norm_path(exe), _norm_path(data)
        if exe and os.path.isfile(exe):
            return exe, (data if data and os.path.isdir(data) else None)
    w = shutil.which("tesseract")
    if w:
        return w, None
    return None, None


_LANG_RE = re.compile(r"^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$")


def run_tesseract_tsv(png: bytes, tess_cmd: str, tessdata: str | None, lang: str, timeout: int = 120):
    tess_cmd, tessdata = _norm_path(tess_cmd), _norm_path(tessdata)
    cmd = [tess_cmd, "stdin", "stdout", "-l", lang, "--psm", "3"]
    env = dict(os.environ)
    if tessdata:
        cmd += ["--tessdata-dir", tessdata]
        env["TESSDATA_PREFIX"] = tessdata
    cmd += ["tsv"]
    kwargs = {"env": env}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000
    proc = subprocess.run(cmd, input=png, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, **kwargs)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", errors="replace")[:500])
    return proc.stdout.decode("utf-8", errors="replace")


# ----------------------------------------------------------------------------
# Утилиты текста
# ----------------------------------------------------------------------------

_CTRL = re.compile("[\\ufffd\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\u200b-\\u200d\\ufeff]")
_WS = re.compile(r"[ \t\u00a0\u2009\u202f]+")
_HYPHENS = ("-", "\u00ad", "\u2010", "\u2011")
_BULLET = re.compile(r"^\s*(?:[•·▪●■◦○►▶‣⁃]|[-–—]\s)\s*\S|^\s*(?:\d{1,3}|[a-zа-я])[.)]\s+\S", re.I)
_CAPTION = re.compile(r"^\s*(?:рис(?:унок|\.)|табл(?:ица|\.)|схема|фото|fig(?:ure|\.)|table|photo)\s*\d+", re.I)
_CHAPTER = re.compile(r"^\s*(?:глава|часть|раздел|пролог|эпилог|chapter|part|prologue|epilogue|book)\b(?:\s+[\dIVXLCDMivxlcdm]+\b)?.{0,90}$", re.I)
_PAGENUM = re.compile(
    r"^[\s\-–—•·\[\(]*(?:(?:стр(?:аница)?|с|page|p|pp)\.?\s*)?\d{1,4}(?:\s*(?:/|из|of)\s*\d{1,4})?[\s\-–—•·\]\)]*$",
    re.I,
)
_ROMAN = re.compile(r"^[\s\-–—]*[ivxlcIVXLC]{1,7}[\s\-–—]*$")
_TERMINAL = tuple(".!?…»\"”:;)")


def clean_text(s: str) -> str:
    s = _CTRL.sub("", s)
    s = _WS.sub(" ", s)
    return s.strip()


def join_lines(lines: list[str]) -> str:
    """Склеивает строки абзаца; дефисные переносы убираются."""
    out = ""
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        if not out:
            out = ln
            continue
        if out.endswith(_HYPHENS) and len(out) >= 2 and out[-2].isalpha():
            nxt = ln[0]
            if nxt.isalpha() and nxt.islower():
                out = out[:-1] + ln  # сло-\nво -> слово
            elif out.endswith("\u00ad"):
                out = out[:-1] + ln
            else:
                out = out + ln  # Нью-\nЙорк -> Нью-Йорк
        else:
            out = out + " " + ln
    return out


def weighted_median(counter: Counter) -> float | None:
    total = sum(counter.values())
    if not total:
        return None
    acc = 0
    for size in sorted(counter):
        acc += counter[size]
        if acc >= total / 2:
            return float(size)
    return None


# ----------------------------------------------------------------------------
# Извлечение блоков из текстового слоя
# ----------------------------------------------------------------------------

def sample_indexes(n: int, k: int) -> list[int]:
    if n <= k:
        return list(range(n))
    step = n / k
    return sorted({min(n - 1, int(i * step + step / 2)) for i in range(k)})


def body_font_size(doc: "fitz.Document", sample: int = 10) -> float | None:
    counter: Counter = Counter()
    for i in sample_indexes(len(doc), sample):
        try:
            page = doc[i]
            H = page.rect.height
            d = page.get_text("dict")
            for b in d.get("blocks", []):
                if b.get("type") != 0:
                    continue
                y0, y1 = b["bbox"][1], b["bbox"][3]
                if y1 <= 0.08 * H or y0 >= 0.92 * H:
                    continue
                for ln in b.get("lines", []):
                    for sp in ln.get("spans", []):
                        t = sp.get("text", "").strip()
                        if t:
                            counter[round(sp.get("size", 0), 1)] += len(t)
        except Exception:
            continue
    return weighted_median(counter)


def _line_info(ln: dict):
    spans = [s for s in ln.get("spans", []) if s.get("text", "")]
    text = "".join(s["text"] for s in spans)
    if not text.strip():
        return None
    d = ln.get("dir", (1, 0))
    if abs(d[1]) > 0.5:  # вертикальный/повёрнутый текст
        return None
    sizes: Counter = Counter()
    bold_chars = 0
    total = 0
    for s in spans:
        n = len(s["text"].strip()) or 0
        if not n:
            continue
        sizes[round(s.get("size", 0), 1)] += n
        total += n
        fn = (s.get("font") or "").lower()
        if (s.get("flags", 0) & 16) or "bold" in fn or "black" in fn or "heavy" in fn:
            bold_chars += n
    if not total:
        return None
    size = max(sizes.items(), key=lambda kv: kv[1])[0]
    return {
        "text": text,
        "bbox": tuple(ln["bbox"]),
        "size": size,
        "bold": bold_chars / total,
        "chars": total,
    }


def order_blocks(blocks: list[dict], W: float) -> list[dict]:
    """Порядок чтения: сверху вниз; 2 колонки — сначала левая, потом правая (между широкими блоками)."""
    blocks = sorted(blocks, key=lambda b: (b["bbox"][1], b["bbox"][0]))
    if len(blocks) < 4 or W <= 0:
        return blocks
    wide = lambda b: (b["bbox"][2] - b["bbox"][0]) > 0.6 * W
    result: list[dict] = []
    segment: list[dict] = []

    def flush():
        nonlocal segment
        if not segment:
            return
        left = [b for b in segment if (b["bbox"][0] + b["bbox"][2]) / 2 < W / 2]
        right = [b for b in segment if (b["bbox"][0] + b["bbox"][2]) / 2 >= W / 2]
        if len(left) >= 2 and len(right) >= 2:
            result.extend(left + right)  # уже отсортированы по y
        else:
            result.extend(segment)
        segment = []

    for b in blocks:
        if wide(b):
            flush()
            result.append(b)
        else:
            segment.append(b)
    flush()
    return result


def lines_to_paragraphs(blocks_lines: list[list[dict]], body: float) -> list[dict]:
    """blocks_lines — список блоков PyMuPDF, каждый — список строк (_line_info). Возвращает абзацы."""
    paras: list[dict] = []
    cur: dict | None = None
    prev = None

    def close():
        nonlocal cur
        if cur is not None:
            paras.append(cur)
            cur = None

    for bi, lines in enumerate(blocks_lines):
        for li, ln in enumerate(lines):
            new_para = False
            txt = ln["text"].strip()
            if cur is None:
                new_para = True
            else:
                p = prev
                size_change = abs(ln["size"] - p["size"]) > max(0.8, 0.12 * p["size"])
                bold_change = abs(ln["bold"] - p["bold"]) > 0.5
                prev_text = p["text"].strip()
                prev_term = prev_text.endswith(_TERMINAL)
                lh = max(1.0, p["bbox"][3] - p["bbox"][1])
                gap = ln["bbox"][1] - p["bbox"][3]
                if size_change or bold_change:
                    new_para = True
                elif _BULLET.match(txt) and (li > 0 or prev_term or bi > 0):
                    new_para = True
                elif gap > 0.8 * lh:
                    new_para = True
                elif li == 0:
                    # граница блока PyMuPDF: продолжаем, только если предыдущая строка «оборвана»
                    # и новая начинается со строчной буквы на том же размере шрифта
                    starts_lower = txt[:1].isalpha() and txt[:1].islower()
                    new_para = not (not prev_term and starts_lower)
                    if new_para is False and ln["bbox"][1] < p["bbox"][1] - 1:
                        new_para = True  # другая колонка
                else:
                    indent = ln["bbox"][0] - p["bbox"][0]
                    if prev_term and indent > 0.8 * ln["size"] and p["bbox"][2] > p["bbox"][0]:
                        new_para = True
            if new_para:
                close()
                cur = {"lines": [], "sizes": Counter(), "bold": 0.0, "chars": 0,
                       "x0": ln["bbox"][0], "y0": ln["bbox"][1], "x1": ln["bbox"][2], "y1": ln["bbox"][3]}
            cur["lines"].append(txt)
            cur["sizes"][ln["size"]] += ln["chars"]
            cur["bold"] += ln["bold"] * ln["chars"]
            cur["chars"] += ln["chars"]
            cur["x0"] = min(cur["x0"], ln["bbox"][0])
            cur["y0"] = min(cur["y0"], ln["bbox"][1])
            cur["x1"] = max(cur["x1"], ln["bbox"][2])
            cur["y1"] = max(cur["y1"], ln["bbox"][3])
            prev = ln
    close()
    return paras


def classify_paragraph(text: str, size: float | None, bold: float, y0: float, y1: float, H: float,
                       body: float | None, nlines: int, x0: float = 0.0, x1: float = 0.0, W: float = 0.0):
    """Возвращает (type, level|None)."""
    t = text.strip()
    in_header = y1 <= 0.08 * H
    in_footer = y0 >= 0.92 * H
    in_margin_zone = y1 <= 0.12 * H or y0 >= 0.88 * H
    ratio = (size / body) if (size and body) else 1.0

    if (in_header or in_footer or in_margin_zone) and (_PAGENUM.match(t) or (in_margin_zone and _ROMAN.match(t) and len(t) <= 7)):
        return "pagenum", None
    if _PAGENUM.match(t) and len(t) <= 14 and (in_header or in_footer):
        return "pagenum", None
    if in_header and ratio < 1.4:
        return "header", None
    if in_footer and ratio < 1.4:
        return "footer", None
    if _CAPTION.match(t) and len(t) <= 250:
        return "caption", None
    if _BULLET.match(t) and ratio < 1.25:
        return "list", None

    n = len(t)
    if body:
        if ratio >= 1.15 and size - body >= 1.0 and n <= 220 and nlines <= 4:
            lvl = 1 if ratio >= 1.7 else (2 if ratio >= 1.35 else 3)
            return "heading", lvl
        if bold >= 0.9 and n <= 90 and nlines <= 2 and not t.endswith((".", ",", ";")) and ratio >= 0.95:
            return "heading", 3
        if _CHAPTER.match(t) and n <= 100 and nlines <= 2 and ratio >= 0.95 and (
            re.search(r"\d|[IVX]{1,6}\b", t) or t.isupper() or bold >= 0.5
        ):
            return "heading", 2
        letters = [c for c in t if c.isalpha()]
        if 3 <= len(letters) and n <= 60 and nlines <= 2 and t.isupper() and ratio >= 1.0 and not t.endswith((".", ",")):
            return "heading", 3
    return "paragraph", None


def r1(v: float) -> float:
    return round(float(v), 1)


def extract_text_blocks(page: "fitz.Page", body: float | None):
    """Блоки страницы из текстового слоя. Возвращает (blocks, flat_text_all)."""
    W, H = page.rect.width, page.rect.height
    d = page.get_text("dict")
    raw_blocks = []
    for b in d.get("blocks", []):
        if b.get("type") != 0:
            continue
        infos = [i for i in (_line_info(l) for l in b.get("lines", [])) if i]
        if infos:
            raw_blocks.append({"bbox": b["bbox"], "lines": infos})
    if not raw_blocks:
        return [], ""

    if not body:
        c: Counter = Counter()
        for rb in raw_blocks:
            for l in rb["lines"]:
                c[l["size"]] += l["chars"]
        body = weighted_median(c)

    ordered = order_blocks(raw_blocks, W)
    paras = lines_to_paragraphs([rb["lines"] for rb in ordered], body or 0)

    blocks = []
    for p in paras:
        text = clean_text(join_lines(p["lines"]))
        if not text:
            continue
        size = max(p["sizes"].items(), key=lambda kv: kv[1])[0]
        bold = p["bold"] / p["chars"] if p["chars"] else 0.0
        typ, lvl = classify_paragraph(text, size, bold, p["y0"], p["y1"], H, body, len(p["lines"]))
        blk = {"type": typ, "text": text, "fontSize": r1(size),
               "bbox": [r1(p["x0"]), r1(p["y0"]), r1(p["x1"]), r1(p["y1"])]}
        if lvl:
            blk["level"] = lvl
        if bold >= 0.9:
            blk["bold"] = True
        blocks.append(blk)
    return blocks, "\n".join(l["text"] for rb in raw_blocks for l in rb["lines"])


# ----------------------------------------------------------------------------
# OCR страницы
# ----------------------------------------------------------------------------

def ocr_page_blocks(page: "fitz.Page", tess_cmd: str, tessdata: str | None, lang: str, dpi: int):
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
    png = pix.tobytes("png")
    tsv = run_tesseract_tsv(png, tess_cmd, tessdata, lang)
    k = 72.0 / dpi
    H = page.rect.height
    W = page.rect.width

    words = {}  # (block, par, line) -> list of (left, top, w, h, text)
    for row in tsv.splitlines()[1:]:
        cols = row.split("\t", 11)
        if len(cols) < 12:
            continue
        try:
            level = int(cols[0]); blk = int(cols[2]); par = int(cols[3]); ln = int(cols[4])
            left, top, w, h = int(cols[6]), int(cols[7]), int(cols[8]), int(cols[9])
            conf = float(cols[10])
        except ValueError:
            continue
        txt = cols[11].strip()
        if level != 5 or not txt or conf < 0:
            continue
        words.setdefault((blk, par, ln), []).append((left, top, w, h, txt))

    # строки -> абзацы (по номерам block/par Tesseract)
    pars: dict = {}
    for (blk, par, ln), ws in sorted(words.items()):
        ws.sort(key=lambda w: w[0])
        x0 = min(w[0] for w in ws); y0 = min(w[1] for w in ws)
        x1 = max(w[0] + w[2] for w in ws); y1 = max(w[1] + w[3] for w in ws)
        # высота строки по «средним» словам (без выносных): медиана высот слов
        hmed = statistics.median(w[3] for w in ws)
        text = " ".join(w[4] for w in ws)
        pars.setdefault((blk, par), []).append({"text": text, "bbox": (x0, y0, x1, y1), "h": hmed, "chars": len(text)})

    all_h = Counter()
    for lines in pars.values():
        for l in lines:
            all_h[round(l["h"] / 2) * 2] += l["chars"]
    body_h = weighted_median(all_h)

    blocks = []
    for key in sorted(pars):
        lines = pars[key]
        text = clean_text(join_lines([l["text"] for l in lines]))
        if not text:
            continue
        x0 = min(l["bbox"][0] for l in lines) * k; y0 = min(l["bbox"][1] for l in lines) * k
        x1 = max(l["bbox"][2] for l in lines) * k; y1 = max(l["bbox"][3] for l in lines) * k
        h = statistics.median(l["h"] for l in lines)
        # псевдо-размер шрифта: чтобы использовать общую классификацию (ratio = h / body_h)
        fake_body = 10.0
        fake_size = fake_body * (h / body_h) if body_h else fake_body
        typ, lvl = classify_paragraph(text, fake_size, 0.0, y0, y1, H, fake_body, len(lines))
        blk = {"type": typ, "text": text, "bbox": [r1(x0), r1(y0), r1(x1), r1(y1)],
               "fontSize": r1(h * k)}
        if lvl:
            blk["level"] = lvl
        blocks.append(blk)
    return blocks


# ----------------------------------------------------------------------------
# Страницы
# ----------------------------------------------------------------------------

BODY_TYPES = {"heading", "paragraph", "list", "caption"}


def finalize_page(blocks: list[dict]) -> str:
    """Флаги склейки на границах страницы + плоский текст (без header/footer/pagenum)."""
    body = [b for b in blocks if b["type"] in BODY_TYPES]
    if body:
        first, last = body[0], body[-1]
        t = first["text"]
        if first["type"] == "paragraph" and t[:1].isalpha() and t[:1].islower():
            first["continuesParagraph"] = True
        lt = last["text"]
        if last["type"] == "paragraph" and len(lt) >= 2 and lt[-1] in _HYPHENS and lt[-2].isalpha():
            last["text"] = lt[:-1]
            last["endsWithHyphen"] = True
            last["continuesParagraph"] = last.get("continuesParagraph", False)
        elif last["type"] == "paragraph" and not lt.endswith(_TERMINAL):
            last["endsWithOpenSentence"] = True
    return "\n\n".join(b["text"] for b in body)


def parse_pages(doc: "fitz.Document", p_from: int, p_to: int, mode: str, lang: str,
                body: float | None, dpi: int) -> list[dict]:
    n = len(doc)
    if p_from < 1 or p_to < p_from or p_from > n:
        raise ValueError(f"Некорректный диапазон страниц {p_from}-{p_to} (в документе {n})")
    p_to = min(p_to, n)
    if body is None and mode != "ocr":
        body = body_font_size(doc)

    tess = None
    tess_checked = False
    results = []
    for pno in range(p_from, p_to + 1):
        page = doc[pno - 1]
        warnings: list[str] = []
        blocks: list[dict] = []
        source = "text"
        text_blocks: list[dict] = []
        raw_text = ""
        use_ocr = mode == "ocr"
        reason = "forced" if use_ocr else ""

        if mode != "ocr":
            try:
                text_blocks, raw_text = extract_text_blocks(page, body)
            except Exception as e:
                warnings.append(f"text-extract-failed: {e}")
            letters = sum(1 for c in raw_text if c.isalnum())
            if mode == "auto":
                has_img = False
                try:
                    has_img = bool(page.get_images())
                except Exception:
                    pass
                if letters < 15 and has_img:
                    use_ocr, reason = True, "empty-page-with-image"
                elif is_layer_bad(raw_text):
                    use_ocr, reason = True, "corrupted-text-layer"

        if use_ocr:
            if not tess_checked:
                tess = find_tesseract()
                tess_checked = True
            if not tess or not tess[0]:
                if mode == "ocr":
                    raise RuntimeError("Tesseract не найден (AIBR_TESSERACT / tesseract/ рядом с exe)")
                warnings.append("ocr-unavailable")
                use_ocr = False
            else:
                try:
                    blocks = ocr_page_blocks(page, tess[0], tess[1], lang, dpi)
                    source = "ocr"
                    if reason != "forced":
                        warnings.append(f"ocr-fallback:{reason}")
                except Exception as e:
                    # Принудительный OCR не должен валить страницу, если есть нормальный текстовый слой
                    if mode == "ocr" and not text_blocks:
                        try:
                            text_blocks, raw_text = extract_text_blocks(page, body)
                        except Exception:
                            pass
                    if mode == "ocr" and sum(1 for c in raw_text if c.isalnum()) < 15:
                        raise RuntimeError(f"Ошибка OCR на стр. {pno}: {e}")
                    warnings.append(f"ocr-failed: {str(e)[:200]}")
                    use_ocr = False

        if not use_ocr:
            blocks = text_blocks
            if raw_text:
                sh = count_shifted_tokens(raw_text)
                if sh >= 5:
                    warnings.append(f"shifted-cyrillic:{sh}")
                if raw_text.count("\ufffd") > 20:
                    warnings.append("replacement-chars")

        flat = finalize_page(blocks)
        results.append({
            "page": pno, "source": source,
            "width": r1(page.rect.width), "height": r1(page.rect.height),
            "blocks": blocks, "text": flat, "warnings": warnings,
        })
    return results


# ----------------------------------------------------------------------------
# info
# ----------------------------------------------------------------------------

def open_doc(path: str) -> "fitz.Document":
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Файл не найден: {path}")
    doc = fitz.open(path)
    if doc.needs_pass:
        raise ValueError("PDF защищён паролем")
    if len(doc) == 0:
        raise ValueError("PDF-документ не содержит страниц.")
    return doc


def get_outline(doc: "fitz.Document") -> list[dict]:
    out = []
    try:
        n = len(doc)
        for e in doc.get_toc(simple=True)[:2000]:
            title = str(e[1]).strip()
            pg = int(e[2])
            if title and 1 <= pg <= n:
                out.append({"level": int(e[0]), "title": title, "page": pg})
    except Exception as e:
        log(f"Предупреждение: не удалось прочитать оглавление: {e}")
    return out


def cmd_info(path: str, file_name: str | None) -> dict:
    doc = open_doc(path)
    n = len(doc)
    meta = doc.metadata or {}
    fname = file_name or os.path.basename(path)
    base = os.path.splitext(fname)[0]
    title = (meta.get("title") or "").strip() or base
    author = (meta.get("author") or "").strip() or "Не указан"

    cover = None
    try:
        pix = doc[0].get_pixmap(dpi=110)
        cover = "data:image/jpeg;base64," + base64.b64encode(pix.tobytes("jpeg")).decode("ascii")
    except Exception as e:
        log(f"Предупреждение: не удалось извлечь обложку: {e}")

    idxs = sample_indexes(n, 8)
    texts = []
    with_text = 0
    for i in idxs:
        try:
            t = doc[i].get_text("text") or ""
        except Exception:
            t = ""
        texts.append(t)
        if sum(1 for c in t if c.isalnum()) >= 50:
            with_text += 1
    has_layer = with_text > 0 and with_text >= max(1, round(len(idxs) / 3))
    joined = "\n".join(texts)
    corrupted = has_layer and is_layer_bad(joined[:8000])
    body = body_font_size(doc) if has_layer else None
    first = doc[0].rect
    info = {
        "pageCount": n,
        "metadata": {"title": title, "author": author, "fileName": fname},
        "coverUrl": cover,
        "outline": get_outline(doc),
        "pageSize": {"width": r1(first.width), "height": r1(first.height)},
        "hasTextLayer": has_layer,
        "corruptedLayerSuspected": bool(corrupted),
        "bodyFontSize": body,
        "recommendedMode": "ocr" if (not has_layer or corrupted) else "text",
    }
    doc.close()
    return info


# ----------------------------------------------------------------------------
# Legacy: книга целиком
# ----------------------------------------------------------------------------

def convert_pdf_to_book(pdf_path: str, output_json_path: str | None, force_ocr: bool) -> dict:
    info = cmd_info(pdf_path, None)
    doc = open_doc(pdf_path)
    n = len(doc)
    mode = "ocr" if force_ocr else "auto"
    body = info.get("bodyFontSize")
    all_pages: list[dict] = []
    CH = 10
    for s in range(1, n + 1, CH):
        all_pages.extend(parse_pages(doc, s, min(n, s + CH - 1), mode, "rus+eng", body, 200))
    doc.close()

    chapters: list[dict] = []
    state = {"title": "Начало", "paras": [], "pending_hyphen": False, "last_open": False}

    def flush():
        if state["paras"]:
            chapters.append({"title": state["title"], "paragraphs": state["paras"]})
            state["paras"] = []

    warnings: list[str] = []
    for pg in all_pages:
        for w in pg["warnings"]:
            if w not in warnings and not w.startswith("ocr-fallback"):
                warnings.append(w)
        first_body = True
        for b in pg["blocks"]:
            if b["type"] not in BODY_TYPES:
                continue
            txt = b["text"]
            is_head = b["type"] == "heading" and b.get("level", 3) <= 2
            if not is_head and b["type"] == "paragraph" and _CHAPTER.match(txt) and len(txt) <= 60 and \
                    re.match(r"^\s*(глава|часть|раздел|пролог|эпилог)\s+[\dIVXLCDM]+", txt, re.I):
                is_head = True
            if is_head:
                flush()
                state["title"] = txt
                state["last_open"] = False
                state["pending_hyphen"] = False
                first_body = False
                continue
            joinable = first_body and state["paras"] and b["type"] == "paragraph" and (
                state["pending_hyphen"] or b.get("continuesParagraph"))
            if joinable:
                if state["pending_hyphen"]:
                    state["paras"][-1] += txt
                else:
                    state["paras"][-1] += " " + txt
            else:
                state["paras"].append(txt)
            first_body = False
            state["pending_hyphen"] = bool(b.get("endsWithHyphen"))
    flush()
    if not chapters:
        chapters.append({"title": "Основной текст",
                         "paragraphs": ["Текст документа пуст или не удалось распознать абзацы."]})

    md = info["metadata"]
    result = {
        "metadata": {
            "title": md["title"], "author": md["author"], "pageCount": n,
            "coverUrl": info["coverUrl"], "fileName": md["fileName"],
            "isCorruptedDetected": info["corruptedLayerSuspected"], "warnings": warnings,
        },
        "chapters": chapters,
        "toc": [[o["level"], o["title"], o["page"]] for o in info["outline"]],
    }
    if output_json_path:
        with open(output_json_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    return result


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------

def _opt(args: list[str], name: str, default=None):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
        raise ValueError(f"Нет значения для {name}")
    return default


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        log("Использование: pdf_processor info <pdf> | pages <pdf> --from N --to M [--ocr|--auto|--text] | <pdf> [out.json] [--ocr]")
        return 1
    cmd = argv[1]
    try:
        if cmd == "info":
            if len(argv) < 3:
                raise ValueError("info: не указан PDF")
            emit_json(cmd_info(argv[2], _opt(argv, "--file-name")))
            return 0
        if cmd == "pages":
            if len(argv) < 3:
                raise ValueError("pages: не указан PDF")
            args = argv[3:]
            p_from = int(_opt(args, "--from", "1"))
            p_to = int(_opt(args, "--to", str(p_from)))
            mode = "ocr" if "--ocr" in args else ("text" if "--text" in args else "auto")
            lang = _opt(args, "--lang", "rus+eng")
            if not _LANG_RE.match(lang) or len(lang) > 40:
                raise ValueError("Некорректный параметр --lang")
            body_s = _opt(args, "--body-size")
            body = float(body_s) if body_s else None
            dpi = max(100, min(400, int(_opt(args, "--dpi", "200"))))
            doc = open_doc(argv[2])
            pages = parse_pages(doc, p_from, p_to, mode, lang, body, dpi)
            doc.close()
            emit_json({"pages": pages})
            return 0
        # legacy
        pdf = argv[1]
        out = None
        force_ocr = False
        for a in argv[2:]:
            if a == "--ocr":
                force_ocr = True
            elif not out:
                out = a
        res = convert_pdf_to_book(pdf, out, force_ocr)
        if out:
            print("OK")
        else:
            emit_json(res)
        return 0
    except Exception as exc:
        log(f"Ошибка: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
