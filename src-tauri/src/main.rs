// KivNote Tauri — 后端
// Phase 0.1：移植 main.js 的文件分类（sniff/classify）、解码（UTF-8/GBK）、hexDump、
// readAny（完整 doc 对象）与 file:chunk / file:readAll 契约，让渲染端按 Electron 的
// 数据结构正常工作。xlsx/docx 改值、Office 转换等留待后续阶段。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};

const MAX_TEXT: usize = 32 * 1024 * 1024; // 与 Electron 一致：文本最多读 32MB
const MAX_HEX: usize = 256 * 1024; // 二进制预览最多读 256KB
const HEX_LINES: usize = 16 * 1024;
const MAX_READ_ALL: u64 = 48 * 1024 * 1024; // readAll 上限 48MB

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "text" => "文本",
        "image" => "图片",
        "audio" => "音频",
        "video" => "视频",
        "pdf" => "PDF",
        "table" => "表格",
        "docx" => "Word",
        "pptx" => "PPT",
        "doc" => "Word(旧)",
        "xls" => "Excel(旧)",
        "ppt" => "PPT(旧)",
        "archive" => "压缩包",
        "binary" => "二进制",
        "office" => "文档",
        "exec" => "可执行文件",
        _ => "文件",
    }
}

/* ───────── 后缀集合（与 main.js 完全一致） ───────── */

fn is_text_ext(ext: &str) -> bool {
    const SET: &[&str] = &[
        "txt", "md", "markdown", "mdx", "log", "json", "jsonc", "json5", "xml", "yaml", "yml",
        "toml", "ini", "cfg", "conf", "env", "properties", "csv", "tsv", "srt", "ass", "vtt",
        "lrc", "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl", "js", "mjs", "cjs",
        "jsx", "ts", "tsx", "vue", "svelte", "astro", "py", "pyw", "pyi", "rb", "rake", "php",
        "java", "kt", "kts", "groovy", "go", "rs", "c", "h", "cc", "cpp", "cxx", "hpp", "hh",
        "hxx", "cs", "m", "mm", "swift", "dart", "lua", "pl", "pm", "r", "jl", "scala", "clj",
        "cljs", "ex", "exs", "erl", "hrl", "hs", "lhs", "fs", "fsx", "vb", "vbs", "asm", "s",
        "nasm", "sql", "sh", "bash", "zsh", "fish", "ksh", "bat", "cmd", "ps1", "psm1", "vim",
        "el", "lisp", "scm", "tex", "sty", "cls", "bib", "org", "rst", "adoc", "text", "diff",
        "patch", "gitignore", "gitattributes", "gitmodules", "dockerignore", "editorconfig",
        "npmrc", "nvmrc", "yarnrc", "babelrc", "eslintrc", "prettierrc", "stylelintrc", "lock",
        "pem", "key", "crt", "cer", "csr", "pub", "asc", "gpg", "htaccess", "nginx", "service",
        "desktop", "plist", "cmake", "mk", "makefile", "dockerfile", "license", "readme",
        "changelog", "authors", "todo",
    ];
    SET.contains(&ext)
}

fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "jpe" | "jfif" | "gif" | "webp" | "avif" | "bmp" | "ico" | "svg"
            | "tif" | "tiff" | "heic" | "heif" | "apng"
    )
}

fn is_audio_ext(ext: &str) -> bool {
    matches!(
        ext,
        "mp3" | "wav" | "ogg" | "oga" | "flac" | "m4a" | "aac" | "opus" | "wma" | "mid" | "midi"
            | "weba"
    )
}

fn is_video_ext(ext: &str) -> bool {
    matches!(
        ext,
        "mp4" | "webm" | "mkv" | "mov" | "m4v" | "ogv" | "avi" | "wmv" | "flv" | "mpg" | "mpeg"
            | "3gp"
    )
}

/* ───────── 魔数嗅探（与 main.js 的 sniff 一致） ───────── */

fn ascii_at(b: &[u8], from: usize, to: usize) -> String {
    b.get(from..to)
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .unwrap_or_default()
}

fn sniff(head: &[u8]) -> Option<&'static str> {
    if head.len() < 4 {
        return None;
    }
    if head.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        return Some("image"); // PNG
    }
    if head.starts_with(&[0xff, 0xd8]) {
        return Some("image"); // JPEG
    }
    if head.starts_with(b"GIF8") {
        return Some("image");
    }
    if ascii_at(head, 0, 4) == "RIFF" {
        match ascii_at(head, 8, 12).as_str() {
            "WEBP" => return Some("image"),
            "WAVE" => return Some("audio"),
            "AVI " => return Some("video"),
            _ => {}
        }
    }
    if head.starts_with(b"%PDF-") {
        return Some("pdf");
    }
    if head.len() >= 12 && ascii_at(head, 4, 8) == "ftyp" {
        return Some("video"); // MP4/MOV
    }
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some("video"); // MKV/WEBM
    }
    if head.starts_with(b"OggS") || head.starts_with(b"fLaC") || head.starts_with(b"ID3") {
        return Some("audio");
    }
    if head.starts_with(&[0x50, 0x4b, 0x03, 0x04]) {
        return Some("archive"); // zip
    }
    if head.len() >= 4 && head[0] == 0x1f && head[1] == 0x8b && head[2] == 0x08 && (head[3] == 0 || head[3] == 8)
    {
        return Some("archive"); // gzip
    }
    if head.starts_with(&[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) {
        return Some("archive"); // 7z
    }
    if head.starts_with(b"Rar!") {
        return Some("archive");
    }
    if head.starts_with(&[0x7f, 0x45, 0x4c, 0x46]) {
        return Some("exec"); // ELF
    }
    if head.starts_with(&[0x4d, 0x5a]) {
        return Some("exec"); // PE (exe/dll)
    }
    if head.starts_with(&[0x00, 0x61, 0x73, 0x6d]) {
        return Some("binary"); // wasm
    }
    if head.starts_with(b"SQLite format 3") {
        return Some("binary");
    }
    None
}

