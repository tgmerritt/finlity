"""
Analysis pipeline that runs analysis plugins on portfolio data.

This module provides the integration layer between the analysis system
and analysis plugins. It handles:
- Running analysis plugins on portfolio data
- Aggregating results from multiple plugins
- Providing a unified interface for analysis metrics
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from .base import AnalysisPlugin, AnalysisResult, PluginMetric
from .registry import get_plugin_registry

logger = logging.getLogger(__name__)


@dataclass
class PluginAnalysisResult:
    """Result from a single analysis plugin."""
    plugin_id: str
    plugin_name: str
    result: AnalysisResult


@dataclass
class AggregatedAnalysisResult:
    """Aggregated results from all analysis plugins."""
    success: bool
    plugin_results: list[PluginAnalysisResult] = field(default_factory=list)
    all_metrics: dict[str, Any] = field(default_factory=dict)
    all_insights: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class AnalysisPipeline:
    """
    Runs analysis plugins on portfolio data.

    Provides methods to run all plugins or specific plugins,
    and aggregates results into a unified format.
    """

    def __init__(self):
        self._registry = None

    def _get_registry(self):
        """Get the plugin registry (lazy initialization)."""
        if self._registry is None:
            self._registry = get_plugin_registry()
        return self._registry

    def get_analyzers(self) -> list[AnalysisPlugin]:
        """Get all enabled analysis plugins."""
        registry = self._get_registry()
        return registry.get_analyzers()

    def get_available_metrics(self) -> list[dict]:
        """
        Get all metrics available from analysis plugins.

        Returns:
            List of metric definitions with plugin info
        """
        metrics = []
        for analyzer in self.get_analyzers():
            plugin_metrics = analyzer.get_metrics()
            for metric in plugin_metrics:
                metrics.append({
                    "id": f"{analyzer.manifest.plugin_id}.{metric.id}",
                    "name": metric.name,
                    "description": metric.description,
                    "type": metric.type,
                    "plugin_id": analyzer.manifest.plugin_id,
                    "plugin_name": analyzer.name,
                })
        return metrics

    def run_all(
        self,
        positions: list[dict],
        accounts: list[dict],
    ) -> AggregatedAnalysisResult:
        """
        Run all analysis plugins on portfolio data.

        Args:
            positions: List of position dictionaries
            accounts: List of account dictionaries

        Returns:
            Aggregated results from all plugins
        """
        analyzers = self.get_analyzers()
        if not analyzers:
            logger.debug("No analysis plugins available")
            return AggregatedAnalysisResult(success=True)

        plugin_results = []
        all_metrics = {}
        all_insights = []
        errors = []

        for analyzer in analyzers:
            try:
                logger.info(f"Running analysis plugin: {analyzer.name}")
                result = analyzer.analyze(positions, accounts)
                result.source_plugin = analyzer.manifest.plugin_id

                plugin_results.append(PluginAnalysisResult(
                    plugin_id=analyzer.manifest.plugin_id,
                    plugin_name=analyzer.name,
                    result=result,
                ))

                # Aggregate metrics with plugin prefix
                for metric_id, value in result.metrics.items():
                    full_id = f"{analyzer.manifest.plugin_id}.{metric_id}"
                    all_metrics[full_id] = {
                        "value": value,
                        "plugin_id": analyzer.manifest.plugin_id,
                        "plugin_name": analyzer.name,
                    }

                # Aggregate insights with source info
                for insight in result.insights:
                    all_insights.append({
                        "text": insight,
                        "plugin_id": analyzer.manifest.plugin_id,
                        "plugin_name": analyzer.name,
                    })

                if result.errors:
                    for error in result.errors:
                        errors.append(f"{analyzer.name}: {error}")

            except Exception as e:
                logger.exception(f"Error running analysis plugin {analyzer.name}: {e}")
                errors.append(f"{analyzer.name}: {str(e)}")

        return AggregatedAnalysisResult(
            success=len(errors) == 0,
            plugin_results=plugin_results,
            all_metrics=all_metrics,
            all_insights=all_insights,
            errors=errors,
        )

    def run_plugin(
        self,
        plugin_id: str,
        positions: list[dict],
        accounts: list[dict],
    ) -> Optional[AnalysisResult]:
        """
        Run a specific analysis plugin.

        Args:
            plugin_id: ID of the plugin to run
            positions: List of position dictionaries
            accounts: List of account dictionaries

        Returns:
            AnalysisResult from the plugin, or None if not found
        """
        registry = self._get_registry()
        plugin = registry.get_plugin(plugin_id)

        if not plugin or not isinstance(plugin, AnalysisPlugin):
            logger.error(f"Analysis plugin not found: {plugin_id}")
            return None

        try:
            result = plugin.analyze(positions, accounts)
            result.source_plugin = plugin_id
            return result

        except Exception as e:
            logger.exception(f"Error running analysis plugin {plugin_id}: {e}")
            return AnalysisResult(
                success=False,
                errors=[str(e)],
                source_plugin=plugin_id,
            )


# Global pipeline instance
_pipeline: Optional[AnalysisPipeline] = None


def get_analysis_pipeline() -> AnalysisPipeline:
    """Get the global analysis pipeline instance."""
    global _pipeline
    if _pipeline is None:
        _pipeline = AnalysisPipeline()
    return _pipeline
