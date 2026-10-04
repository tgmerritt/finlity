"""Smart import errors. Messages are fixed strings, never row or file content."""

from __future__ import annotations

# error_type -> (HTTP status, fixed detail). Detail text must never embed
# file names, merchant strings, amounts or exception text.
ERROR_CATALOG: dict[str, tuple[int, str]] = {
    "file_too_large": (413, "The file is larger than the 10 MB limit."),
    "unsupported_type": (
        415,
        "This file type is not supported. Use CSV, OFX, QFX or PDF.",
    ),
    "too_many_rows": (422, "The statement has more rows than the import limit allows."),
    "field_too_large": (
        422,
        "A field in the file is larger than the import limit allows.",
    ),
    "ofx_too_large": (422, "The OFX file is larger than the import limit allows."),
    "unsupported_ofx": (422, "This OFX file uses features that are not supported."),
    "too_many_pages": (422, "The PDF has more pages than the import limit allows."),
    "pdf_text_too_large": (
        422,
        "The PDF contains more text than the import limit allows.",
    ),
    "parse_timeout": (422, "The file took too long to read."),
    "no_text_layer": (
        422,
        "The PDF has no readable text. Scanned statements are not supported.",
    ),
    "encrypted_pdf": (422, "The PDF is password protected."),
    "bad_context": (422, "The import options could not be read."),
    "unreadable": (422, "The file could not be read as a statement."),
    "bad_request": (422, "The request could not be read."),
    "request_too_large": (413, "The request is larger than the limit allows."),
    "busy": (
        503,
        "Too many files are being read right now. Try again in a moment.",
    ),
    "rule_not_found": (404, "Rule not found."),
    "not_smart_import": (404, "This is not a smart import."),
    "category_not_found": (404, "Category not found."),
    "liability_not_found": (404, "Debt not found."),
    "expense_not_found": (404, "Expense not found."),
    "server_error": (500, "Something went wrong."),
    "save_failed": (500, "The change could not be saved."),
    "ai_unavailable": (503, "AI suggestions are not available."),
    "ai_not_enabled": (403, "AI suggestions are not enabled in settings."),
    "ai_bad_response": (502, "The AI service returned an unusable response."),
    "ai_provider_error": (502, "The AI service could not complete the request."),
    "ai_timeout": (504, "The AI service took too long to respond."),
}


class SmartImportError(Exception):
    """Raised by the smart import core; carries a status and a fixed message.

    ``str(exc)`` is the fixed detail, so even a blind ``logger.exception`` or
    ``str(exc)`` in a handler cannot leak statement content.
    """

    def __init__(
        self, error_type: str, status: int | None = None, detail: str | None = None
    ):
        default_status, default_detail = ERROR_CATALOG.get(
            error_type, (422, "The statement could not be imported.")
        )
        self.error_type = error_type
        self.status = default_status if status is None else status
        self.detail = default_detail if detail is None else detail
        super().__init__(self.detail)

    def body(self) -> dict[str, str]:
        """The only shape an HTTP error body may take."""
        return {"error_type": self.error_type, "detail": self.detail}