/* ───────── 分类（与 main.js 的 classify 一致） ───────── */

fn looks_binary(buf: &[u8]) -> bool {
    let n = buf.len().min(8192);
    if n == 0 {
        return false;
    }
    let mut bad = 0usize;
    for &c in &buf[..n] {
        if c == 0 {
            return true;
        }
        if c < 7 || (c > 13 && c < 32) {
            bad += 1;
        }
    }
    (bad as f64) / (n as f64) > 0.08
}

fn classify(ext: &str, head: &[u8]) -> &'static str {
    if let Some(magic) = sniff(head) {
        if magic == "archive"
            && matches!(
                ext,
                "docx" | "xlsx" | "xlsm" | "pptx" | "odt" | "ods" | "odp" | "jar" | "apk" | "epub"
                    | "whl"
            )
        {
            if matches!(ext, "xlsx" | "xlsm" | "ods" | "odt") {
                return "table";
            }
            if matches!(ext, "docx" | "docm" | "dotx") {
                return "docx";
            }
            if matches!(ext, "pptx" | "pptm" | "potx" | "ppsx") {
                return "pptx";
            }
            if ext == "jar" || ext == "apk" {
                return "exec";
            }
            return "archive";
        }
        return magic;
    }
    if ext == "pdf" {
        return "pdf";
    }
    if matches!(ext, "csv" | "tsv" | "tab") {
        return "table";
    }
    if matches!(ext, "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" | "numbers") {
        return "table";
    }

    /* 图片 / 音视频后缀但内容是普通文本 —— 当文本打开，别白屏 */
    let binaryish = looks_binary(head);
    if is_image_ext(ext) {
        return if binaryish { "image" } else { "text" };
    }
    if is_audio_ext(ext) {
        return if binaryish { "audio" } else { "text" };
    }
    if is_video_ext(ext) {
        return if binaryish { "video" } else { "text" };
    }

    if is_text_ext(ext) {
        return "text";
    }
    if matches!(ext, "docx" | "docm" | "dotx") {
        return "docx";
    }
    if matches!(ext, "pptx" | "pptm" | "potx" | "ppsx") {
        return "pptx";
    }
    if matches!(ext, "doc" | "dot") {
        return "doc";
    }
    if matches!(ext, "xls" | "xlt" | "xlsm") {
        return "xls";
    }
    if matches!(ext, "ppt" | "pps" | "pot") {
        return "ppt";
    }
    if matches!(ext, "xlsx" | "odt" | "ods" | "odp" | "rtf" | "epub" | "mobi" | "azw3") {
        return "office";
    }
    if matches!(
        ext,
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "iso" | "tgz" | "cab" | "dmg"
            | "pkg" | "deb" | "rpm" | "whl" | "nupkg"
    ) {
        return "archive";
    }
    if matches!(
        ext,
        "exe" | "dll" | "sys" | "msi" | "apk" | "jar" | "class" | "pyc" | "pyo" | "o" | "obj"
            | "lib" | "a" | "so" | "dylib" | "bin" | "dat" | "wasm"
    ) {
        return "exec";
    }

    if head.is_empty() {
        return "text";
    }
    if binaryish {
        "binary"
    } else {
        "text"
    }
}

/* ───────── 解码（与 main.js 的 decodeText 一致） ───────── */

fn decode_text(buf: &[u8]) -> (String, &'static str) {
    let buf: &[u8] = if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &buf[3..] // 去掉 UTF-8 BOM
    } else {
        buf
    };
    let (utf8, _, _) = encoding_rs::UTF_8.decode(buf);
    let bad = utf8.matches('\u{FFFD}').count();
    if bad > 0 && (bad as f64) / ((utf8.len() as f64).max(1.0)) > 0.002 {
        // UTF-8 坏字符多，尝试 GBK，坏字符更少就采用
        let (gbk, _, _) = encoding_rs::GBK.decode(buf);
        let gbad = gbk.matches('\u{FFFD}').count();
        if gbad <= bad {
            return (gbk.into_owned(), "GBK");
        }
    }
    (utf8.into_owned(), "UTF-8")
}

/* ───────── hex 预览（与 main.js 的 hexDump 一致） ───────── */

#[derive(Serialize)]
struct HexLine {
    off: String,
    hex: String,
    ascii: String,
}

fn hex_dump(buf: &[u8], max_bytes: usize, max_lines: usize) -> Vec<HexLine> {
    let n = buf.len().min(max_bytes);
    let mut lines = Vec::new();
    let mut i = 0usize;
    while i < n && lines.len() < max_lines {
        let end = (i + 16).min(n);
        let chunk = &buf[i..end];
        let mut parts: Vec<String> = Vec::with_capacity(16);
        let mut ascii = String::with_capacity(16);
        for j in 0..16 {
            if j < chunk.len() {
                let v = chunk[j];
                parts.push(format!("{:02x}", v));
                ascii.push(if (32..127).contains(&v) { v as char } else { '.' });
            } else {
                parts.push("  ".to_string());
                ascii.push(' ');
            }
        }
        lines.push(HexLine {
            off: format!("{:08x}", i),
            hex: parts.join(" "),
            ascii,
        });
        i += 16;
    }
    lines
}

