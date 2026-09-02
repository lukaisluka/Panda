"""Deterministic, protocol-safe titles for ACP sessions.

The title comes from the first textual user message. It deliberately does not
make a second model request: creating a title must not add latency or billable
tokens to a conversation.
"""

from __future__ import annotations

_MAX_TITLE_LENGTH = 48


def title_from_first_user_text(text: str) -> str | None:
    """Return a compact one-line title, or ``None`` for empty user input."""
    normalized = " ".join(text.split())
    if not normalized:
        return None
    if len(normalized) <= _MAX_TITLE_LENGTH:
        return normalized
    return normalized[: _MAX_TITLE_LENGTH - 1].rstrip() + "…"
