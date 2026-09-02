from panda_test_agent.session_titles import title_from_first_user_text


def test_title_uses_the_first_user_text_as_one_compact_line():
    assert title_from_first_user_text("  重构\n auth   校验 ") == "重构 auth 校验"


def test_empty_user_text_does_not_create_a_title():
    assert title_from_first_user_text(" \n\t ") is None


def test_long_user_text_is_truncated_without_a_second_model_call():
    text = "a" * 60

    assert title_from_first_user_text(text) == "a" * 47 + "…"
