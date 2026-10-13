use std::path::PathBuf;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub server: String,
}

fn get_config_path() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = PathBuf::from(appdata).join("AIBookReader");
        let _ = std::fs::create_dir_all(&dir);
        dir.join("proxy_config.json")
    } else {
        PathBuf::from("proxy_config.json")
    }
}

/// Проверяет строку прокси: `[scheme://]host:port`, scheme in {http, https, socks5, socks4}.
/// Без пробелов, кавычек, управляющих символов, `--`, путей, учётных данных.
/// Возвращает нормализованную строку для `--proxy-server=`.
pub fn validate_proxy_server(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("Адрес прокси пустой".into());
    }
    if s.len() > 255 {
        return Err("Адрес прокси слишком длинный".into());
    }
    if s.chars().any(|c| {
        c.is_whitespace()
            || c.is_control()
            || matches!(c, '"' | '\'' | '`' | '\\' | ';' | '&' | '|' | '<' | '>' | '^' | '%' | '@' | '?' | '#')
    }) {
        return Err("Адрес прокси содержит недопустимые символы".into());
    }
    if s.contains("--") {
        return Err("Адрес прокси содержит недопустимую последовательность".into());
    }

    let (scheme, rest) = match s.split_once("://") {
        Some((sch, rest)) => {
            let sch = sch.to_ascii_lowercase();
            if !matches!(sch.as_str(), "http" | "https" | "socks5" | "socks4") {
                return Err("Допустимые схемы прокси: http, https, socks5, socks4".into());
            }
            (Some(sch), rest)
        }
        None => (None, s),
    };

    // rest = host:port (хост: домен, IPv4 или [IPv6])
    let (host, port) = if let Some(stripped) = rest.strip_prefix('[') {
        let (h, after) = stripped
            .split_once(']')
            .ok_or_else(|| "Некорректный IPv6-адрес прокси".to_string())?;
        let port = after
            .strip_prefix(':')
            .ok_or_else(|| "Не указан порт прокси".to_string())?;
        if h.is_empty() || !h.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.') {
            return Err("Некорректный IPv6-адрес прокси".into());
        }
        (format!("[{}]", h), port)
    } else {
        let (h, port) = rest
            .rsplit_once(':')
            .ok_or_else(|| "Не указан порт прокси (ожидается host:port)".to_string())?;
        if h.is_empty()
            || h.starts_with('.')
            || h.starts_with('-')
            || !h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        {
            return Err("Некорректный хост прокси".into());
        }
        (h.to_string(), port)
    };

    match port.parse::<u16>() {
        Ok(p) if p > 0 && port.chars().all(|c| c.is_ascii_digit()) => {}
        _ => return Err("Некорректный порт прокси".into()),
    }

    Ok(match scheme {
        Some(sch) => format!("{}://{}:{}", sch, host, port),
        None => format!("{}:{}", host, port),
    })
}

pub fn init_proxy() {
    let path = get_config_path();
    if let Ok(data) = std::fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<ProxyConfig>(&data) {
            if config.enabled && !config.server.trim().is_empty() {
                let server = match validate_proxy_server(&config.server) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("Прокси из конфигурации отклонён: {}", e);
                        return;
                    }
                };
                let proxy_arg = format!("--proxy-server={}", server);
                unsafe {
                    if let Ok(current) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
                        std::env::set_var(
                            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                            format!("{} {}", current, proxy_arg),
                        );
                    } else {
                        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", proxy_arg);
                    }
                }
            }
        }
    }
}

