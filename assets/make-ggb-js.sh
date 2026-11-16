#!/bin/sh
# Rebuilds assets/app-final.ggb.js from assets/app-final.ggb (run from the project folder).
cd "$(dirname "$0")/.." || exit 1
{
  printf '// Generated from assets/app-final.ggb: the .ggb as base64, so GeoGebra can load it even when\n'
  printf '// index.html is opened as a file (file://), where fetching the .ggb is blocked.\n'
  printf '// Regenerate after changing the .ggb:  sh assets/make-ggb-js.sh\n'
  printf 'window.GGB_BASE64 = "'
  base64 -i assets/app-final.ggb | tr -d '\n'
  printf '";\n'
} > assets/app-final.ggb.js
echo "assets/app-final.ggb.js actualizado."
