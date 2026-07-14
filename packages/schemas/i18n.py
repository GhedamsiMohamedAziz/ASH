"""Localization — fr/en/ar (instructions.md §7, §7.4).

The agent replies in the `locale` the InboundMessage carries; approval cards,
proactive notifications and error messages (§21) are localized. fr/en/ar at launch
(Arabic is a real requirement for the Tunisian market). RTL is a UI concern (dir=rtl
for ar); this module resolves message keys with locale fallback + interpolation.
"""

from __future__ import annotations

SUPPORTED = ("fr", "en", "ar")
DEFAULT = "fr"

# UI/system strings (error messages come from packages/errors; these are the rest).
CATALOG: dict[str, dict[str, str]] = {
    "approval.needed": {
        "fr": "Approbation requise pour {tool}.",
        "en": "Approval required for {tool}.",
        "ar": "الموافقة مطلوبة من أجل {tool}.",
    },
    "approval.approved": {
        "fr": "Approuvé. Je continue.", "en": "Approved. Continuing.",
        "ar": "تمت الموافقة. أتابع.",
    },
    "cron.created": {
        "fr": "Automatisation créée : {schedule}.",
        "en": "Automation created: {schedule}.",
        "ar": "تم إنشاء الأتمتة: {schedule}.",
    },
    "escalated": {
        "fr": "Je regarde dans {tool}, un instant…",
        "en": "Let me check {tool}, one moment…",
        "ar": "دعني أتحقق من {tool}، لحظة…",
    },
    "dm.redirect": {
        "fr": "Je t'envoie ça en DM 👋", "en": "I'll send that to you in a DM 👋",
        "ar": "سأرسل لك ذلك في رسالة خاصة 👋",
    },
    "link.account": {
        "fr": "Lie ton compte pour commencer : {url}",
        "en": "Link your account to start: {url}",
        "ar": "اربط حسابك للبدء: {url}",
    },
}


def normalize_locale(locale: str | None) -> str:
    """`fr-FR` → `fr`; unknown → DEFAULT. RTL langs (ar) flagged via is_rtl()."""
    if not locale:
        return DEFAULT
    lang = locale.split("-")[0].lower()
    return lang if lang in SUPPORTED else DEFAULT


def is_rtl(locale: str | None) -> bool:
    return normalize_locale(locale) == "ar"


def t(key: str, locale: str | None = None, **vars) -> str:
    """Resolve a message key in the locale, with fallback + {var} interpolation."""
    lang = normalize_locale(locale)
    entry = CATALOG.get(key)
    if entry is None:
        return key  # unknown key → the key itself (visible, not a crash)
    template = entry.get(lang) or entry.get(DEFAULT) or entry.get("en") or key
    try:
        return template.format(**vars) if vars else template
    except KeyError:
        return template  # missing var → leave placeholder rather than crash
