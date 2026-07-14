import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from i18n import DEFAULT, is_rtl, normalize_locale, t

def test_normalize():
    assert normalize_locale("fr-FR") == "fr"
    assert normalize_locale("ar-TN") == "ar"
    assert normalize_locale("de") == DEFAULT
    assert normalize_locale(None) == DEFAULT

def test_rtl():
    assert is_rtl("ar-TN") is True
    assert is_rtl("fr") is False

def test_translate_all_locales():
    assert t("dm.redirect", "fr").startswith("Je t'envoie")
    assert t("dm.redirect", "en").startswith("I'll send")
    assert "خاصة" in t("dm.redirect", "ar")

def test_interpolation():
    assert t("approval.needed", "en", tool="github.merge_pr") == "Approval required for github.merge_pr."

def test_fallback_unknown_locale_uses_default():
    assert t("approval.approved", "de") == t("approval.approved", "fr")

def test_unknown_key_returns_key():
    assert t("nope.key", "fr") == "nope.key"

def test_missing_var_does_not_crash():
    assert "{tool}" in t("approval.needed", "en")  # no tool var passed
