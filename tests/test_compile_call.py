"""A page whose answer hits max_tokens is split and compiled in halves instead of being retried as-is."""

import compile_label as cl


def test_truncated_page_is_split_and_both_halves_kept(monkeypatch):
    page = "\n".join(f"Line {i}: Do not apply when wind speeds exceed 10 mph." for i in range(40))
    calls = []

    def fake_request(model, page_no, text, key, thinking):
        calls.append(len(text))
        if len(text) > len(page) * 0.75:
            raise cl.Truncated("finish_reason=length")
        return [{"quote": text.strip().splitlines()[0]}], {"prompt_tokens": 10, "completion_tokens": 5}, "rid"

    monkeypatch.setattr(cl, "_request", fake_request)
    monkeypatch.setattr(cl.time, "sleep", lambda s: None)
    out = cl.call("m", 7, page, "k", False)
    assert out["ok"] and out["splits"] == 1
    assert len(out["rules"]) == 2
    assert out["usage"] == {"prompt_tokens": 20, "completion_tokens": 10}
    assert len(calls) == 3  # one truncated full page, then two halves; no blind retries


def test_split_happens_at_a_line_break():
    a, b = cl.split_text("first sentence.\nsecond sentence.\nthird sentence.\nfourth.")
    assert a + b == "first sentence.\nsecond sentence.\nthird sentence.\nfourth."
    assert b.startswith("\n")
