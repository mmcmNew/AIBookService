import sys
import os
import json
import re
import base64
import subprocess
import shutil

# Гарантируем UTF-8 вывод на Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import fitz  # PyMuPDF
import pymupdf4llm


def check_corrupted_pseudocyrillic(sample_text: str) -> bool:
    """
    Детектор повреждённого текстового слоя (псевдокириллицы старого OCR).
    Определяет характерные артефакты, когда русские буквы были сохранены
    визуально похожими ASCII-символами (Mbl, 3HaeM, KaK, qTo, rrerKO, )J().
    """
    if not sample_text or len(sample_text) < 50:
        return False

    cyrillic = len(re.findall(r"[а-яА-ЯёЁ]", sample_text))
    latin = len(re.findall(r"[a-zA-Z]", sample_text))
    total_letters = cyrillic + latin

    if total_letters < 30:
        return False

    cyrillic_ratio = cyrillic / total_letters

    # Если в тексте 70%+ нормальной кириллицы, это не псевдокириллица
    if cyrillic_ratio > 0.7:
        return False

    pseudo_patterns = [
        r"\bMbl\b",           # Мы
        r"\b3Hae[a-zA-Z]*",   # знаем, знаете
        r"\b[Kk]a[Kk]\b",     # как
        r"\b[qQ][tT]o\b",     # что
        r"\brrer[Kk][Oo]\b",  # легко
        r"\b[cC][eE]\s+Mbl\b",# все мы
        r"\)[Jj]\(",          # буква ж: )J(
        r"\bCTOJIK",          # столк...
        r"\b[Bb]eqep",        # вечер...
        r"\b[Tt]pe[Bb][Oo]",  # трево...
        r"[a-zA-Z]{2,};[a-zA-Z]{2,}", # точка с запятой внутри псевдослова (rrosp;HlilM)
        r"\blilC",            # исп...
        r"\b3K3a",            # экза...
        r"\b[Hh]a\s+ymu",     # на улице
    ]

    matches = sum(1 for p in pseudo_patterns if re.search(p, sample_text))
    return matches >= 2 and cyrillic_ratio < 0.45


_MD_BOLD = re.compile(r"(?<![\w*\\])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\w*])")
_MD_BOLD_U = re.compile(r"(?<![\w_\\])__(?=\S)(.+?)(?<=\S)__(?![\w_])")
_MD_ITALIC = re.compile(r"(?<![\w*\\])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])")
_MD_ITALIC_U = re.compile(r"(?<![\w_\\])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])")
_MD_CODE = re.compile(r"`([^`\n]+)`")
_MD_LINK = re.compile(r"!?\[([^\]\n]*)\]\([^)\n]*\)")
_FFFD_CTRL = re.compile("[\\ufffd\\x00-\\x08\\x0b\\x0c\\x0e-\\x0f\\u200b-\\u200d\\ufeff\\u00ad]")


def is_standalone_bold(line: str) -> bool:
    """Строка целиком в **...** (короткая) - возможный заголовок главы; маркеры оставляем для JS-детектора глав."""
    t = line.strip()
    return len(t) <= 100 and bool(re.match(r"^\*\*[^*].*[^*]\*\*$", t))


def strip_markdown_artifacts(text: str) -> str:
    """Убирает остатки Markdown от pymupdf4llm: **жирный**, _курсив_, `код`, [ссылки](url)."""
    out = text
    for _ in range(3):
        before = out
        out = _MD_BOLD.sub(r"\1", out)
        out = _MD_BOLD_U.sub(r"\1", out)
        out = _MD_ITALIC.sub(r"\1", out)
        out = _MD_ITALIC_U.sub(r"\1", out)
        if out == before:
            break
    out = _MD_CODE.sub(r"\1", out)
    out = _MD_LINK.sub(r"\1", out)
    return out


_SHIFT_TOKEN = re.compile(r"^[!-/]?[0-9:;<=>?@A-OQ]{3,}[.,;:!?)]*$")
_SHIFT_STRONG = re.compile(r"[A-OQ<=>?@\"#$&*+/]")
_RU_VOWELS = set("аеёиоуыэюя")


def count_shifted_tokens(text: str) -> int:
    """
    Считает слова "сдвинутой кириллицы": шрифт потерял старший байт (U+04xx -> U+00xx),
    например '"@52>30' вместо 'Тревога'. Слово принимается, если после +0x400 получилось
    правдоподобное русское слово (доля гласных, нет длинных цепочек согласных).
    """
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