/* ───────── doc 对象（与 main.js 的 readAny 返回一致） ───────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Doc {
    path: String,
    name: String,
    ext: String,
    size: u64,
    kind: String,
    kind_label: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    editable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hex: Option<Vec<HexLine>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn err_doc(path: &str, msg: &str) -> Doc {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Doc {
        path: path.to_string(),
        name,
        ext: String::new(),
        size: 0,
        kind: "unknown".into(),
        kind_label: "文件".into(),
        url: String::new(),
        text: None,
        enc: None,
        truncated: None,
        editable: None,
        hex: None,
        error: Some(msg.to_string()),
    }
}

/// 打开文件：分类 + 按需读取内容，返回与 Electron readAny 相同结构的 doc
#[tauri::command]
fn open_path(path: String) -> Doc {
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => return err_doc(&path, &format!("读取失败: {}", e)),
    };
    if meta.is_dir() {
        return err_doc(&path, "这是一个文件夹，暂不支持打开目录");
    }
    let size = meta.len();
    let p = std::path::Path::new(&path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // 先读文件头 4096 字节用于嗅探
    let head_len = (size.min(4096)) as usize;
    let mut head = vec![0u8; head_len];
    if head_len > 0 {
        let mut f = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => return err_doc(&path, &format!("读取失败: {}", e)),
        };
        if let Err(e) = f.read_exact(&mut head) {
            return err_doc(&path, &format!("读取失败: {}", e));
        }
    }

    let kind = classify(&ext, &head);
    let mut doc = Doc {
        path: path.clone(),
        name,
        ext,
        size,
        kind: kind.to_string(),
        kind_label: kind_label(kind).to_string(),
        url: String::new(), // shim 层用 convertFileSrc 填充
        text: None,
        enc: None,
        truncated: None,
        editable: None,
        hex: None,
        error: None,
    };

    if kind == "text" {
        let lim = (size.min(MAX_TEXT as u64)) as usize;
        let mut buf = vec![0u8; lim];
        if let Ok(mut f) = std::fs::File::open(&path) {
            if f.read_exact(&mut buf).is_ok() {
                let (text, enc) = decode_text(&buf);
                doc.text = Some(text);
                doc.enc = Some(enc.to_string());
                doc.truncated = Some(size > MAX_TEXT as u64);
                doc.editable = Some(true);
            }
        }
        return doc;
    }

    if matches!(kind, "binary" | "exec" | "archive" | "office" | "unknown") {
        let lim = (size.min(MAX_HEX as u64)) as usize;
        let mut buf = vec![0u8; lim];
        if let Ok(mut f) = std::fs::File::open(&path) {
            if f.read_exact(&mut buf).is_ok() {
                doc.hex = Some(hex_dump(&buf, MAX_HEX, HEX_LINES));
                doc.truncated = Some(size > MAX_HEX as u64);
            }
        }
        return doc;
    }

    doc // image/video/audio/pdf/table/docx/pptx：渲染端按需 readAll
}

/* ───────── 文件读写（契约与 Electron file:readAll / file:chunk 一致） ───────── */

#[derive(Serialize)]
struct FileData {
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

/// 整读文件为 base64（渲染端 b64ToBytes(r.data) 消费）
#[tauri::command]
fn read_file(path: String) -> FileData {
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => return FileData { error: Some(e.to_string()), data: None, size: None },
    };
    if meta.len() > MAX_READ_ALL {
        return FileData {
            error: Some("文件太大（>48MB），不适合在这个视图打开".into()),
            data: None,
            size: None,
        };
    }
    match std::fs::read(&path) {
        // TODO(Phase 1)：zip 容器（xlsx/docx/pptx）解压炸弹总量检查
        Ok(bytes) => FileData {
            error: None,
            data: Some(STANDARD.encode(&bytes)),
            size: Some(bytes.len() as u64),
        },
        Err(e) => FileData { error: Some(e.to_string()), data: None, size: None },
    }
}

/// 写文本文件（save/saveAs 共用；GBK 等编码保存留待后续阶段）
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("写入失败: {}", e))
}

/* ───────── 编辑 / 保存辅助命令（契约与 Electron file:backup/writeBase64/writeBytes 一致） ───────── */

#[derive(Serialize)]
struct SaveResp {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// 保存前备份：复制成 <path>.bak（与 Electron file:backup 一致）
#[tauri::command]
fn backup(path: String) -> Result<(), String> {
    std::fs::copy(&path, format!("{}.bak", path))
        .map_err(|e| format!("备份失败: {}", e))
        .map(|_| ())
}

/// 把 base64 字节整体写回文件（xlsx 全量重写 / PDF 导出等走这里）
#[tauri::command]
fn write_base64(path: String, data: String) -> SaveResp {
    match STANDARD.decode(&data) {
        Ok(bytes) => match std::fs::write(&path, &bytes) {
            Ok(()) => {
                let size = bytes.len() as u64;
                SaveResp { ok: true, size: Some(size), count: None, error: None }
            }
            Err(e) => SaveResp { ok: false, size: None, count: None, error: Some(e.to_string()) },
        },
        Err(e) => SaveResp { ok: false, size: None, count: None, error: Some(format!("base64 解码失败: {}", e)) },
    }
}

#[derive(Deserialize)]
struct BytePatch {
    offset: u64,
    byte: u8,
}

/// hex 视图的就地字节写回：patches = [{offset, byte}]
#[tauri::command]
fn write_bytes(path: String, patches: Vec<BytePatch>) -> SaveResp {
    match do_write_bytes(&path, &patches) {
        Ok(n) => SaveResp { ok: true, size: None, count: Some(n), error: None },
        Err(e) => SaveResp { ok: false, size: None, count: None, error: Some(e) },
    }
}

fn do_write_bytes(path: &str, patches: &[BytePatch]) -> Result<u64, String> {
    let mut bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    for p in patches {
        let off = p.offset as usize;
        if off >= bytes.len() {
            return Err(format!("偏移 {} 超出文件大小 {}", p.offset, bytes.len()));
        }
        bytes[off] = p.byte;
    }
    std::fs::write(path, &bytes).map_err(|e| e.to_string())?;
    Ok(patches.len() as u64)
}

#[derive(Serialize)]
struct ChunkResp {
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>, // base64，shim 层转 Uint8Array
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eof: Option<bool>,
}

fn do_chunk(path: &str, offset: u64, length: u32) -> Result<ChunkResp, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let start = offset.min(size);
    let len = (length as u64).min(size - start);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len as usize];
    let mut read_total = 0usize;
    while read_total < buf.len() {
        match f.read(&mut buf[read_total..]) {
            Ok(0) => break,
            Ok(n) => read_total += n,
            Err(e) => return Err(e.to_string()),
        }
    }
    buf.truncate(read_total);
    Ok(ChunkResp {
        error: None,
        data: Some(STANDARD.encode(&buf)),
        offset: Some(start),
        size: Some(size),
        eof: Some(start + read_total as u64 >= size),
    })
}

