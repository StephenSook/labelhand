"""The committed TypeScript compiler contract must match the Python source."""

from export_compiler_spec import OUTPUT, render_spec


def test_compiler_spec_is_fresh():
    assert OUTPUT.read_text(encoding="utf-8") == render_spec(), "web/src/lib/compiler/spec.generated.json is stale; run python tools/export_compiler_spec.py"
