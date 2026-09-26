"""Inline style, scene data, the new stadium's model and app code into one publishable HTML file.

dist/maksimir-pod-kisom.html is the artifact body (no <html>/<head>, the host wraps it);
dist/index.html wraps the same body in a document for local viewing.
"""
import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC, DIST = ROOT / "src", ROOT / "dist"
# The page script is one ES module; these files share its scope and are joined in this order.
ORDER = ["scene.js", "stadium.js", "weather.js", "wind-tunnel.js", "visuals.js", "main.js"]
DESCRIPTION = ("Današnji i novi stadion Maksimir u 3D, jedan uz drugi uz Park Maksimir. "
               "Simulacija vjetra i kiše pokazuje tko pokisne i puše li kroz otvore u kutovima.")
# Visitor counts for the GitHub Pages site; only dist/index.html gets it, not the artifact body.
ANALYTICS = ("<!-- Cloudflare Web Analytics --><script type='module' "
             "src='https://static.cloudflareinsights.com/beacon.min.js' "
             "data-cf-beacon='{\"token\": \"e10d3e9e8ea1433a9161a1f2740e59af\"}'></script>"
             "<!-- End Cloudflare Web Analytics -->")


def main():
    page = (SRC / "page.html").read_text()
    body = (page.replace("{{STYLE}}", (SRC / "style.css").read_text())
                .replace("{{ENV}}", (SRC / "env.json").read_text().replace("</", "<\\/"))
                .replace("{{FUTURE}}", base64.b64encode((SRC / "future-stadium.bin").read_bytes()).decode())
                .replace("{{APP}}", "\n".join((SRC / "js" / f).read_text() for f in ORDER)))
    DIST.mkdir(exist_ok=True)
    (DIST / "maksimir-pod-kisom.html").write_text(body)
    # The title, font links and style block go to <head>, the rest to <body>.
    head, app = body.split('\n<div id="app">', 1)
    (DIST / "index.html").write_text(
        '<!doctype html>\n<html lang="hr">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        f'<meta name="description" content="{DESCRIPTION}">\n'
        '<meta property="og:title" content="Maksimir pod kišom">\n'
        f'<meta property="og:description" content="{DESCRIPTION}">\n'
        + head + '\n</head>\n<body>\n<div id="app">' + app + "\n" + ANALYTICS + "\n</body>\n</html>\n")
    print(f"built {len(body) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