#[tauri::command]
fn get_desktop_proxy() -> Option<ProxyConfig> {
    let path = get_config_path();
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

#[tauri::command]
fn set_desktop_proxy(config: Option<ProxyConfig>) -> Result<(), String> {
    let path = get_config_path();
    if let Some(mut cfg) = config {
        // Пустой адрес допустим только при выключенном прокси
        if cfg.server.trim().is_empty() && !cfg.enabled {
            cfg.server = String::new();
        } else {
            cfg.server = validate_proxy_server(&cfg.server)?;
        }
        let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())?;
    } else {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[tauri::command]
fn restart_desktop_app(app: tauri::AppHandle) {
    app.restart();
}

const MAX_PDF_BYTES: usize = 100 * 1024 * 1024;

/// RAII-guard: удаляет временные файлы при любом выходе из функции.
struct TempFiles(Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

fn find_sidecar() -> Option<PathBuf> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let triple = env!("AIBR_TARGET_TRIPLE");
    let names = [
        format!("pdf_processor{}", suffix),
        format!("pdf_processor-{}{}", triple, suffix),
    ];

    // 1. Рядом с исполняемым файлом (production)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for n in &names {
                let p = dir.join(n);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }

    // 2. Папка binaries проекта (dev)
    let dev_dirs = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"),
        PathBuf::from("src-tauri/binaries"),
        PathBuf::from("binaries"),
    ];
    for d in dev_dirs {
        for n in &names {
            let p = d.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn run_pdf_processing(file_bytes: Vec<u8>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    #[cfg(target_os = "windows")]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let temp_dir = std::env::temp_dir();
    let unique_id = format!("aibr_pdf_{}", uuid::Uuid::new_v4().simple());
    let temp_pdf = temp_dir.join(format!("{}.pdf", unique_id));
    let temp_json = temp_dir.join(format!("{}.json", unique_id));
    // Guard создаётся до записи, чтобы файлы удалялись во всех ветках
    let _guard = TempFiles(vec![temp_pdf.clone(), temp_json.clone()]);

    std::fs::write(&temp_pdf, &file_bytes)
        .map_err(|e| format!("Не удалось сохранить временный PDF: {}", e))?;
    drop(file_bytes);

    let mut cmd = sidecar_command()?;
    cmd.arg(&temp_pdf).arg(&temp_json);
    apply_tesseract_env(&mut cmd, None);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Ошибка запуска обработчика PDF: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Ошибка парсинга PDF (код {}): {}", output.status, stderr));
    }

    if !temp_json.exists() {
        return Err("Конвертер не сформировал выходной JSON файл.".to_string());
    }
    std::fs::read_to_string(&temp_json)
        .map_err(|e| format!("Не удалось прочитать выходной JSON: {}", e))
}

/// Базовая команда запуска sidecar (production-exe или dev-fallback через AIBR_PYTHON + AIBR_PDF_SCRIPT).
fn sidecar_command() -> Result<std::process::Command, String> {
    use std::process::Command;
    if let Some(exe) = find_sidecar() {
        return Ok(Command::new(exe));
    }
    let python = std::env::var_os("AIBR_PYTHON").map(PathBuf::from);
    let script = std::env::var_os("AIBR_PDF_SCRIPT").map(PathBuf::from);
    match (python, script) {
        (Some(py), Some(sc)) if py.is_file() && sc.is_file() => {
            let mut c = Command::new(py);
            c.arg(sc);
            Ok(c)
        }
        _ => Err(
            "Встроенный pdf_processor не найден (для dev задайте AIBR_PYTHON и AIBR_PDF_SCRIPT)."
                .to_string(),
        ),
    }
}

/// Ищет встроенный Tesseract: resource_dir/tesseract, рядом с exe, dev (src-tauri/tesseract).
fn find_tesseract_dir(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    use tauri::Manager;
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(app) = app {
        if let Ok(rd) = app.path().resource_dir() {
            dirs.push(rd.join("tesseract"));
            dirs.push(rd.join("resources").join("tesseract"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            dirs.push(d.join("tesseract"));
            dirs.push(d.join("resources").join("tesseract"));
        }
    }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tesseract"));
    let exe_name = format!("tesseract{}", std::env::consts::EXE_SUFFIX);
    dirs.into_iter().find(|d| d.join(&exe_name).is_file())
}

/// Убирает verbatim-префикс Windows, который Tesseract/Leptonica не умеет открывать.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", rest))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// Передаёт sidecar'у пути к Tesseract через AIBR_TESSERACT / AIBR_TESSDATA (если не заданы пользователем).
fn apply_tesseract_env(cmd: &mut std::process::Command, app: Option<&tauri::AppHandle>) {
    if std::env::var_os("AIBR_TESSERACT").is_some() {
        return;
    }
    if let Some(dir) = find_tesseract_dir(app) {
        let dir = strip_verbatim(dir);
        let exe_name = format!("tesseract{}", std::env::consts::EXE_SUFFIX);
        cmd.env("AIBR_TESSERACT", dir.join(exe_name));
        let td = dir.join("tessdata");
        if td.is_dir() {
            cmd.env("AIBR_TESSDATA", td);
        }
    }
}

const MAX_PAGES_PER_CALL: u32 = 20;
const MAX_OPEN_PDFS: usize = 8;
const MAX_SIDECAR_STDOUT: usize = 64 * 1024 * 1024;

struct PdfEntry {
    path: PathBuf,
    file_name: String,
}

#[derive(Default)]
struct PdfState(std::sync::Mutex<std::collections::HashMap<String, PdfEntry>>);

impl PdfState {
    fn cleanup_all(&self) {
        if let Ok(mut m) = self.0.lock() {
            for (_, e) in m.drain() {
                let _ = std::fs::remove_file(&e.path);
            }
        }
    }
}

fn lookup_handle(state: &PdfState, handle: &str) -> Result<(PathBuf, String), String> {
    let m = state.0.lock().map_err(|_| "Внутренняя ошибка состояния PDF".to_string())?;
    m.get(handle)
        .map(|e| (e.path.clone(), e.file_name.clone()))
        .ok_or_else(|| "Неизвестный или закрытый PDF-handle".to_string())
}

/// Запуск sidecar с таймаутом (по истечении процесс убивается). Возвращает stdout (JSON).
fn run_sidecar_json(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Ошибка запуска обработчика PDF: {}", e))?;

    let out = child.stdout.take().ok_or("Нет stdout у процесса")?;
    let err = child.stderr.take().ok_or("Нет stderr у процесса")?;
    let t_out = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.take(MAX_SIDECAR_STDOUT as u64 + 1).read_to_end(&mut buf);
        buf
    });
    let t_err = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err.take(64 * 1024).read_to_end(&mut buf);
        buf
    });

    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = t_out.join();
                    let _ = t_err.join();
                    return Err(format!(
                        "Обработка PDF превысила лимит времени ({} с)",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("Ошибка ожидания обработчика PDF: {}", e));
            }
        }
    };
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();

    if !status.success() {
        return Err(format!(
            "Ошибка обработки PDF (код {}): {}",
            status,
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if stdout.len() > MAX_SIDECAR_STDOUT {
        return Err("Ответ обработчика PDF слишком большой".to_string());
    }
    String::from_utf8(stdout).map_err(|_| "Обработчик PDF вернул не-UTF-8 вывод".to_string())
}

fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).take(200).collect();
    if cleaned.trim().is_empty() {
        "document.pdf".to_string()
    } else {
        cleaned
    }
}

