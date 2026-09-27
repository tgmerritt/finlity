# Skills for Finlity

This document describes special capabilities and modes for Claude Code when working with this project.

## Demo Mode

Demo mode allows you to demonstrate the application using fake portfolio data without exposing real financial information.

### Generating Demo Data

To generate a demo portfolio with ~50 realistic positions:

```bash
python scripts/generate_demo.py
```

This creates:
- 6 demo accounts (401k, IRA, Roth IRA, Taxable, HSA, 529)
- ~50 diversified positions with real current prices
- CDs with APY and maturity dates
- Cash positions with interest rates

### Enabling Demo Mode

**Via CLI (one-time session):**
```bash
python -m src.main --demo
```

**Via Settings UI (persistent):**
1. Navigate to Settings page
2. Toggle "Demo Mode" switch
3. Reload page when prompted

**Via config.yaml (persistent):**
```yaml
demo:
  enabled: true
```

### When to Use Demo Mode

Claude should suggest demo mode when:
- User wants to demonstrate the application
- User is testing new features without affecting real data
- User wants to share screenshots without exposing finances
- User is training others on the application

## CD/Cash APY Interest Tracking

Positions can have APY (Annual Percentage Yield) tracking with automatic interest accrual calculations.

### Adding APY to Positions

**For Cash positions:**
- Use the "Add Position" modal with type "Cash"
- Enter the optional APY percentage (e.g., 4.5 for 4.5%)

**For CDs:**
- CDs automatically require APY and maturity date
- Interest accrues from purchase date using simple interest

### Interest Calculation

The system uses simple interest formula:
```
Accrued Value = Principal × (1 + APY × Years_Held)
```

Example: $10,000 at 5% APY for 6 months = $10,000 × (1 + 0.05 × 0.5) = $10,250

### Visual Indicators

- Positions with APY show a 📈 icon in the holdings table
- Hover shows the APY rate
- The displayed value includes accrued interest

## Common Development Tasks

### Refresh All Prices
```bash
# Via API
curl -X POST http://localhost:8000/api/imports/refresh-prices?force=true
```

### Check CD Maturities
```bash
python -m src.main --check-cds
```

### Export/Import Database
```bash
# Export
python -m src.main --export-db backup.json

# Import
python -m src.main --import-db backup.json
```

### Reset Database
```bash
python -m src.main --reset-database
```
