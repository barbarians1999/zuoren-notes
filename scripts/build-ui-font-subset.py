"""Generate a compact WOFF2 UI button subset from SourceHanSansSC-VF.woff2."""

from __future__ import annotations

import pathlib
import subprocess
import sys
import types


def _install_node_brotli_shim() -> None:
    if "brotli" in sys.modules:
        return
    try:
        import brotli  # type: ignore  # noqa: F401
        return
    except ImportError:
        pass

    shim = types.ModuleType("brotli")
    shim.MODE_GENERIC = 0
    shim.MODE_TEXT = 1
    shim.MODE_FONT = 2

    def decompress(data: bytes) -> bytes:
        proc = subprocess.run(
            [
                "node",
                "-e",
                (
                    "const fs=require('fs'),zlib=require('zlib');"
                    "const buf=fs.readFileSync(0);"
                    "fs.writeFileSync(1,zlib.brotliDecompressSync(buf));"
                ),
            ],
            input=bytes(data),
            capture_output=True,
            check=True,
        )
        return proc.stdout

    def compress(data: bytes, mode: int = 2, quality: int = 11) -> bytes:
        proc = subprocess.run(
            [
                "node",
                "-e",
                (
                    "const fs=require('fs'),zlib=require('zlib');"
                    "const mode=Number(process.argv[1]);"
                    "const quality=Number(process.argv[2]);"
                    "const buf=fs.readFileSync(0);"
                    "const out=zlib.brotliCompressSync(buf,{params:{"
                    "[zlib.constants.BROTLI_PARAM_MODE]:mode,"
                    "[zlib.constants.BROTLI_PARAM_QUALITY]:quality"
                    "}});"
                    "fs.writeFileSync(1,out);"
                ),
                str(mode),
                str(quality),
            ],
            input=bytes(data),
            capture_output=True,
            check=True,
        )
        return proc.stdout

    shim.decompress = decompress
    shim.compress = compress
    sys.modules["brotli"] = shim


_install_node_brotli_shim()

from fontTools import subset  # noqa: E402
from fontTools.ttLib import TTFont  # noqa: E402


def collect_codepoints(src_dir: pathlib.Path) -> set[int]:
    chars: set[str] = set()

    for code in range(0x0020, 0x007F):
        chars.add(chr(code))
    for start, end in (
        (0x00A0, 0x0100),
        (0x2000, 0x2070),
        (0x2190, 0x2200),
        (0x2200, 0x2300),
        (0x3000, 0x3040),
        (0xFF00, 0xFFF0),
    ):
        for code in range(start, end):
            chars.add(chr(code))

    # Include all 3,755 GB2312 Level-1 simplified Chinese characters so arbitrary
    # document/folder button labels remain crisp without falling back.
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass

    for ext in ("*.ts", "*.tsx", "*.cjs", "*.css"):
        for file in src_dir.rglob(ext):
            try:
                chars.update(file.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                pass

    return {ord(ch) for ch in chars if ord(ch) >= 0x20}


def rename_font_tables(font: TTFont) -> None:
    name_table = font.get("name")
    if not name_table:
        return
    for record in name_table.names:
        try:
            text = record.toUnicode()
        except UnicodeDecodeError:
            continue
        is_postscript = record.nameID == 6
        if is_postscript:
            updated = (
                text.replace("SourceHanSansSC", "ZhaoyeButtons")
                .replace("SourceHanSans", "ZhaoyeButtons")
                .replace("Source Han Sans SC", "ZhaoyeButtons")
                .replace("Source Han Sans", "ZhaoyeButtons")
            )
        else:
            updated = (
                text.replace("Source Han Sans SC", "Zhaoye Buttons")
                .replace("Source Han Sans", "Zhaoye Buttons")
                .replace("SourceHanSansSC", "ZhaoyeButtons")
                .replace("SourceHanSans", "ZhaoyeButtons")
            )
        if updated != text:
            record.string = updated


def main() -> None:
    root = pathlib.Path(__file__).resolve().parent.parent
    source = root / "src" / "assets" / "SourceHanSansSC-VF.woff2"
    target = root / "src" / "assets" / "ZhaoyeButtons-Subset.woff2"

    codepoints = collect_codepoints(root / "src")
    font = TTFont(source)

    options = subset.Options()
    options.flavor = "woff2"
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.layout_features = ["*"]
    options.retain_gids = False
    options.desubroutinize = False

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)

    rename_font_tables(font)
    font.save(target)

    before_kb = source.stat().st_size / 1024
    after_kb = target.stat().st_size / 1024
    glyph_count = len(font.getGlyphOrder())
    print(f"Subset written: {target} ({before_kb:.1f} KB -> {after_kb:.1f} KB, {glyph_count} glyphs)")


if __name__ == "__main__":
    main()
