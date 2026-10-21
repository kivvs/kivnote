#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 electron-builder 产出的目录打成绿色版 zip。

用法：
    python scripts/make-zip.py            # 自动找 dist/win-unpacked
    python scripts/make-zip.py <源目录>    # 指定目录
"""

import os
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return "%.0f %s" % (n, unit)
        n /= 1024.0
    return "%.1f TB" % n


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist", "win-unpacked")
    if not os.path.isdir(src):
        print("找不到目录：%s" % src)
        print("先跑 npm run dist:dir 生成未打包目录")
        sys.exit(1)

    version = "0.0.0"
    pkg = os.path.join(ROOT, "package.json")
    if os.path.exists(pkg):
        import json
        with open(pkg, encoding="utf-8") as f:
            version = json.load(f).get("version", version)

    out_dir = os.path.join(ROOT, "release")
    os.makedirs(out_dir, exist_ok=True)
    dst = os.path.join(out_dir, "KivNote-%s-win64.zip" % version)

    print("源目录：%s" % src)
    print("输出：%s" % dst)
    t0 = time.time()
    count = 0
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        for root, _dirs, files in os.walk(src):
            for f in files:
                p = os.path.join(root, f)
                z.write(p, os.path.relpath(p, src))
                count += 1
        # 附上说明书
        doc = os.path.join(ROOT, "使用说明.md")
        if os.path.exists(doc):
            z.write(doc, "使用说明.md")

    print("完成：%d 个文件，%s，用时 %.0fs" % (count, human(os.path.getsize(dst)), time.time() - t0))


if __name__ == "__main__":
    main()
