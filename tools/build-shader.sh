#!/usr/bin/env bash
#
# Rebuild spectrum.frag.qsb from spectrum.frag.
#
# The shell loads only the compiled .qsb — Qt 6 has no runtime GLSL compiler —
# so the source is what to read and review, and this is how to check that the
# two match: run it and `git diff` should show nothing.
#
# It also records the source's checksum, so the test suite notices a shader
# edited without being rebuilt.
#
# Needs qsb from Qt 6's shader tools (`qt6-shadertools` on Arch).

set -euo pipefail

cd "$(dirname "$0")/.."
qsb=${QSB:-/usr/lib/qt6/bin/qsb}

"$qsb" --glsl "150,300 es" -o spectrum.frag.qsb spectrum.frag
sha256sum spectrum.frag | cut -d' ' -f1 > spectrum.frag.sha256
