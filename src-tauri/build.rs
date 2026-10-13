fn main() {
  // Target triple нужен для поиска sidecar-бинарника `pdf_processor-<triple>[.exe]` в dev-режиме.
  if let Ok(target) = std::env::var("TARGET") {
    println!("cargo:rustc-env=AIBR_TARGET_TRIPLE={}", target);
  }
  tauri_build::build()
}