def find_tesseract() -> tuple[str | None, str | None]:
    """
    Ищет встроенный или системный tesseract.exe и директорию tessdata.
    """
    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        # 1. В папке проекта src-tauri/tesseract
        (os.path.join(base_dir, "..", "tesseract", "tesseract.exe"), os.path.join(base_dir, "..", "tesseract", "tessdata")),
        (os.path.join(base_dir, "tesseract", "tesseract.exe"), os.path.join(base_dir, "tesseract", "tessdata")),
        # 2. Рядом со скомпилированным exe
        (os.path.join(os.path.dirname(sys.executable), "tesseract", "tesseract.exe"), os.path.join(os.path.dirname(sys.executable), "tesseract", "tessdata")),
        # 3. Стандартная установка Windows
        (r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files\Tesseract-OCR\tessdata"),
        (r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tessdata"),
    ]

    for exe, data in candidates:
        if os.path.exists(exe):
            return exe, data if os.path.exists(data) else None

    which_tess = shutil.which("tesseract")
    if which_tess:
        return which_tess, None

    return None, None


def ocr_pdf_document(doc: fitz.Document, tesseract_cmd: str, tessdata_dir: str | None, lang: str = "rus+eng") -> str:
    """
    Выполняет оптическое распознавание страниц через Tesseract OCR.
    """
    sys.stderr.write(f"[Tesseract OCR] Запуск оптического распознавания {len(doc)} страниц...\n")
    pages_text = []

    for page_idx in range(len(doc)):
        try:
            page = doc[page_idx]
            pix = page.get_pixmap(dpi=150)
            png_bytes = pix.tobytes("png")

            cmd = [tesseract_cmd, "stdin", "stdout", "-l", lang]
            if tessdata_dir and os.path.exists(tessdata_dir):
                cmd.extend(["--tessdata-dir", tessdata_dir])

            # Скрытый запуск на Windows
            kwargs = {}
            if sys.platform == "win32":
                kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW

            proc = subprocess.run(
                cmd,
                input=png_bytes,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
                **kwargs
            )

            if proc.returncode == 0:
                p_text = proc.stdout.decode("utf-8", errors="replace").strip()
                if p_text:
                    pages_text.append(p_text)
            else:
                sys.stderr.write(f"[Tesseract OCR] Предупреждение на стр. {page_idx + 1}: {proc.stderr.decode('utf-8', errors='ignore')}\n")
        except Exception as e:
            sys.stderr.write(f"[Tesseract OCR] Ошибка на стр. {page_idx + 1}: {e}\n")

    return "\n\n".join(pages_text)


def convert_pdf_to_book(pdf_path: str, output_json_path: str = None, force_ocr: bool = False) -> dict:
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"Файл не найден: {pdf_path}")

    doc = fitz.open(pdf_path)
    page_count = len(doc)
    if page_count == 0:
        raise ValueError("PDF-документ не содержит страниц.")

    # 1. Метаданные
    meta = doc.metadata or {}
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    title = (meta.get("title") or "").strip() or base_name
    author = (meta.get("author") or "").strip() or "Не указан"

    # 2. Обложка с 1-й страницы
    cover_data_url = None
    try:
        page0 = doc[0]
        pix = page0.get_pixmap(dpi=110)
        img_bytes = pix.tobytes("jpeg")
        b64 = base64.b64encode(img_bytes).decode("ascii")
        cover_data_url = f"data:image/jpeg;base64,{b64}"
    except Exception as e:
        sys.stderr.write(f"Предупреждение: не удалось извлечь обложку: {e}\n")

    # 3. Извлечение структурированного Markdown через pymupdf4llm
    md_text = ""
    if not force_ocr:
        try:
            md_text = pymupdf4llm.to_markdown(doc)
        except Exception as e:
            sys.stderr.write(f"PyMuPDF4LLM ошибка: {e}, запуск fallback...\n")

    # 4. Проверка на битый текстовый слой (псевдокириллицу) или скан без текста
    is_corrupted = check_corrupted_pseudocyrillic(md_text[:4000])
    is_empty = len(md_text.strip()) < 100

    if force_ocr or is_corrupted or is_empty:
        reason = "принудительный OCR" if force_ocr else ("поврежденный слой (псевдокириллица)" if is_corrupted else "скан без текста")
        sys.stderr.write(f"[PDF Processor] ⚠️ Обнаружен {reason}. Запуск Tesseract OCR...\n")

        tess_cmd, tess_data = find_tesseract()
        if tess_cmd:
            ocr_text = ocr_pdf_document(doc, tess_cmd, tess_data, lang="rus+eng")
            if ocr_text.strip():
                md_text = ocr_text
                sys.stderr.write("[PDF Processor] ✅ Страницы успешно распознаны через Tesseract OCR!\n")
        else:
            if is_corrupted:
                sys.stderr.write("[PDF Processor] ⚠️ Tesseract не найден для исправления псевдокириллицы.\n")

    # Оглавление PDF (закладки): [уровень, название, страница] - JS использует его для разбиения на главы
    toc = []
    try:
        for entry in doc.get_toc(simple=True)[:1000]:
            lvl, ttl, pg = entry[0], str(entry[1]).strip(), entry[2]
            if ttl:
                toc.append([int(lvl), ttl, int(pg)])
    except Exception as e:
        sys.stderr.write(f"Предупреждение: не удалось прочитать оглавление PDF: {e}\n")

    doc.close()

    # Предупреждения о качестве текстового слоя
    warnings = []
    shifted = count_shifted_tokens(md_text)
    if shifted >= 5:
        msg = (
            f"Обнаружена сдвинутая кириллица ({shifted} слов вида '\"@52>30'): шрифт PDF потерял старший байт. "
            "Откройте редактор -> Очистка -> 'Исправить сдвинутую кириллицу' или распознайте PDF режимом Gemini OCR."
        )
        warnings.append(msg)
        sys.stderr.write("[PDF Processor] WARNING: " + msg + "\n")
    if md_text.count("\ufffd") > 20:
        warnings.append("В тексте много символов-заменителей (U+FFFD): кодировка шрифта PDF повреждена.")

    # 5. Нарезка Markdown на главы и абзацы
    lines = md_text.splitlines()
    chapters = []
    current_title = "Начало"
    current_paragraphs = []
    current_buffer = []

    def flush_paragraph():
        nonlocal current_buffer
        if current_buffer:
            if len(current_buffer) == 1 and is_standalone_bold(current_buffer[0]):
                para = current_buffer[0].strip()
            else:
                para = strip_markdown_artifacts(" ".join(current_buffer).strip())
            para = _FFFD_CTRL.sub("", para)
            # Убираем дефисные переносы: "сло- во" -> "слово"
            para = re.sub(r"([а-яёa-z])- ([а-яёa-z])", r"\1\2", para, flags=re.IGNORECASE)
            if para:
                current_paragraphs.append(para)
            current_buffer = []

    def flush_chapter():
        nonlocal current_paragraphs, current_title
        flush_paragraph()
        if current_paragraphs:
            chapters.append({
                "title": current_title,
                "paragraphs": current_paragraphs,
            })
            current_paragraphs = []

    for line in lines:
        stripped = line.strip()

        # Заголовок Markdown (#, ##, ###) или паттерн главы
        header_match = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        custom_heading_match = re.match(
            r"^(?:\*\*)?(глава|часть|раздел|пролог|эпилог)\s+[\dIVXLCDM]+.*", stripped, re.IGNORECASE
        )
        if not (header_match or custom_heading_match) and re.match(r"^#{4,6}\s+", stripped):
            # Мелкие заголовки (####, ######) - обычный текст, а не главы: убираем только решётки
            stripped = re.sub(r"^#{4,6}\s+", "", stripped)

        if header_match or custom_heading_match:
            flush_chapter()
            if header_match:
                current_title = strip_markdown_artifacts(header_match.group(2).strip())
            else:
                current_title = strip_markdown_artifacts(stripped)
            continue

        if not stripped:
            flush_paragraph()
            continue

        # Игнорируем Markdown-разделители вроде '---' или '***'
        if re.match(r"^[-*_]{3,}$", stripped):
            flush_paragraph()
            continue

        current_buffer.append(stripped)

    flush_chapter()

    if not chapters:
        chapters.append({
            "title": "Основной текст",
            "paragraphs": ["Текст документа пуст или не удалось распознать абзацы."]
        })

    result = {
        "metadata": {
            "title": title,
            "author": author,
            "pageCount": page_count,
            "coverUrl": cover_data_url,
            "fileName": os.path.basename(pdf_path),
            "isCorruptedDetected": is_corrupted,
            "warnings": warnings,
        },
        "chapters": chapters,
        "toc": toc,
    }

    if output_json_path:
        with open(output_json_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Использование: pdf_processor <путь_к_pdf> [путь_к_выходному_json] [--ocr]")
        sys.exit(1)

    pdf_file = sys.argv[1]
    out_file = None
    force_ocr_flag = False

    for arg in sys.argv[2:]:
        if arg == "--ocr":
            force_ocr_flag = True
        elif not out_file:
            out_file = arg

    try:
        res = convert_pdf_to_book(pdf_file, out_file, force_ocr=force_ocr_flag)
        if not out_file:
            print(json.dumps(res, ensure_ascii=False))
        else:
            print(f"Успешно сохранено в {out_file}")
    except Exception as exc:
        sys.stderr.write(f"Ошибка конвертации: {exc}\n")
        sys.exit(2)
