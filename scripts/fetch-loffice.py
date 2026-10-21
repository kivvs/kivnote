#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
下载并裁剪 LibreOffice，作为 KivNote 的内置 Office 转换引擎。

用法：
    python scripts/fetch-loffice.py

产物：<项目根>/loffice/program/soffice.exe （约 750 MB）

不需要真正安装 LibreOffice，只是把 MSI 里的文件解出来并删掉用不到的部分。
"""

import os
import shutil
import subprocess
import sys
import time
import urllib.request

VERSION = "26.8.1"
MIRROR = "https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable"
MSI_NAME = "LibreOffice_%s_Win_x86-64.msi" % VERSION
MSI_URL = "%s/%s/win/x86_64/%s" % (MIRROR, VERSION, MSI_NAME)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "loffice")
WORK = os.path.join(ROOT, "_lo")
MSI_PATH = os.path.join(WORK, MSI_NAME)

# 转换只需要核心程序，这些目录可以整块删掉
TRIM = [
    "share/extensions",   # 471 MB 扩展（词典、发布器）
    "program/resource",   # 270 MB 图标资源
    "help", "readmes", "presets",
    "share/gallery", "share/template", "share/wizards",
    "share/xpdfimport", "share/autocorr", "share/autotext",
]


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return "%.0f %s" % (n, unit)
        n /= 1024.0
    return "%.1f TB" % n


def dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def download():
    if os.path.exists(MSI_PATH) and os.path.getsize(MSI_PATH) > 100 * 1024 * 1024:
        print("[1/4] 已存在安装包，跳过下载（%s）" % human(os.path.getsize(MSI_PATH)))
        return
    os.makedirs(WORK, exist_ok=True)
    print("[1/4] 下载 %s" % MSI_NAME)
    print("      %s" % MSI_URL)
    t0 = time.time()

    def hook(count, block, total):
        if total > 0:
            pct = min(100, count * block * 100 // total)
            sys.stdout.write("\r      %d%%  %s / %s" % (pct, human(count * block), human(total)))
            sys.stdout.flush()

    urllib.request.urlretrieve(MSI_URL, MSI_PATH, hook)
    print("\n      完成，用时 %.0fs" % (time.time() - t0))


def extract():
    print("[2/4] 解包（管理员安装模式，不安装到系统）")
    if sys.platform != "win32":
        print("      只有 Windows 能解包 MSI，请手动处理")
        sys.exit(1)
    if os.path.isdir(TARGET) and os.path.exists(os.path.join(TARGET, "program", "soffice.exe")):
        print("      已解包，跳过")
        return
    os.makedirs(TARGET, exist_ok=True)
    t0 = time.time()
    r = subprocess.run(["msiexec", "/a", MSI_PATH, "/qn", "TARGETDIR=" + TARGET])
    if r.returncode != 0:
        print("      解包失败（返回码 %d）" % r.returncode)
        sys.exit(1)
    print("      完成，用时 %.0fs" % (time.time() - t0))


def trim():
    print("[3/4] 裁剪体积")
    before = dir_size(TARGET)
    for item in TRIM:
        path = os.path.join(TARGET, item.replace("/", os.sep))
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
            print("      删除 %s" % item)
    after = dir_size(TARGET)
    print("      %s → %s" % (human(before), human(after)))


def verify():
    print("[4/4] 校验")
    exe = os.path.join(TARGET, "program", "soffice.exe")
    if not os.path.exists(exe):
        print("      找不到 soffice.exe，失败")
        sys.exit(1)
    print("      OK  %s" % exe)

    # 清理安装包
    try:
        if os.path.exists(MSI_PATH):
            os.remove(MSI_PATH)
            print("      已删除安装包缓存")
    except OSError:
        pass
    try:
        if os.path.isdir(WORK) and not os.listdir(WORK):
            os.rmdir(WORK)
    except OSError:
        pass

    print("\n完成。现在可以 npm start 了。")


if __name__ == "__main__":
    print("KivNote - LibreOffice 获取脚本\n")
    download()
    extract()
    trim()
    verify()