/// Сохраняет PDF во временный файл с непредсказуемым именем и возвращает opaque-handle.
#[tauri::command]
async fn pdf_open(
    state: tauri::State<'_, PdfState>,
    file_bytes: Vec<u8>,
    file_name: Option<String>,
) -> Result<String, String> {
    if file_bytes.is_empty() {
        return Err("Пустой PDF-файл".to_string());
    }
    if file_bytes.len() > MAX_PDF_BYTES {
        return Err(format!(
            "PDF слишком большой (максимум {} МБ)",
            MAX_PDF_BYTES / 1024 / 1024
        ));
    }
    if state.0.lock().map(|m| m.len()).unwrap_or(0) >= MAX_OPEN_PDFS {
        return Err("Слишком много одновременно открытых PDF".to_string());
    }
    let handle = uuid::Uuid::new_v4().simple().to_string();
    let path = std::env::temp_dir().join(format!("aibr_pdf_{}.pdf", handle));
    let p2 = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&p2, &file_bytes).map_err(|e| {
            let _ = std::fs::remove_file(&p2);
            format!("Не удалось сохранить временный PDF: {}", e)
        })
    })
    .await
    .map_err(|e| format!("Ошибка фоновой задачи: {}", e))??;
    let entry = PdfEntry {
        path,
        file_name: sanitize_file_name(file_name.as_deref().unwrap_or("")),
    };
    match state.0.lock() {
        Ok(mut m) => {
            m.insert(handle.clone(), entry);
            Ok(handle)
        }
        Err(_) => {
            let _ = std::fs::remove_file(&entry.path);
            Err("Внутренняя ошибка состояния PDF".to_string())
        }
    }
}

#[tauri::command]
fn pdf_close(state: tauri::State<'_, PdfState>, handle: String) -> Result<(), String> {
    let entry = state
        .0
        .lock()
        .map_err(|_| "Внутренняя ошибка состояния PDF".to_string())?
        .remove(&handle);
    if let Some(e) = entry {
        let _ = std::fs::remove_file(&e.path);
    }
    Ok(())
}

