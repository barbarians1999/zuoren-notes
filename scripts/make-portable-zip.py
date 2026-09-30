from __future__ import annotations

import hashlib
import sys
import zipfile
from pathlib import Path


def main() -> None:
    source = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    register_script = Path(sys.argv[3]).resolve()
    default_app_script = Path(sys.argv[4]).resolve()
    readme = Path(sys.argv[5]).resolve()
    root = "ZuorenNotes-portable-Windows-x64-2026-09-13"
    app_directory = "ZuorenNotes-Windows-x64"

    if not source.joinpath("ZuorenNotes.exe").is_file():
        raise FileNotFoundError(f"ZuorenNotes.exe is missing from {source}")
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite {output}")

    with zipfile.ZipFile(
        output,
        mode="x",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=6,
        allowZip64=True,
    ) as archive:
        for item in sorted(source.rglob("*")):
            if not item.is_file():
                continue
            relative = item.relative_to(source).as_posix()
            archive.write(item, f"{root}/{app_directory}/{relative}")

        archive.write(register_script, f"{root}/register-zhaoye.ps1")
        archive.write(default_app_script, f"{root}/Set-as-default-app.cmd")
        archive.write(readme, f"{root}/README-zh.md")
        archive.writestr(
            f"{root}/Start-ZuorenNotes.cmd",
            b'@echo off\r\nstart "" "%~dp0ZuorenNotes-Windows-x64\\ZuorenNotes.exe"\r\n',
        )

    with zipfile.ZipFile(output, mode="r") as archive:
        damaged = archive.testzip()
        names = set(archive.namelist())
        required = {
            f"{root}/{app_directory}/ZuorenNotes.exe",
            f"{root}/Start-ZuorenNotes.cmd",
            f"{root}/Set-as-default-app.cmd",
            f"{root}/register-zhaoye.ps1",
            f"{root}/README-zh.md",
        }
        missing = sorted(required - names)
        if damaged or missing:
            raise RuntimeError(f"ZIP validation failed: damaged={damaged!r}, missing={missing!r}")
        entry_count = len(names)

    digest = hashlib.sha256(output.read_bytes()).hexdigest().upper()
    print(f"ZIP={output}")
    print(f"SIZE={output.stat().st_size}")
    print(f"ENTRIES={entry_count}")
    print(f"SHA256={digest}")


if __name__ == "__main__":
    main()
