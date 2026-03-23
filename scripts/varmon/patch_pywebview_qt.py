#!/usr/bin/env python3
"""
Parche para pywebview + Qt WebEngine con PySide6 6.6+:
setFeaturePermission exige PermissionPolicy (enum), no int.

Ejecutar tras: pip install -r requirements-desktop.txt
"""
from __future__ import annotations

import pathlib
import sys

OLD = """                    self.setFeaturePermission(url, feature, 1)  # QWebPage.PermissionGrantedByUser
                else:
                    self.setFeaturePermission(url, feature, 2)  # QWebPage.PermissionDeniedByUser"""

NEW = """                    self.setFeaturePermission(
                        url,
                        feature,
                        QWebPage.PermissionPolicy.PermissionGrantedByUser,
                    )
                else:
                    self.setFeaturePermission(
                        url,
                        feature,
                        QWebPage.PermissionPolicy.PermissionDeniedByUser,
                    )"""


def main() -> int:
    try:
        import webview
    except ImportError:
        print("pywebview no instalado; omitiendo parche.", file=sys.stderr)
        return 0

    p = pathlib.Path(webview.__file__).resolve().parent / "platforms" / "qt.py"
    text = p.read_text(encoding="utf-8")
    if "PermissionPolicy.PermissionGrantedByUser" in text:
        print(f"pywebview qt.py ya compatible: {p}")
        return 0
    if OLD not in text:
        print(
            f"No se encontró el fragmento esperado en {p}\n"
            "¿Versión distinta de pywebview? Comprueba el error en GitHub.",
            file=sys.stderr,
        )
        return 1
    p.write_text(text.replace(OLD, NEW), encoding="utf-8")
    print(f"Parche aplicado: {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
