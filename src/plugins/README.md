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

---

## Creating a Widget Plugin

Widget plugins create visual dashboard components that display portfolio data.

### 1. Create Plugin Directory

```
src/plugins/builtin/my-widget/
├── plugin.yaml      # Plugin manifest
├── __init__.py      # Can be empty
└── widget.py        # Plugin implementation
```

### 2. Define the Manifest (plugin.yaml)

```yaml
name: My Widget
version: 1.0.0
description: Custom dashboard widget
author: Your Name
license: MIT
plugin_type: widget

main: widget.py
class: MyWidget

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
  - key: show_details
    type: boolean
    label: Show Details
    description: Show detailed information
    default: true
    required: false

widget:
  title: My Widget Title
  default_width: 2   # Grid columns (1-3)
  default_height: 2  # Height class (1-3)
  refresh_interval: 3600  # Auto-refresh interval in seconds (0 = no refresh)
```

### 3. Implement the Widget

```python
from typing import Any
from src.plugins.base import WidgetPlugin, WidgetContent, PluginManifest

class MyWidget(WidgetPlugin):
    """Custom dashboard widget."""

    def render(self, positions: list[dict], accounts: list[dict]) -> WidgetContent:
        """
        Render widget content.

        Args:
            positions: List of position dictionaries with keys:
                - ticker: str
                - shares: float
                - current_price: float (may be None)
                - cost_basis: float (may be None)
                - sector: str
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
            WidgetContent with HTML for display
        """
        show_details = self.get_setting("show_details", True)

        # Calculate metrics
        total_value = sum(
            (pos.get("current_price") or 0) * (pos.get("shares") or 0)
            for pos in positions
        )

        # Generate HTML
        html = f'''
        <div class="my-widget">
            <div class="widget-stat">
                <span class="label">Total Value</span>
                <span class="value">${total_value:,.2f}</span>
            </div>
            <div class="widget-stat">
                <span class="label">Positions</span>
                <span class="value">{len(positions)}</span>
            </div>
        </div>
        '''

        return WidgetContent(
            html=html,
            data={
                "total_value": total_value,
                "position_count": len(positions),
            },
        )

    def get_info(self) -> dict:
        config = self.get_config()
        return {
            "name": self.name,
            "version": self.version,
            "type": "widget",
            "title": config.title if config else self.name,
        }
```

### 4. Built-in Widget Plugins

The following widget plugins are included:

**Correlation Heatmap** (`correlation-heatmap`)
- Shows correlation matrix between portfolio holdings
- Uses asset class and sector correlations
- Displays diversification quality rating
- Settings: `min_positions`, `show_values`

**Sector Treemap** (`sector-treemap`)
- Interactive visualization of sector allocation
- Shows top positions per sector
- Color-coded by sector
- Settings: `min_percent`, `show_tickers`

### 5. Testing Widget Plugins

```python
from src.plugins import get_plugin_registry, get_widget_pipeline

# Initialize
registry = get_plugin_registry()
registry.discover_plugins(auto_enable_builtin=True)
registry.load_enabled_plugins()

pipeline = get_widget_pipeline()

# Test with sample data
positions = [
    {"ticker": "AAPL", "shares": 100, "current_price": 190, "sector": "Technology"},
    {"ticker": "VTI", "shares": 50, "current_price": 250, "sector": "Diversified", "is_fund": True},
    {"ticker": "BND", "shares": 100, "current_price": 75, "sector": "Bonds", "is_fund": True},
]
accounts = [
    {"id": 1, "name": "Taxable", "account_type": "taxable", "is_retirement": False},
]

# Render all widgets
result = pipeline.render_all(positions, accounts)
print(f"Rendered {len(result.widgets)} widgets")
for w in result.widgets:
    print(f"  {w.plugin_name}: {'OK' if w.success else w.error}")

# Render specific widget
result = pipeline.render_widget("correlation-heatmap", positions, accounts)
if result and result.success:
    print(f"Correlation data: {result.content.data}")
```

### 6. Widget API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analysis/widgets` | GET | Render all widgets with DB data |
| `/api/analysis/widgets/{id}` | GET | Render specific widget with DB data |
| `/api/plugins/widgets` | GET | List available widget plugins |
| `/api/plugins/widgets/render` | POST | Render all widgets with custom data |
| `/api/plugins/widgets/render/{id}` | POST | Render specific widget with custom data |

### 7. Widget Styling

Widgets should use the app's CSS variables for consistent theming:

```css
.my-widget {
    /* Use app colors */
    color: var(--color-text-primary);
    background: var(--color-bg-container);
    border: 1px solid var(--color-border-secondary);
    border-radius: var(--border-radius);
}

.my-widget .label {
    color: var(--color-text-muted);
}

.my-widget .value {
    color: var(--color-text-primary);
}

/* Success/danger colors */
.my-widget .positive { color: var(--color-success); }
.my-widget .negative { color: var(--color-danger); }
```

---

## Security & Sandboxing

The plugin system includes comprehensive security features to protect your data.

### Permission System

Plugins declare the permissions they need in their manifest:

| Permission | Description | Sensitivity |
|------------|-------------|-------------|
| `file_read` | Read files from import directories | Low |
| `file_write` | Write files to export directories | High |
| `network` | Make HTTP requests | High |
| `database` | Access the database (none/read_only/read_write) | Varies |
| `api_keys` | Access to specific API keys | High |

### Built-in vs Third-Party Plugins

- **Built-in plugins** are automatically trusted and loaded
- **Third-party plugins** with sensitive permissions require user approval
- Sensitive permissions: `file_write`, `network`, `api_keys`, `database:read_write`

### Permission Approval

Third-party plugins with sensitive permissions must be approved before loading:

1. Go to Settings → Plugin Security
2. Review pending plugin permissions
3. Click "Approve" to grant permissions or "Deny" to block
4. Approved plugins are enabled and loaded

You can revoke permissions at any time, which disables the plugin.

### Sandboxed Execution

Plugin code runs with security controls:

1. **Execution Timeout** - Plugins are limited to 30 seconds per operation
2. **Restricted Builtins** - Dangerous functions like `eval`, `exec`, `open` are blocked
3. **Permission Checking** - Operations are validated against approved permissions

### Audit Logging

All security-relevant events are logged:

- Plugin load/unload events
- Permission requests, approvals, and denials
- Execution timeouts and errors
- Security violations

View the audit log in Settings → Plugin Security.

### Security API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugins/security/permissions` | GET | List all plugin permissions |
| `/api/plugins/security/permissions/{id}` | GET | Get plugin permission details |
| `/api/plugins/security/permissions/{id}/approve` | POST | Approve/deny permissions |
| `/api/plugins/security/permissions/{id}/revoke` | POST | Revoke permissions |
| `/api/plugins/security/pending` | GET | Get plugins needing approval |
| `/api/plugins/security/audit` | GET | Get security audit log |
| `/api/plugins/security/violations` | GET | Get security violations |
| `/api/plugins/security/validate/{id}` | GET | Validate plugin security |

### Best Practices for Plugin Authors

1. **Request minimal permissions** - Only request what you need
2. **Avoid sensitive permissions** when possible
3. **Document permission usage** - Explain why each permission is needed
4. **Handle errors gracefully** - Don't crash on permission denials
5. **Respect timeout limits** - Keep operations fast

```yaml
# Good: Minimal permissions
permissions:
  file_read: true
  file_write: false
  network: false
  database: read_only

# Avoid: Over-requesting
permissions:
  file_read: true
  file_write: true
  network: true
  database: read_write
```
