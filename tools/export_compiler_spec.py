"""Export the Python compiler contract for the TypeScript live compiler.

The Python modules remain the source of truth. The generated JSON is committed so
the web build does not need Python, and a pytest keeps the copy current.
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compiler"))
sys.path.insert(0, str(ROOT / "engine"))

import compile_label  # noqa: E402
import modality  # noqa: E402
import retype  # noqa: E402
import windows  # noqa: E402

OUTPUT = ROOT / "web" / "src" / "lib" / "compiler" / "spec.generated.json"


def build_spec() -> dict:
    lightning = next(model for model in compile_label.PRICES if model.endswith("Lightning"))
    return {
        "CONVERSIONS": [
            {
                "source_words": list(source_words),
                "destination_units": list(destination_units),
                "factor": factor,
            }
            for source_words, destination_units, factor in compile_label.CONVERSIONS
        ],
        "DEFINITIONS": retype.DEFINITIONS,
        "FOLD": {chr(codepoint): replacement for codepoint, replacement in compile_label._FOLD.items()},
        "MODELS": {
            "first_pass": compile_label.DEFAULT_MODEL,
            "typing": retype.DEFAULT_MODEL,
            "lightning": lightning,
        },
        "PARAMS": compile_label.PARAMS,
        "PRICES": {model: list(price) for model, price in compile_label.PRICES.items()},
        "PROMPTS": {
            "first_pass": compile_label.SYSTEM,
            "typing": retype.SYSTEM,
        },
        "SCHEMAS": {
            "first_pass": compile_label.SCHEMA,
            "typing": retype.SCHEMA,
        },
        "TOPIC": {param: list(words) for param, words in windows.TOPIC.items()},
        "TOPIC_WORDS": sorted({word for words in windows.TOPIC.values() for word in words}),
        "VERSIONS": {
            "prompt": compile_label.PROMPT_VERSION,
            "typing": retype.TYPING_VERSION,
            "floor_source": modality.SOURCE,
        },
        "VULGAR": compile_label.VULGAR,
    }


def render_spec() -> str:
    return json.dumps(build_spec(), indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(render_spec(), encoding="utf-8", newline="\n")
    print(OUTPUT.relative_to(ROOT).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