#[tauri::command]
async fn pdf_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfState>,
    handle: String,
) -> Result<String, String> {
    let (path, file_name) = lookup_handle(&state, &handle)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = sidecar_command()?;
        cmd.arg("info").arg(&path).arg("--file-name").arg(&file_name);
        apply_tesseract_env(&mut cmd, Some(&app));
        run_sidecar_json(cmd, std::time::Duration::from_secs(120))
    })
    .await
    .map_err(|e| format!("Ошибка фоновой задачи: {}", e))?
}

/// Постраничное распознавание. Страницы 1-based, включительно; не более 20 за вызов.
/// mode: "auto" (по умолчанию) | "ocr" | "text".
#[tauri::command]
async fn pdf_pages(
    app: tauri::AppHandle,
    state: tauri::State<'_, PdfState>,
    handle: String,
    from: u32,
    to: u32,
    mode: Option<String>,
    lang: Option<String>,
    body_size: Option<f64>,
) -> Result<String, String> {
    if from < 1 || to < from {
        return Err("Некорректный диапазон страниц".to_string());
    }
    if to - from + 1 > MAX_PAGES_PER_CALL {
        return Err(format!("Не более {} страниц за вызов", MAX_PAGES_PER_CALL));
    }
    let mode_flag = match mode.as_deref().unwrap_or("auto") {
        "auto" => "--auto",
        "ocr" => "--ocr",
        "text" => "--text",
        _ => return Err("Некорректный режим (auto | ocr | text)".to_string()),
    };
    let lang = lang.unwrap_or_else(|| "rus+eng".to_string());
    if lang.is_empty()
        || lang.len() > 40
        || !lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '+')
        || lang.starts_with('+')
        || lang.ends_with('+')
    {
        return Err("Некорректный язык OCR".to_string());
    }
    if let Some(b) = body_size {
        if !b.is_finite() || b <= 0.0 || b > 1000.0 {
            return Err("Некорректный размер шрифта".to_string());
        }
    }
    let (path, _) = lookup_handle(&state, &handle)?;
    let n = (to - from + 1) as u64;
    let timeout = std::time::Duration::from_secs(60 + 30 * n);
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = sidecar_command()?;
        cmd.arg("pages")
            .arg(&path)
            .arg("--from")
            .arg(from.to_string())
            .arg("--to")
            .arg(to.to_string())
            .arg(mode_flag)
            .arg("--lang")
            .arg(&lang);
        if let Some(b) = body_size {
            cmd.arg("--body-size").arg(b.to_string());
        }
        apply_tesseract_env(&mut cmd, Some(&app));
        run_sidecar_json(cmd, timeout)
    })
    .await
    .map_err(|e| format!("Ошибка фоновой задачи: {}", e))?
}

/// Удаляет «осиротевшие» временные PDF прошлых сессий (старше суток).
fn cleanup_stale_temp_pdfs() {
    let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let day = std::time::Duration::from_secs(24 * 3600);
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("aibr_pdf_") && (name.ends_with(".pdf") || name.ends_with(".json")) {
            let age = e
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t.elapsed().unwrap_or_default());
            if let Ok(age) = age {
                if age > day {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
}

#[tauri::command]
async fn parse_pdf_local(
    _app: tauri::AppHandle,
    file_bytes: Vec<u8>,
    _file_name: String,
) -> Result<String, String> {
    if file_bytes.is_empty() {
        return Err("Пустой PDF-файл".to_string());
    }
    if file_bytes.len() > MAX_PDF_BYTES {
        return Err(format!(
            "PDF слишком большой (максимум {} МБ)",
            MAX_PDF_BYTES / 1024 / 1024
        ));
    }
    tauri::async_runtime::spawn_blocking(move || run_pdf_processing(file_bytes))
        .await
        .map_err(|e| format!("Ошибка фоновой задачи: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(PdfState::default())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
        get_desktop_proxy,
        set_desktop_proxy,
        restart_desktop_app,
        parse_pdf_local,
        pdf_open,
        pdf_close,
        pdf_info,
        pdf_pages
    ])
    .setup(|app| {
      std::thread::spawn(cleanup_stale_temp_pdfs);
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        use tauri::Manager;
        app.state::<PdfState>().cleanup_all();
      }
    });
}
