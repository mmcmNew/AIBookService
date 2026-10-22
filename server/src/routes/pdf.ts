import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Database, IDatabase } from '../db.js';
import { config } from '../config.js';
import { authedUser, asyncHandler } from '../middleware.js';

const execFileAsync = promisify(execFile);

export function createPdfRouter(db: IDatabase | Database): Router {
  const router = Router();

  /**
   * 1. Локальный парсинг PDF через Python (PyMuPDF4LLM).
   * Регистрируется только при ENABLE_PYTHON_PDF=true и заданных PYTHON_PATH / PYTHON_SCRIPT.
   */
  if (config.pythonEnabled()) {
    const TEMP_DIR = path.resolve('temp');
    fs.mkdirSync(TEMP_DIR, { recursive: true });

    router.post('/parse-python', asyncHandler(async (req: Request, res: Response) => {
      const { fileBase64, fileName } = req.body ?? {};
      if (typeof fileBase64 !== 'string' || typeof fileName !== 'string' || !fileBase64 || !fileName) {
        res.status(400).json({ error: 'Поля fileBase64 и fileName обязательны.' });
        return;
      }

      const tempId = `pdf_${crypto.randomUUID()}`;
      const tempPdfPath = path.join(TEMP_DIR, `${tempId}.pdf`);
      const tempJsonPath = path.join(TEMP_DIR, `${tempId}.json`);

      try {
        await fs.promises.writeFile(tempPdfPath, Buffer.from(fileBase64, 'base64'));
        await execFileAsync(config.pythonPath(), [config.pythonScript(), tempPdfPath, tempJsonPath], {
          timeout: 60000,
          maxBuffer: 50 * 1024 * 1024,
        });
        const bookData = JSON.parse(await fs.promises.readFile(tempJsonPath, 'utf-8'));
        res.json({ success: true, source: 'pymupdf4llm', data: bookData });
      } catch (err) {
        console.error('Ошибка Python парсера PDF:', err);
        res.status(500).json({ error: 'Ошибка обработки PDF.' });
      } finally {
        await fs.promises.unlink(tempPdfPath).catch(() => {});
        await fs.promises.unlink(tempJsonPath).catch(() => {});
      }
    }));
  }

  /**
   * 2. AI OCR через Gemini. Списывает фиксированную стоимость, при ошибке возвращает.
   */
  router.post('/parse-gemini', asyncHandler(async (req: Request, res: Response) => {
    const user = authedUser(res);
    const { fileBase64, fileName } = req.body ?? {};
    const apiKey = config.geminiApiKey();

    if (!apiKey) {
      res.status(503).json({ error: 'Сервис распознавания недоступен.' });
      return;
    }
    if (typeof fileBase64 !== 'string' || typeof fileName !== 'string' || !fileBase64 || !fileName) {
      res.status(400).json({ error: 'Поля fileBase64 и fileName обязательны.' });
      return;
    }

    const cost = config.pdfGeminiCost();
    if (cost > 0) {
      let deductResult: { balance: number } | null;
      try {
        deductResult = await db.deductBalance(user.id, cost);
      } catch (err) {
        console.error('Ошибка списания баланса перед OCR:', err);
        res.setHeader('Retry-After', '5');
        res.status(503).json({ error: 'Сервис временно недоступен. Попробуйте позже.' });
        return;
      }
      if (deductResult === null) {
        res.status(402).json({ error: 'Недостаточно символов на балансе.', balance: user.balance, required: cost });
        return;
      }
    }

    try {
      const prompt = `Ты — профессиональный движок оцифровки книг.
Тебе предоставлен PDF-документ (это может быть скан или сложный документ).
Твоя задача:
1. Распознай весь содержательный текст книги (OCR при необходимости).
2. Раздели книгу на логические главы / разделы.
3. Полностью удали служебные колонтитулы, номера страниц, бегущие строки с названиями.
4. Склей все разорванные дефисом переносы строк в цельные слова.
5. Выведи результат СТРОГО в формате JSON без дополнительного markdown форматирования:
{
  "title": "Название книги",
  "author": "Автор",
  "chapters": [
    {
      "title": "Глава 1: ...",
      "paragraphs": [
        "Текст первого абзаца...",
        "Текст второго абзаца..."
      ]
    }
  ]
}`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiOcrModel())}:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'application/pdf', data: fileBase64 } }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(180000),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini API Error (${response.status}): ${err.slice(0, 500)}`);
      }

      const data: any = await response.json();
      const rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawJsonText) {
        throw new Error('Gemini API не вернул распознанный текст.');
      }
      const parsedData = JSON.parse(rawJsonText);

      res.json({
        success: true,
        source: 'gemini-ocr',
        data: {
          metadata: {
            title: parsedData.title || fileName.replace(/\.[^/.]+$/, ''),
            author: parsedData.author || 'Не указан',
            fileName,
          },
          chapters: parsedData.chapters || [],
        },
      });
    } catch (err) {
      console.error('Ошибка Gemini OCR парсинга PDF:', err);
      if (cost > 0) {
        try {
          await db.refundBalance(user.id, cost);
        } catch (refundErr) {
          console.error(`[BILLING] возврат не выполнен user=${user.id} chars=${cost}`, refundErr);
        }
      }
      res.status(500).json({ error: 'Ошибка распознавания PDF.', refunded: cost });
    }
  }));

  return router;
}
