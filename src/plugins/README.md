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
| `/api/analysis/plugins` | GET | Run all analysis plugins |
| `/api/analysis/plugins/{id}` | GET | Run specific analysis plugin |

---

## Creating an Analysis Plugin

Analysis plugins calculate metrics and provide insights about the portfolio.

### 1. Create Plugin Directory

```
src/plugins/builtin/my-analyzer/
├── plugin.yaml      # Plugin manifest
├── __init__.py      # Can be empty
└── analyzer.py      # Plugin implementation
```

### 2. Define the Manifest (plugin.yaml)

```yaml
name: My Analyzer
version: 1.0.0
description: Custom portfolio analysis
author: Your Name
license: MIT
plugin_type: analysis

main: analyzer.py
class: MyAnalyzer

requires:
  portfolio_analyzer: ">=1.0.0"
  python: ">=3.10"

dependencies: []

permissions:
  file_read: false
  file_write: false
  network: false
  database: read_only

settings:
  - key: threshold
    type: number
    label: Alert Threshold
    description: Minimum value to trigger alert
    default: 100
    required: false

metrics:
  - id: my_metric
    name: My Metric
    description: Description of what this metric measures
    type: currency  # currency, percentage, number, text
  - id: count_metric
    name: Count Metric
    description: Another metric
    type: number
```

### 3. Implement the Analyzer

```python
from typing import Any
from src.plugins.base import AnalysisPlugin, AnalysisResult, PluginManifest

class MyAnalyzer(AnalysisPlugin):
    """Custom portfolio analyzer."""

    def analyze(self, positions: list[dict], accounts: list[dict]) -> AnalysisResult:
        """
        Analyze portfolio data.

        Args:
            positions: List of position dictionaries with keys:
                - ticker: str
                - shares: float
                - current_price: float (may be None)
                - cost_basis: float (may be None)
                - is_fund: bool
                - account_id: int
                - account_name: str
                - account_type: str
            accounts: List of account dictionaries with keys:
                - id: int
                - name: str
                - account_type: str
                - brokerage: str
                - is_retirement: bool

        Returns:
            AnalysisResult with metrics and insights
        """
        try:
            # Get settings
            threshold = self.get_setting("threshold", 100)

            # Calculate metrics
            total_value = sum(
                pos.get("shares", 0) * (pos.get("current_price") or 0)
                for pos in positions
            )

            count = len([p for p in positions if p.get("current_price")])

            # Generate insights
            insights = []
            if total_value > threshold:
                insights.append(f"Portfolio value ${total_value:,.2f} exceeds threshold.")

            return AnalysisResult(
                success=True,
                metrics={
                    "my_metric": total_value,
                    "count_metric": count,
                    # Add any additional data for the UI
                    "details": [...],
                },
                insights=insights,
            )

        except Exception as e:
            return AnalysisResult(
                success=False,
                errors=[str(e)],
            )

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "analysis",
            "metrics": ["my_metric", "count_metric"],
        }
```

### 4. Built-in Analysis Plugins

The following analysis plugins are included:

**Tax-Loss Harvester** (`tax-loss-harvester`)
- Identifies positions with unrealized losses
- Calculates potential tax savings
- Warns about wash sale risks
- Metrics: `total_unrealized_losses`, `estimated_tax_savings`, `harvesting_opportunities`

**Dividend Tracker** (`dividend-tracker`)
- Calculates estimated annual dividend income
- Computes portfolio dividend yield
- Identifies top income-generating positions
- Metrics: `estimated_annual_income`, `portfolio_yield`, `dividend_positions`

### 5. Testing Analysis Plugins

```python
from src.plugins import get_plugin_registry, get_analysis_pipeline

# Initialize
registry = get_plugin_registry()
registry.discover_plugins(auto_enable_builtin=True)
registry.load_enabled_plugins()

pipeline = get_analysis_pipeline()

# Test with sample data
positions = [
    {"ticker": "AAPL", "shares": 100, "current_price": 190, "cost_basis": 22000},
    {"ticker": "VTI", "shares": 50, "current_price": 250, "cost_basis": 10000, "is_fund": True},
]
accounts = [
    {"id": 1, "name": "Taxable", "account_type": "taxable", "is_retirement": False},
]

# Run all plugins
result = pipeline.run_all(positions, accounts)
print(f"Success: {result.success}")
for pr in result.plugin_results:
    print(f"{pr.plugin_name}: {pr.result.metrics}")

# Run specific plugin
result = pipeline.run_plugin("tax-loss-harvester", positions, accounts)
print(f"Tax savings: ${result.metrics.get('estimated_tax_savings', 0):,.2f}")
```