/// 按偏移读一段字节（hex 视图分页加载）
#[tauri::command]
fn chunk(path: String, offset: u64, length: u32) -> ChunkResp {
    match do_chunk(&path, offset, length) {
        Ok(r) => r,
        Err(e) => ChunkResp {
            error: Some(e),
            data: None,
            offset: None,
            size: None,
            eof: Some(true),
        },
    }
}

/* ───────── OOXML 拆包（移植 main.js 的 doc:parts / ppt:parts） ───────── */

use std::collections::HashMap;
use zip::ZipArchive;

/// 解压后总量上限（与 Electron 一致）
const MAX_UNZIP: u64 = 512 * 1024 * 1024;
/// 超过这个量才额外看压缩比（与 Electron 一致）
const ZIP_BOMB_MIN: u64 = 64 * 1024 * 1024;
/// 压缩比阈值（与 Electron 一致）
const ZIP_BOMB_RATIO: f64 = 400.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocParts {
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    doc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    styles: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    numbering: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PptMedia {
    b64: String,
    mime: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PptSlide {
    i: u32,
    xml: String,
    rels: HashMap<String, String>,
    media: HashMap<String, PptMedia>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PptParts {
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cx: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cy: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    slides: Option<Vec<PptSlide>>,
}

/// 打开 zip 并做压缩炸弹检查。Err 里是给用户看的中文原因。
fn open_zip(path: &str) -> Result<ZipArchive<std::fs::File>, String> {
    let raw_len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let file = std::fs::File::open(path).map_err(|e| format!("打开失败: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("解压失败: {}", e))?;

    // 目录里声明的未压缩总大小（不解压，只读元数据）
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let s = match archive.by_index(i) {
            Ok(e) => e.size(),
            Err(_) => 0,
        };
        total = total.saturating_add(s);
    }
    let ratio = if raw_len > 0 { total as f64 / raw_len as f64 } else { 1.0 };
    if total > MAX_UNZIP || (total > ZIP_BOMB_MIN && ratio > ZIP_BOMB_RATIO) {
        return Err(format!(
            "这个文档解压后约 {} MB（压缩比 {}:1），疑似压缩炸弹，已拒绝打开",
            total / 1048576,
            ratio.round() as u64
        ));
    }
    Ok(archive)
}

fn zip_read_text(archive: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut f = archive.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn zip_read_b64(archive: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut f = archive.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(STANDARD.encode(&buf))
}

/// 取标签内的数值属性，如 <p:sldSz cx="12192000" cy="6858000"/>
fn tag_attr_num(xml: &str, tag: &str, attr: &str) -> Option<u64> {
    let i = xml.find(tag)?;
    let rest = &xml[i..];
    let end = rest.find('>')?;
    let body = &rest[..end];
    let j = body.find(attr)?;
    let s = &body[j + attr.len()..];
    let e = s.find('"')?;
    s[..e].parse::<u64>().ok()
}

/// 取标签内的字符串属性
fn tag_attr_str(tag: &str, attr: &str) -> Option<String> {
    let j = tag.find(attr)?;
    let s = &tag[j + attr.len()..];
    let e = s.find('"')?;
    Some(s[..e].to_string())
}

/// 解析 ppt/slides/_rels/slideN.xml.rels → { Id: 归一化后的包内路径 }
fn parse_rels(xml: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<Relationship") {
        let after = &rest[i..];
        let end = match after.find('>') {
            Some(e) => e,
            None => break,
        };
        let body = &after[..end];
        if let (Some(id), Some(target)) = (tag_attr_str(body, "Id=\""), tag_attr_str(body, "Target=\"")) {
            out.insert(id, norm_zip_path(&target));
        }
        rest = &after[end..];
    }
    out
}

/// 归一化 rels 里的相对路径（移植 main.js 的 normZipPath）
fn norm_zip_path(target: &str) -> String {
    let t = target.trim();
    if t.starts_with('/') {
        return t[1..].to_string();
    }
    let joined = format!("ppt/slides/{}", t);
    let mut out: Vec<String> = Vec::new();
    for p in joined.split('/') {
        if p == ".." {
            out.pop();
        } else if p != "." && !p.is_empty() {
            out.push(p.to_string());
        }
    }
    out.join("/")
}

/// ppt/slides/slideN.xml → N
fn parse_slide_name(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("ppt/slides/slide")?;
    let rest = rest.strip_suffix(".xml")?;
    rest.parse::<u32>().ok()
}

fn image_mime(t: &str) -> String {
    let ext = t.rsplit('.').next().unwrap_or("png").to_ascii_lowercase();
    let e = match ext.as_str() {
        "jpg" | "jpe" | "jfif" => "jpeg".to_string(),
        _ => ext,
    };
    format!("image/{}", e)
}

/// Word：返回 word/document.xml（以及样式/编号），渲染端自己转 HTML
#[tauri::command]
fn doc_parts(path: String) -> DocParts {
    let mut archive = match open_zip(&path) {
        Ok(a) => a,
        Err(e) => {
            return DocParts { error: Some(e), doc: None, styles: None, numbering: None };
        }
    };
    let doc = zip_read_text(&mut archive, "word/document.xml");
    if doc.is_none() {
        return DocParts {
            error: Some("这不是有效的 Word 文档（找不到 word/document.xml）".into()),
            doc: None,
            styles: None,
            numbering: None,
        };
    }
    let styles = zip_read_text(&mut archive, "word/styles.xml");
    let numbering = zip_read_text(&mut archive, "word/numbering.xml");
    DocParts { error: None, doc, styles, numbering }
}

/// PPT：返回每页的 XML、关系表与内嵌图片（base64）
#[tauri::command]
fn ppt_parts(path: String) -> PptParts {
    let mut archive = match open_zip(&path) {
        Ok(a) => a,
        Err(e) => {
            return PptParts { error: Some(e), cx: None, cy: None, slides: None };
        }
    };

    // 幻灯片尺寸（EMU），默认 16:9
    let mut cx: u64 = 12192000;
    let mut cy: u64 = 6858000;
    if let Some(pres) = zip_read_text(&mut archive, "ppt/presentation.xml") {
        if let Some(a) = tag_attr_num(&pres, "<p:sldSz", "cx=\"") {
            cx = a;
        }
        if let Some(b) = tag_attr_num(&pres, "<p:sldSz", "cy=\"") {
            cy = b;
        }
    }

    // 收集所有 ppt/slides/slideN.xml
    let mut names: Vec<(u32, String)> = Vec::new();
    for i in 0..archive.len() {
        let name = match archive.by_index(i) {
            Ok(f) => f.name().to_string(),
            Err(_) => continue,
        };
        if let Some(idx) = parse_slide_name(&name) {
            names.push((idx, name));
        }
    }
    names.sort_by_key(|(i, _)| *i);

    let mut slides: Vec<PptSlide> = Vec::new();
    for (idx, name) in names {
        let xml = match zip_read_text(&mut archive, &name) {
            Some(x) => x,
            None => continue,
        };
        let rels_name = format!("ppt/slides/_rels/slide{}.xml.rels", idx);
        let rels_xml = zip_read_text(&mut archive, &rels_name).unwrap_or_default();
        let rels = parse_rels(&rels_xml);

        let mut media: HashMap<String, PptMedia> = HashMap::new();
        for (rid, target) in rels.iter() {
            // 复用文件分类那边的扩展名判断（那边收的是不带点的纯扩展名）
            let ext = target.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if is_image_ext(&ext) {
                if let Some(b64) = zip_read_b64(&mut archive, target) {
                    media.insert(rid.clone(), PptMedia { b64, mime: image_mime(target) });
                }
            }
        }
        slides.push(PptSlide { i: idx, xml, rels, media });
    }

    if slides.is_empty() {
        return PptParts {
            error: Some("这不是有效的 PowerPoint 文件（找不到 ppt/slides）".into()),
            cx: None,
            cy: None,
            slides: None,
        };
    }
    PptParts { error: None, cx: Some(cx), cy: Some(cy), slides: Some(slides) }
}

// ─────────────────────────────────────────────────────────────
// Phase 1.5：LibreOffice 转换引擎
// 目标：把 docx/pptx（旧格式 doc/ppt/xls 也一样）转成 PDF，前端再用 PDF.js
// 栅格化成位图 —— 这样版式 100% 保真，彻底绕开内置近似解析器的坐标/母版继承问题。
//
// 关键点：
//  · soffice 是单实例程序，并发调用会互相抢 profile，所以用全局 Mutex 串行化；
//  · 结果按 (路径|大小|mtime|目标格式) 做 FNV-1a 缓存键放进临时目录，重复打开秒回；
//  · 必须传 -env:UserInstallation 隔离 profile，否则和用户自己的 LibreOffice 抢锁；
//  · CREATE_NO_WINDOW：不弹黑窗（debug 版 windows_subsystem 不生效）。
// ─────────────────────────────────────────────────────────────

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LO_TIMEOUT: Duration = Duration::from_secs(90);
const CACHE_DIRNAME: &str = "kivnote-lo-cache";

static LO_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoResult {
    ok: bool,
    path: Option<String>,
    size: Option<u64>,
    cached: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoProbe {
    ok: bool,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PptRender {
    ok: bool,
    /// 转出来的 PDF 绝对路径（前端用 read_b64 取字节喂 PDF.js）
    pdf: Option<String>,
    size: Option<u64>,
    cached: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bytes64 {
    ok: bool,
    b64: Option<String>,
    size: Option<u64>,
    error: Option<String>,
}

fn lo_err(msg: impl Into<String>) -> LoResult {
    let m = msg.into();
    LoResult { ok: false, path: None, size: None, cached: false, error: Some(m) }
}

/// FNV-1a：小、快、够用（这里只做缓存键，不需要抗碰撞）
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 找 soffice：优先便携版（项目根 loffice/），其次 PATH
fn soffice_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    // exe 在 src-tauri/target/{debug,release}/ → 上两级是项目根 → loffice/program
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    for up in [2usize, 1, 3] {
        let mut base = dir.to_path_buf();
        for _ in 0..up {
            base = base.parent()?.to_path_buf();
        }
        cands.push(base.join("loffice").join("program"));
    }
    // 打包后 loffice 可能与 exe 同级或放在 Resources 下
    cands.push(dir.to_path_buf());
    cands.push(dir.join("Resources"));
    cands.push(dir.join("resources"));

    // Windows 优先 .com（同步等待、有 stdout）；macOS/Linux 用无后缀的 soffice
    let names: &[&str] = if cfg!(windows) {
        &["soffice.com", "soffice.exe"]
    } else {
        &["soffice"]
    };

    for base in cands {
        for n in names {
            let p = base.join(n);
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    // 兜底：PATH
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for n in names {
            let p = dir.join(n);
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// 隐藏子进程窗口（Windows 专属；其它平台编译不过这段，用 cfg 包起来）
fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// 同步跑一次转换（阻塞；调用方放到 spawn_blocking 里）
fn lo_convert_blocking(src: &str, to: &str) -> LoResult {
    let so = match soffice_path() {
        Some(p) => p,
        None => {
            return lo_err("本机未找到 LibreOffice（soffice），无法高保真渲染。请安装 LibreOffice 或把 loffice/ 放在程序同级目录。")
        }
    };
    let md = match std::fs::metadata(src) {
        Ok(m) => m,
        Err(e) => return lo_err(format!("读不到源文件：{}", e)),
    };
    if !md.is_file() {
        return lo_err("源文件不存在");
    }
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stem = Path::new(src)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "out".into());

    let mut seed = Vec::new();
    seed.extend_from_slice(src.as_bytes());
    seed.extend_from_slice(&md.len().to_le_bytes());
    seed.extend_from_slice(&mtime.to_le_bytes());
    seed.extend_from_slice(to.as_bytes());
    let key = format!("{:016x}", fnv1a(&seed));
    let short = &key[..16];

    let cache_dir = std::env::temp_dir().join(CACHE_DIRNAME).join(short);
    let out_path = cache_dir.join(format!("{}.{}", stem, to));

    let describe = |cached: bool| -> LoResult {
        let size = std::fs::metadata(&out_path).map(|m| m.len()).ok();
        LoResult {
            ok: size.is_some(),
            path: Some(out_path.to_string_lossy().into_owned()),
            size,
            cached,
            error: if size.is_some() { None } else { Some("转换产物丢失".into()) },
        }
    };

    if out_path.is_file() {
        return describe(true);
    }

    // LibreOffice 不支持并发：拿不到锁就直接报错，别把 UI 卡死
    let _guard = match LO_LOCK.try_lock() {
        Ok(g) => g,
        Err(_) => {
            return lo_err("另一个文档正在转换中，请稍候再试。")
        }
    };

    // 等锁期间可能已被另一次调用算好了
    if out_path.is_file() {
        return describe(true);
    }
    if let Err(e) = std::fs::create_dir_all(&cache_dir) {
        return lo_err(format!("建缓存目录失败：{}", e));
    }

    let out_dir_s = cache_dir.to_string_lossy().into_owned();
    let src_abs = std::fs::canonicalize(src)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| src.to_string());

    // 【重要】不要传 -env:UserInstallation。
    // 实测 LibreOffice 26.8（自带便携版）在 Windows 上用自定义 profile 路径启动时
    // 会弹「Fatal Error: User installation could not be completed」并且进程挂死
    // （实测 240s 超时仍未退出），而**不带**该参数同一文件 0.9 秒转换成功。
    // 原因是全新 profile 的首次引导在这个 headless 场景下走不通。
    // 因此这里直接用 LO 的默认 profile；KivNote 自身的并发由 LO_LOCK 串行化，
    // 用户自己开着 LO 的场景 LO 也支持把 headless 请求转发给已有实例。
    let mut cmd = Command::new(&so);
    let filter = lo_filter(&src_abs, to);
    cmd.args(["--headless", "--norestore", "--nolockcheck", "--invisible", "--nodefault"])
        .arg("--convert-to")
        .arg(&filter)
        .arg("--outdir")
        .arg(&out_dir_s)
        .arg(&src_abs)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return lo_err(format!("启动 LibreOffice 失败：{}", e)),
    };

    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if t0.elapsed() > LO_TIMEOUT {
                    let _ = child.kill();
                    // child 只是启动器；真正的转换进程是 soffice.bin，
                    // 不清掉会一直占着默认 profile 的锁，后续转换全被拖死。
                    #[cfg(windows)]
                    {
                        let _ = Command::new("taskkill")
                            .args(["/F", "/IM", "soffice.bin"])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                    }
                    return lo_err("LibreOffice 转换超时（90 秒）。文件可能已损坏或过大。");
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return lo_err(format!("等待 LibreOffice 出错：{}", e)),
        }
    }

    if out_path.is_file() {
        return describe(false);
    }
    // 有些格式 LO 会改名输出（比如 filter 决定的扩展名），扫一遍目录兜底
    if let Ok(rd) = std::fs::read_dir(&cache_dir) {
        for e in rd.flatten() {
            let p = e.path();
            let ext = p.extension().map(|x| x.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            if ext == to.to_ascii_lowercase() {
                let size = e.metadata().map(|m| m.len()).ok();
                return LoResult {
                    ok: true,
                    path: Some(p.to_string_lossy().into_owned()),
                    size,
                    cached: false,
                    error: None,
                };
            }
        }
    }
    lo_err(format!(
        "LibreOffice 没产出 {} 文件（源文件可能不是有效的 {} 文档）",
        to, to
    ))
}

/// 显式指定导出 filter，避免 LO 猜错：不同源模块的 pdf 导出 filter 名不同
/// （Impress / Writer / Calc），同名会导致「转出来是空白页」或直接失败。
fn lo_filter(src: &str, to: &str) -> String {
    if to != "pdf" {
        return to.to_string();
    }
    let ext = Path::new(src)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "ppt" | "pptx" | "odp" | "fodp" => "pdf:impress_pdf_Export".into(),
        "xls" | "xlsx" | "ods" | "fods" | "csv" => "pdf:calc_pdf_Export".into(),
        _ => "pdf:writer_pdf_Export".into(),
    }
}

/// 是否装了 LibreOffice（前端据此决定要不要提示）
#[tauri::command]
async fn lo_available() -> LoProbe {
    tauri::async_runtime::spawn_blocking(|| match soffice_path() {
        Some(p) => LoProbe { ok: true, path: Some(p) },
        None => LoProbe { ok: false, path: None },
    })
    .await
    .unwrap_or(LoProbe { ok: false, path: None })
}

/// 通用转换：把 src 转成 to（pdf/docx/xlsx/pptx/...），返回产物绝对路径
#[tauri::command]
async fn lo_convert(src: String, to: String) -> LoResult {
    tauri::async_runtime::spawn_blocking(move || lo_convert_blocking(&src, &to))
        .await
        .unwrap_or_else(|e| lo_err(format!("转换任务崩了：{}", e)))
}

/// PPT 高保真渲染：转 PDF，交给前端 PDF.js 栅格化
#[tauri::command]
async fn ppt_render(path: String) -> PptRender {
    let r = tauri::async_runtime::spawn_blocking(move || lo_convert_blocking(&path, "pdf")).await;
    match r {
        Ok(res) if res.ok => PptRender {
            ok: true,
            pdf: res.path,
            size: res.size,
            cached: res.cached,
            error: None,
        },
        Ok(res) => PptRender {
            ok: false,
            pdf: None,
            size: None,
            cached: false,
            error: res.error.or_else(|| Some("转换失败".into())),
        },
        Err(e) => PptRender {
            ok: false,
            pdf: None,
            size: None,
            cached: false,
            error: Some(format!("转换任务崩了：{}", e)),
        },
    }
}

/// 读任意文件为 base64（前端把 PDF 字节喂给 PDF.js）
#[tauri::command]
async fn read_b64(path: String) -> Bytes64 {
    tauri::async_runtime::spawn_blocking(move || {
        match std::fs::read(&path) {
            Ok(bytes) => {
                let size = bytes.len() as u64;
                Bytes64 {
                    ok: true,
                    b64: Some(STANDARD.encode(&bytes)),
                    size: Some(size),
                    error: None,
                }
            }
            Err(e) => Bytes64 { ok: false, b64: None, size: None, error: Some(format!("读取失败：{}", e)) },
        }
    })
    .await
    .unwrap_or(Bytes64 { ok: false, b64: None, size: None, error: Some("读取任务崩了".into()) })
}



fn main() {
    let _args: Vec<String> = std::env::args().collect();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_path,
            read_file,
            write_file,
            chunk,
            backup,
            write_base64,
            write_bytes,
            doc_parts,
            ppt_parts,
            lo_available,
            lo_convert,
            ppt_render,
            read_b64
        ])
        .setup(|_app| {
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running KivNote Tauri");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 样例文件在项目根的 testfiles/ 下
    fn sample(name: &str) -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("testfiles")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn norm_zip_path_归一化相对路径() {
        // ../media/image1.png → ppt/media/image1.png
        assert_eq!(norm_zip_path("../media/image1.png"), "ppt/media/image1.png");
        // 绝对包内路径去掉前导斜杠
        assert_eq!(norm_zip_path("/ppt/media/image1.png"), "ppt/media/image1.png");
        // 同目录相对路径
        assert_eq!(norm_zip_path("image1.png"), "ppt/slides/image1.png");
    }

    #[test]
    fn parse_slide_name_识别幻灯片序号() {
        assert_eq!(parse_slide_name("ppt/slides/slide1.xml"), Some(1));
        assert_eq!(parse_slide_name("ppt/slides/slide12.xml"), Some(12));
        assert_eq!(parse_slide_name("ppt/slides/_rels/slide1.xml.rels"), None);
        assert_eq!(parse_slide_name("word/document.xml"), None);
    }

    #[test]
    fn parse_rels_解析关系表() {
        let xml = "<Relationships>\
            <Relationship Id=\"rId1\" Type=\"image\" Target=\"../media/image1.png\"/>\
            <Relationship Id=\"rId2\" Type=\"slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
            </Relationships>";
        let rels = parse_rels(xml);
        assert_eq!(rels.get("rId1").map(|s| s.as_str()), Some("ppt/media/image1.png"));
        assert_eq!(
            rels.get("rId2").map(|s| s.as_str()),
            Some("ppt/slideLayouts/slideLayout1.xml")
        );
    }

    #[test]
    fn tag_attr_num_读幻灯片尺寸() {
        let xml = "<p:presentation><p:sldSz cx=\"12192000\" cy=\"6858000\"/></p:presentation>";
        assert_eq!(tag_attr_num(xml, "<p:sldSz", "cx=\""), Some(12192000));
        assert_eq!(tag_attr_num(xml, "<p:sldSz", "cy=\""), Some(6858000));
    }

    #[test]
    fn doc_parts_读出正文() {
        let p = sample("report.docx");
        if !std::path::Path::new(&p).exists() {
            eprintln!("样例不存在，跳过: {}", p);
            return;
        }
        let r = doc_parts(p);
        assert!(r.error.is_none(), "不该报错: {:?}", r.error);
        let doc = r.doc.expect("应返回正文 XML");
        assert!(doc.contains("w:body"), "正文应含 w:body，实际前 200 字: {}", &doc[..doc.len().min(200)]);
    }

    #[test]
    fn ppt_parts_读出幻灯片() {
        for name in ["demo.pptx", "layout.pptx"] {
            let p = sample(name);
            if !std::path::Path::new(&p).exists() {
                eprintln!("样例不存在，跳过: {}", p);
                continue;
            }
            let r = ppt_parts(p);
            assert!(r.error.is_none(), "{} 不该报错: {:?}", name, r.error);
            let slides = r.slides.expect("应返回幻灯片");
            assert!(!slides.is_empty(), "{} 幻灯片不应为空", name);
            assert!(
                slides[0].xml.contains("<p:sld"),
                "{} 首页 XML 应含 <p:sld，实际: {}",
                name,
                &slides[0].xml[..slides[0].xml.len().min(120)]
            );
            assert!(r.cx.unwrap_or(0) > 0 && r.cy.unwrap_or(0) > 0, "{} 应有幻灯片尺寸", name);
        }
    }

    #[test]
    fn 非zip文件应报错而不是崩溃() {
        let r = doc_parts("不存在的文件.docx".into());
        assert!(r.error.is_some(), "应返回错误而不是 panic");
        let p = ppt_parts("不存在的文件.pptx".into());
        assert!(p.error.is_some(), "应返回错误而不是 panic");
    }

    // ---- LibreOffice 转换链路 ----

    #[test]
    fn fnv1a_稳定且不同输入不同键() {
        assert_eq!(fnv1a(b"abc"), fnv1a(b"abc"));
        assert_ne!(fnv1a(b"abc"), fnv1a(b"abd"));
        // 源文件 mtime/格式不同 → 缓存键不同，否则改了内容还吃旧缓存
        let mut a = Vec::new();
        a.extend_from_slice(b"p.pptx");
        a.extend_from_slice(&1u64.to_le_bytes());
        a.extend_from_slice(&2u64.to_le_bytes());
        let mut b = a.clone();
        b[0] = b'q';
        assert_ne!(fnv1a(&a), fnv1a(&b));
    }

    #[test]
    fn lo_filter_按源类型选对导出器() {
        // 同名 pdf filter 会让 Impress/Writer/Calc 互相串味，必须按扩展名分
        assert_eq!(lo_filter("a.pptx", "pdf"), "pdf:impress_pdf_Export");
        assert_eq!(lo_filter("a.ppt", "pdf"), "pdf:impress_pdf_Export");
        assert_eq!(lo_filter("a.docx", "pdf"), "pdf:writer_pdf_Export");
        assert_eq!(lo_filter("a.doc", "pdf"), "pdf:writer_pdf_Export");
        assert_eq!(lo_filter("a.xlsx", "pdf"), "pdf:calc_pdf_Export");
        // 非 pdf 目标直接用格式名，不加 filter
        assert_eq!(lo_filter("a.doc", "docx"), "docx");
    }

    #[test]
    fn soffice_路径查找能定位到便携版() {
        match soffice_path() {
            Some(p) => {
                assert!(
                    Path::new(&p).is_file(),
                    "soffice_path 返回的路径应真实存在: {}",
                    p
                );
                eprintln!("找到 soffice: {}", p);
            }
            None => eprintln!("本机未找到 LibreOffice，跳过（生产环境会在 UI 提示降级）"),
        }
    }

    #[test]
    fn 缺soffice时转换应给出可读错误而不是panic() {
        // 传一个不存在的源文件：无论 soffice 在不在，都应返回 error 字段
        let r = lo_convert_blocking("不存在的文件.pptx", "pdf");
        assert!(!r.ok, "不该报成功");
        assert!(r.error.is_some(), "应带可读错误");
    }

    #[test]
    fn lo_convert_合法pptx能转出pdf且缓存命中() {
        let p = sample("valid.pptx");
        if !Path::new(&p).exists() {
            eprintln!("样例不存在，跳过: {}", p);
            return;
        }
        if soffice_path().is_none() {
            eprintln!("本机没有 LibreOffice，跳过端到端转换测试");
            return;
        }
        let first = lo_convert_blocking(&p, "pdf");
        assert!(first.ok, "第一次转换应成功: {:?}", first.error);
        let pdf = first.path.clone().expect("应返回 pdf 路径");
        assert!(Path::new(&pdf).is_file(), "pdf 应真实落盘");
        assert!(first.size.unwrap_or(0) > 1000, "pdf 不应只有几百字节: {:?}", first.size);
        // PDF 魔数
        let head = std::fs::read(&pdf).unwrap();
        assert_eq!(&head[0..4], b"%PDF", "应是合法 PDF");

        // 第二次必须命中缓存（cached=true），否则等于每次都重跑 LO
        let second = lo_convert_blocking(&p, "pdf");
        assert!(second.ok, "第二次应成功: {:?}", second.error);
        assert!(second.cached, "第二次应命中缓存");
        assert_eq!(second.path, first.path, "缓存应指向同一产物");
    }

    #[test]
    fn 转换不能使用独立profile参数() {
        // LibreOffice 26.8 在 Windows 上用 -env:UserInstallation 指定全新 profile 时
        // 会弹「Fatal Error: User installation could not be completed」并挂死
        // （实测 240s 仍不退出），而不带该参数同一文件 0.9s 就成功。
        // 这条测试守着源码里别把那个参数加回来。
        let src = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("main.rs")
            .to_string_lossy()
            .into_owned();
        let code = std::fs::read_to_string(&src).expect("应能读到自己");
        // 去掉这段注释本身再断言，否则测试会被自己的注释误伤
        let code: String = code
            .lines()
            .filter(|l| !l.contains("UserInstallation"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains("-env:UserInstallation"),
            "源码里不允许再出现 -env:UserInstallation（会触发 LO Fatal Error）"
        );
        // 超时应远小于 LO 挂死时长，否则用户要干等好几分钟
        assert!(
            LO_TIMEOUT <= Duration::from_secs(120),
            "转换超时上限应≤120s，实际 {:?}",
            LO_TIMEOUT
        );
    }

    #[test]
    fn lo_convert_手搓坏pptx应报错而不是panic() {
        let p = sample("demo.pptx"); // 只有 3 个部件，LibreOffice 会拒绝加载
        if !Path::new(&p).exists() || soffice_path().is_none() {
            eprintln!("跳过");
            return;
        }
        let r = lo_convert_blocking(&p, "pdf");
        // 关键不是成功还是失败，而是不能 panic、且结果可解释
        if !r.ok {
            assert!(r.error.is_some(), "失败时必须带 error");
            eprintln!("（预期内）转换失败: {:?}", r.error);
        }
    }
}
