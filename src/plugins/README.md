# Plugin System

The Portfolio Analyzer uses a plugin system to support extensible functionality.
Plugins can add new data importers, analysis tools, dashboard widgets, and more.

## Plugin Types

| Type | Description | Base Class |
|------|-------------|------------|
| `importer` | Import positions from brokerage files | `ImporterPlugin` |
| `analysis` | Custom analysis and metrics | `AnalysisPlugin` |
| `widget` | Dashboard widgets | `WidgetPlugin` |
| `provider` | Data providers (prices, metadata) | `ProviderPlugin` |
| `export` | Export portfolio data | `ExportPlugin` |

## Directory Structure

```
src/plugins/
├── builtin/           # Built-in plugins (shipped with app)
│   ├── schwab-csv/
│   ├── fidelity-csv/
│   └── generic-csv/
├── installed/         # User-installed plugins
├── base.py           # Base classes
├── registry.py       # Plugin discovery and management
├── events.py         # Event bus for plugin communication
└── import_pipeline.py # Routes files to importer plugins
```

## Creating an Importer Plugin

Importer plugins parse brokerage export files and extract position data.

### 1. Create Plugin Directory

```
src/plugins/builtin/my-brokerage/
├── plugin.yaml      # Plugin manifest
├── __init__.py      # Can be empty
└── importer.py      # Plugin implementation
```

### 2. Define the Manifest (plugin.yaml)

```yaml
name: My Brokerage Importer
version: 1.0.0
description: Import positions from My Brokerage exports
author: Your Name
license: MIT
plugin_type: importer

main: importer.py
class: MyBrokerageImporter

requires:
  portfolio_analyzer: ">=1.0.0"
  python: ">=3.10"

dependencies:
  - pandas>=2.0.0

permissions:
  file_read: true
  file_write: false
  network: false
  database: read_only

supported_formats:
  - extension: .csv
    mime_type: text/csv
    description: My Brokerage Position Export
```

### 3. Implement the Importer

```python
from pathlib import Path
from typing import Optional
from src.plugins.base import ImporterPlugin, ImportResult, PluginManifest

class MyBrokerageImporter(ImporterPlugin):
    """Importer for My Brokerage CSV exports."""

    def can_handle(self, file_path: Path, content_preview: bytes) -> float:
        """
        Return confidence score (0.0-1.0) for handling this file.

        Higher scores indicate stronger match. The importer with
        the highest score above 0.5 threshold will be used.

        Args:
            file_path: Path to the file
            content_preview: First 8KB of file contents

        Returns:
            Confidence score:
            - 0.9-1.0: Very high confidence (brokerage-specific format detected)
            - 0.6-0.8: Moderate confidence (some indicators found)
            - 0.4-0.5: Low confidence (generic match)
            - 0.0: Cannot handle this file
        """
        if file_path.suffix.lower() != ".csv":
            return 0.0

        preview_text = content_preview.decode("utf-8", errors="ignore")

        # Check for brokerage-specific indicators
        if "MyBrokerage" in preview_text:
            return 0.95
        if "my-brokerage-specific-column" in preview_text.lower():
            return 0.8

        return 0.0

    def import_file(self, file_path: Path, account_type: str) -> ImportResult:
        """
        Import positions from the file.

        Args:
            file_path: Path to the file to import
            account_type: Account type (e.g., "roth_ira", "taxable")

        Returns:
            ImportResult with positions and status
        """
        try:
            # Load and parse the file
            positions = []

            # ... your parsing logic here ...

            # Each position is a dict with these fields:
            # - ticker: str (required)
            # - shares: float (required)
            # - name: str (optional, defaults to ticker)
            # - price: float (optional)
            # - cost_basis: float (optional)
            # - is_fund: bool (optional, defaults to False)

            positions.append({
                "ticker": "AAPL",
                "shares": 100.0,
                "name": "Apple Inc",
                "price": 190.50,
                "cost_basis": 15000.00,
                "is_fund": False,
            })

            return ImportResult(
                success=True,
                positions=positions,
                account_name="My Brokerage Account",
                message=f"Imported {len(positions)} positions",
            )

        except Exception as e:
            return ImportResult(
                success=False,
                message=f"Import failed: {str(e)}",
                errors=[str(e)],
            )

    def get_info(self) -> dict:
        """Return plugin information."""
        return {
            "name": self.name,
            "version": self.version,
            "type": "importer",
            "formats": [".csv"],
            "brokerage": "my_brokerage",
        }
```

## Confidence Scoring Strategy

The import pipeline uses confidence scores to select the best importer:

| Score | Meaning | Example |
|-------|---------|---------|
| 0.95+ | Definitive match | Schwab: `"Positions for account"` header |
| 0.8-0.9 | Strong indicators | Fidelity: column names + "fidelity" text |
| 0.5-0.7 | Moderate match | Generic column patterns |
| < 0.5 | Weak match | Falls back to legacy import |

Brokerage-specific importers should return high confidence (0.8+) when
they detect their specific format. This ensures they take precedence
over the generic importer.

## Testing Your Plugin

```python
from pathlib import Path
from src.plugins import get_plugin_registry, get_import_pipeline

# Initialize plugins
registry = get_plugin_registry()
registry.discover_plugins(auto_enable_builtin=True)
registry.load_enabled_plugins()

# Test file detection
pipeline = get_import_pipeline()
match = pipeline.find_best_importer(Path("test_file.csv"))
print(f"Best importer: {match.plugin.name} ({match.confidence:.0%})")

# Test import
result = pipeline.import_file(Path("test_file.csv"), "taxable")
print(f"Imported {len(result.positions)} positions")
```

## Event Bus

Plugins can subscribe to and publish events:

```python
from src.plugins.events import get_event_bus, EventType, Event

bus = get_event_bus()

# Subscribe to events
def on_prices_updated(event):
    print(f"Prices updated: {event.data}")

bus.subscribe(EventType.PRICES_UPDATED, on_prices_updated)

# Publish events
bus.publish(Event(
    EventType.DATA_IMPORTED,
    data={"positions": 10, "account": "Roth IRA"},
    source="my-plugin",
))
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugins` | GET | List all plugins |
| `/api/plugins/{id}` | GET | Get plugin details |
| `/api/plugins/{id}/enable` | POST | Enable plugin |
| `/api/plugins/{id}/disable` | POST | Disable plugin |
| `/api/plugins/{id}/settings` | GET/PUT | Plugin settings |
| `/api/plugins/discover` | POST | Scan for new plugins |
