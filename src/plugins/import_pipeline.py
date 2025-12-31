"""
Import pipeline that routes files to appropriate importer plugins.

This module provides the integration layer between the file import system
and importer plugins. It handles:
- Reading file previews
- Asking each importer for confidence scores
- Selecting the best importer
- Executing the import and returning results
"""

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .base import ImporterPlugin, ImportResult
from .registry import get_plugin_registry

logger = logging.getLogger(__name__)

# Preview size for format detection (8KB)
PREVIEW_SIZE = 8192


@dataclass
class ImporterMatch:
    """A potential importer match with confidence score."""
    plugin: ImporterPlugin
    plugin_id: str
    confidence: float


class ImportPipeline:
    """
    Routes files to the appropriate importer plugin.

    Uses confidence scoring to select the best importer for each file.
    Falls back to generic CSV if no plugin claims high confidence.
    """

    def __init__(self, min_confidence: float = 0.5):
        """
        Initialize the import pipeline.

        Args:
            min_confidence: Minimum confidence score to use a plugin (0.0-1.0)
        """
        self.min_confidence = min_confidence

    def get_importers(self) -> list[ImporterPlugin]:
        """Get all enabled importer plugins."""
        registry = get_plugin_registry()
        return registry.get_importers()

    def find_best_importer(
        self,
        file_path: Path,
        content_preview: Optional[bytes] = None,
    ) -> Optional[ImporterMatch]:
        """
        Find the best importer plugin for a file.

        Args:
            file_path: Path to the file
            content_preview: Optional preview of file contents

        Returns:
            ImporterMatch with the best plugin, or None if no match
        """
        if content_preview is None:
            content_preview = self._read_preview(file_path)

        importers = self.get_importers()
        if not importers:
            logger.warning("No importer plugins available")
            return None

        # Get confidence scores from all importers
        matches: list[ImporterMatch] = []

        for importer in importers:
            try:
                confidence = importer.can_handle(file_path, content_preview)
                if confidence >= self.min_confidence:
                    matches.append(ImporterMatch(
                        plugin=importer,
                        plugin_id=importer.manifest.plugin_id,
                        confidence=confidence,
                    ))
                    logger.debug(
                        f"Importer '{importer.name}' confidence for "
                        f"{file_path.name}: {confidence:.2f}"
                    )
            except Exception as e:
                logger.error(
                    f"Error getting confidence from {importer.name}: {e}",
                    exc_info=True
                )

        if not matches:
            logger.debug(f"No importer matched {file_path.name} with sufficient confidence")
            return None

        # Sort by confidence (highest first)
        matches.sort(key=lambda m: -m.confidence)
        best = matches[0]

        logger.info(
            f"Selected importer '{best.plugin.name}' for {file_path.name} "
            f"(confidence: {best.confidence:.2f})"
        )

        return best

    def import_file(
        self,
        file_path: Path,
        account_type: str,
        importer: Optional[ImporterPlugin] = None,
    ) -> ImportResult:
        """
        Import a file using plugins.

        Args:
            file_path: Path to the file to import
            account_type: Type of account (e.g., "roth_ira")
            importer: Specific importer to use, or None to auto-detect

        Returns:
            ImportResult with positions and status
        """
        # Auto-detect importer if not specified
        if importer is None:
            content_preview = self._read_preview(file_path)
            match = self.find_best_importer(file_path, content_preview)

            if match is None:
                return ImportResult(
                    success=False,
                    message=f"No importer plugin could handle {file_path.name}",
                    errors=["No matching importer found"],
                    source_plugin="",
                )

            importer = match.plugin

        # Execute import
        try:
            result = importer.import_file(file_path, account_type)
            result.source_plugin = importer.manifest.plugin_id

            logger.info(
                f"Imported {len(result.positions)} positions from {file_path.name} "
                f"using '{importer.name}'"
            )

            return result

        except Exception as e:
            logger.exception(f"Error importing {file_path}: {e}")
            return ImportResult(
                success=False,
                message=f"Import failed: {str(e)}",
                errors=[str(e)],
                source_plugin=importer.manifest.plugin_id,
            )

    def get_importers_for_file(
        self,
        file_path: Path,
    ) -> list[ImporterMatch]:
        """
        Get all importers that can handle a file, sorted by confidence.

        Useful for showing users which importers are available.

        Args:
            file_path: Path to the file

        Returns:
            List of ImporterMatch sorted by confidence (highest first)
        """
        content_preview = self._read_preview(file_path)
        importers = self.get_importers()

        matches = []
        for importer in importers:
            try:
                confidence = importer.can_handle(file_path, content_preview)
                if confidence > 0:
                    matches.append(ImporterMatch(
                        plugin=importer,
                        plugin_id=importer.manifest.plugin_id,
                        confidence=confidence,
                    ))
            except Exception as e:
                logger.error(f"Error checking importer {importer.name}: {e}")

        matches.sort(key=lambda m: -m.confidence)
        return matches

    def _read_preview(self, file_path: Path) -> bytes:
        """Read the first PREVIEW_SIZE bytes of a file."""
        try:
            with open(file_path, "rb") as f:
                return f.read(PREVIEW_SIZE)
        except Exception as e:
            logger.error(f"Error reading preview of {file_path}: {e}")
            return b""


# Global pipeline instance
_pipeline: Optional[ImportPipeline] = None


def get_import_pipeline() -> ImportPipeline:
    """Get the global import pipeline instance."""
    global _pipeline
    if _pipeline is None:
        _pipeline = ImportPipeline()
    return _pipeline
