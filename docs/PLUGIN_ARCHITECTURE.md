# Plugin Architecture & Multi-Database Support

This document outlines the architecture for extending the Portfolio Analyzer with a plugin system and multi-database support for serving multiple clients/families.

## Table of Contents

1. [Overview](#overview)
2. [Phase 1: Multi-Database Support](#phase-1-multi-database-support)
3. [Phase 2: Plugin Infrastructure](#phase-2-plugin-infrastructure)
4. [Phase 3: Importer Plugins](#phase-3-importer-plugins)
5. [Phase 4: Analysis Plugins](#phase-4-analysis-plugins)
6. [Phase 5: Widget Plugins](#phase-5-widget-plugins)
7. [Phase 6: Security & Sandboxing](#phase-6-security--sandboxing)
8. [Phase 7: Distribution & Marketplace](#phase-7-distribution--marketplace)

---

## Overview

### Goals

1. **Multi-tenancy** - Financial advisors can manage multiple client portfolios with complete data isolation
2. **Extensibility** - Community can contribute importers, analysis tools, and visualizations
3. **Security** - Protect sensitive financial data with sandboxed plugin execution
4. **Simplicity** - Easy to install, configure, and develop plugins

### Non-Goals

- Cloud hosting (this remains a local-first application)
- Real-time collaboration (single-user sessions)
- Plugin monetization (open source focus)

---

## Phase 1: Multi-Database Support

**Priority: HIGH** - Foundation for multi-client usage

### Use Cases

1. **Financial Advisor** - Manages portfolios for multiple clients
2. **Family Office** - Tracks investments for different family members
3. **Individual** - Separates personal vs business investments
4. **Demo/Testing** - Switch between demo and real data

### Data Model

```
data/
├── databases/
│   ├── profiles.json          # List of all database profiles
│   ├── default/
│   │   ├── portfolio.db       # SQLite database
│   │   ├── funds.yaml         # Fund metadata cache
│   │   └── imports/           # Import folders
│   ├── client-smith/
│   │   ├── portfolio.db
│   │   ├── funds.yaml
│   │   └── imports/
│   └── client-jones/
│       ├── portfolio.db
│       ├── funds.yaml
│       └── imports/
```

### Profile Schema (profiles.json)

```json
{
    "profiles": [
        {
            "id": "default",
            "name": "My Portfolio",
            "description": "Personal investments",
            "created_at": "2024-01-15T10:30:00Z",
            "last_accessed": "2024-12-31T08:00:00Z",
            "icon": "user",
            "color": "#4A90D9"
        },
        {
            "id": "client-smith",
            "name": "Smith Family Trust",
            "description": "Retirement and college savings",
            "created_at": "2024-06-01T14:00:00Z",
            "last_accessed": "2024-12-30T16:45:00Z",
            "icon": "briefcase",
            "color": "#2ECC71"
        }
    ],
    "active_profile": "default"
}
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/profiles | List all profiles |
| POST | /api/profiles | Create new profile |
| GET | /api/profiles/{id} | Get profile details |
| PUT | /api/profiles/{id} | Update profile metadata |
| DELETE | /api/profiles/{id} | Delete profile (with confirmation) |
| POST | /api/profiles/{id}/activate | Switch active profile |
| POST | /api/profiles/{id}/export | Export profile as ZIP |
| POST | /api/profiles/import | Import profile from ZIP |
| POST | /api/profiles/{id}/duplicate | Clone a profile |

### UI Components

1. **Profile Switcher** (header dropdown)
   - Shows current profile name with icon/color
   - Quick switch between recent profiles
   - "Manage Profiles" link

2. **Profile Management Page** (Settings tab)
   - Create new profile
   - Edit profile name/description/color
   - Delete profile (requires typing name)
   - Export/import profiles
   - Storage usage per profile

3. **Visual Indicators**
   - Profile color accent in header
   - Profile name always visible
   - Confirmation when switching profiles

### Migration Path

For existing users:
1. On first run with new version, detect existing `data/portfolio.db`
2. Create `data/databases/default/` directory
3. Move existing files into default profile
4. Create `profiles.json` with default profile entry

---

## Phase 2: Plugin Infrastructure

**Priority: HIGH** - Foundation for all plugins

### Directory Structure

```
plugins/
├── __init__.py
├── registry.py              # Plugin discovery and loading
├── base.py                  # Base classes for plugins
├── security.py              # Sandboxing and permissions
├── installed/               # Installed plugin packages
│   ├── example-importer/
│   │   ├── plugin.yaml      # Manifest
│   │   ├── __init__.py
│   │   └── importer.py
│   └── tax-analyzer/
│       ├── plugin.yaml
│       ├── __init__.py
│       ├── analyzer.py
│       └── web/
│           └── widget.js
└── enabled.json             # List of enabled plugins
```

### Plugin Manifest (plugin.yaml)

```yaml
# Required fields
name: vanguard-importer
version: 1.0.0
description: Import Vanguard CSV and OFX files
author: Community Contributor
license: MIT
plugin_type: importer  # importer, analysis, widget, provider, export

# Entry point
main: importer.py
class: VanguardImporter

# Dependencies
requires:
  portfolio_analyzer: ">=1.0.0"
  python: ">=3.10"
dependencies:
  - pandas>=2.0.0
  - openpyxl>=3.0.0

# Permissions required
permissions:
  file_read: true
  file_write: false
  network: false
  database: read_only  # none, read_only, read_write
  api_keys: []

# Configuration schema
settings:
  - key: date_format
    type: select
    label: Date Format
    options: ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"]
    default: "MM/DD/YYYY"

# For importer plugins
supported_formats:
  - extension: .csv
    mime_type: text/csv
    description: Vanguard CSV Export

# For analysis plugins
metrics:
  - id: tax_loss_opportunities
    name: Tax Loss Opportunities
    description: Positions eligible for tax-loss harvesting
    type: currency

# For widget plugins
widget:
  title: Tax Loss Harvesting
  default_width: 2
  default_height: 2
  refresh_interval: 3600
```

### Plugin Types

| Type | Purpose | Examples |
|------|---------|----------|
| **importer** | Parse brokerage files | Vanguard CSV, Fidelity PDF, Robinhood API |
| **analysis** | Calculate metrics | Tax-loss harvesting, Sector rotation |
| **widget** | Dashboard components | Correlation heatmap, Dividend calendar |
| **provider** | External data sources | Alpha Vantage, Polygon.io |
| **export** | Generate reports | PDF reports, Google Sheets sync |

### Event Bus

Plugins can subscribe to system events:

- `app_started` / `app_shutdown`
- `profile_activated` / `profile_created`
- `position_added` / `position_updated` / `position_deleted`
- `account_created` / `account_deleted`
- `prices_updated`
- `import_completed`
- `analysis_requested`
- `export_requested`

---

## Phase 3: Importer Plugins

**Priority: HIGH** - Most requested feature

### Built-in Importers to Extract

Current importers in `src/importers/folder_scanner.py` should be refactored:

1. **Generic CSV** (built-in, always available)
2. **Schwab CSV** - Extract to plugin
3. **Fidelity CSV** - Extract to plugin
4. **Vanguard CSV** - Extract to plugin

### Importer Interface

```python
class ImporterPlugin(PluginBase):
    """Base class for data import plugins."""

    def can_handle(self, file_path: str, content_preview: bytes) -> float:
        """Return confidence score (0.0-1.0) for handling this file."""
        pass

    def import_file(self, file_path: str, account_type: str) -> ImportResult:
        """Import positions from file. Returns ImportResult."""
        pass

    def get_supported_formats(self) -> list[FileFormat]:
        """Return list of supported file formats."""
        pass
```

### Import Pipeline

When a file is dropped:
1. Read first 8KB as preview
2. Ask each importer for confidence score
3. Use highest confidence importer
4. Return results with source attribution

---

## Phase 4: Analysis Plugins

### Analysis Interface

```python
class AnalysisPlugin(PluginBase):
    """Base class for analysis plugins."""

    def analyze(self, portfolio: Portfolio) -> AnalysisResult:
        """Run analysis on the portfolio."""
        pass

    def get_metrics(self) -> list[MetricDefinition]:
        """Define metrics this plugin provides."""
        pass

    def get_api_endpoints(self) -> list[APIEndpoint]:
        """Define additional API endpoints."""
        pass
```

### Example Plugins

1. **Tax-Loss Harvester**
   - Find positions with unrealized losses
   - Check wash sale risk
   - Estimate tax savings

2. **Dividend Tracker**
   - Track dividend income by month
   - Upcoming ex-dividend dates
   - Yield calculations

3. **Rebalancing Assistant**
   - Compare to target allocations
   - Generate trade suggestions
   - Account for tax implications

---

## Phase 5: Widget Plugins

### Widget Interface

```python
class WidgetPlugin(PluginBase):
    """Base class for dashboard widgets."""

    def get_data(self) -> dict:
        """Return data for widget rendering."""
        pass

    def get_html(self) -> str:
        """Return HTML template."""
        pass

    def get_javascript(self) -> str:
        """Return JavaScript for interactivity."""
        pass

    def get_api_endpoints(self) -> list[APIEndpoint]:
        """Define API endpoints for the widget."""
        pass
```

### Widget Grid System

- Dashboard uses CSS Grid
- Widgets specify min width/height in grid units
- Users can drag-and-drop to arrange
- Layout persisted per profile

---

## Phase 6: Security & Sandboxing

### Permission System

| Permission | Description |
|------------|-------------|
| file_read | Read files from import directories |
| file_write | Write files to export directories |
| network | Make HTTP requests |
| database | none / read_only / read_write |
| api_keys | Access to specific API keys |

### Security Measures

1. **Sandboxed Execution** - Restricted builtins, no eval/exec
2. **Resource Limits** - CPU time (30s), Memory (256MB)
3. **Permission Prompts** - User approval for sensitive permissions
4. **Audit Logging** - Track all plugin actions
5. **Code Review** - Optional verification for trusted publishers

---

## Phase 7: Distribution & Marketplace

### Installation Methods

1. **Local** - Copy folder to `plugins/installed/`
2. **Git** - `portfolio plugins install github:user/repo`
3. **ZIP** - Upload via Settings UI

### Plugin Repository

Community-maintained index with:
- Plugin metadata and descriptions
- Download counts and ratings
- Verification status
- Version history

---

## Implementation Checklist

### Phase 1: Multi-Database Support
- [ ] Create ProfileManager class
- [ ] Design profiles.json schema
- [ ] Implement profile CRUD operations
- [ ] Add profile API endpoints
- [ ] Create profile switcher UI component
- [ ] Add profile management page in Settings
- [ ] Implement export/import functionality
- [ ] Migration script for existing users
- [ ] Update all database operations to use active profile

### Phase 2: Plugin Infrastructure
- [ ] Create plugins directory structure
- [ ] Implement PluginBase class
- [ ] Implement PluginRegistry
- [ ] Create plugin.yaml parser
- [ ] Implement EventBus
- [ ] Add plugin API endpoints
- [ ] Create plugin management UI
- [ ] Implement plugin settings storage

### Phase 3: Importer Plugins
- [ ] Define ImporterPlugin interface
- [ ] Create ImportPipeline
- [ ] Extract existing importers to plugins
- [ ] Create example importer plugin
- [ ] Update import UI to show plugin source
- [ ] Document importer plugin development

### Phase 4: Analysis Plugins
- [ ] Define AnalysisPlugin interface
- [ ] Create analysis pipeline integration
- [ ] Implement dynamic metric registration
- [ ] Create example analysis plugin
- [ ] Add plugin metrics to Analysis page
- [ ] Document analysis plugin development

### Phase 5: Widget Plugins
- [ ] Define WidgetPlugin interface
- [ ] Create widget loader JavaScript
- [ ] Implement widget grid system
- [ ] Create example widget plugin
- [ ] Add widget configuration UI
- [ ] Document widget plugin development

### Phase 6: Security & Sandboxing
- [ ] Implement permission system
- [ ] Create sandboxed execution environment
- [ ] Add permission approval UI
- [ ] Implement audit logging
- [ ] Security review and testing

### Phase 7: Distribution
- [ ] Implement git-based installation
- [ ] Create plugin repository index
- [ ] Add plugin browser UI
- [ ] Implement update checking
- [ ] Document publishing process

---

## Example Plugins to Build

| Priority | Plugin | Type | Description |
|----------|--------|------|-------------|
| High | Vanguard Importer | importer | Import Vanguard CSV/OFX files |
| High | Fidelity Importer | importer | Import Fidelity exports |
| High | Dividend Tracker | analysis+widget | Track dividend income |
| Medium | Tax-Loss Harvester | analysis | Find tax-loss opportunities |
| Medium | Rebalancing Assistant | analysis+widget | Generate rebalancing trades |
| Medium | Correlation Heatmap | widget | Visualize correlations |
| Medium | Sector Treemap | widget | Interactive sector allocation |
| Low | Crypto Support | importer+provider | Coinbase/Kraken imports |
| Low | Options Tracker | analysis | Track covered calls, puts |
| Low | Social Sentiment | analysis | Reddit/Twitter sentiment |
