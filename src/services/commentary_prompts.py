"""Prompt templates for AI commentary generation.

Each template is designed for a specific element type and includes:
- Context about what the element shows
- Current data values
- Comparison data from web search (when available)
- Instructions for generating helpful, actionable commentary
"""

# System prompt used for all commentary generation
SYSTEM_PROMPT = """You are a knowledgeable financial advisor assistant helping an individual investor understand their portfolio data.

Your role:
- Explain financial metrics in simple, clear language (assume non-professional audience)
- Provide context by comparing to benchmarks and typical values
- Offer brief, actionable observations when appropriate
- Be encouraging but honest about potential concerns
- Use markdown for emphasis (**bold** for key points)

Guidelines:
- Keep responses to 2-4 sentences maximum
- Reference specific numbers from the data provided
- If comparison data is available, use it to provide percentile or benchmark context
- End with one practical observation or next step when relevant
- Never give specific investment advice or recommendations to buy/sell
"""


# Individual element prompt templates
# Placeholders use {variable_name} format
PROMPT_TEMPLATES = {
    # =========================================================================
    # DASHBOARD - Summary Stats
    # =========================================================================
    "total_value": """
The user is viewing their **Total Portfolio Value** tile showing: **${total_value:,.0f}**

User context:
- Age: {user_age} years old
- Retirement target age: {retirement_age}

{comparison_context}

Explain what this total value represents and provide context. If comparison data shows percentiles or averages for their age, reference it. Keep it brief and encouraging.
""",

    "gain_loss": """
The user is viewing their **Total Gain/Loss** tile showing: **${total_gain_loss:,.0f}** ({total_gain_loss_pct:+.1f}%)

This represents unrealized gains/losses across all positions.

{comparison_context}

Explain what this gain/loss means, whether it's unrealized (paper gains), and how it compares to market performance if comparison data is available.
""",

    "retirement_value": """
The user is viewing their **Retirement Accounts Value** tile showing: **${retirement_value:,.0f}**

User context:
- Age: {user_age} years old
- This is {retirement_pct:.0f}% of their total portfolio

{comparison_context}

Explain the significance of tax-advantaged retirement savings. If comparison data shows averages for their age, provide context on where they stand.
""",

    "taxable_value": """
The user is viewing their **Taxable Accounts Value** tile showing: **${taxable_value:,.0f}**

This represents investments outside of retirement accounts (subject to capital gains taxes).
- This is {taxable_pct:.0f}% of their total portfolio

{comparison_context}

Briefly explain the role of taxable accounts in a portfolio and any tax considerations.
""",

    # =========================================================================
    # DASHBOARD - Retirement Metrics
    # =========================================================================
    "monthly_retirement_income": """
The user is viewing their projected **Monthly Retirement Income** tile showing: **${monthly_income:,.0f}/month**

This is based on the 4% safe withdrawal rule applied to their current portfolio.
- Total portfolio: ${total_value:,.0f}
- Annual withdrawal at 4%: ${annual_withdrawal:,.0f}

{comparison_context}

Explain the 4% rule briefly and whether this income level might support retirement. Reference comparison data if available.
""",

    "success_probability": """
The user is viewing their retirement **Success Probability** showing: **{success_rate:.0f}%**

This comes from a Monte Carlo simulation that runs thousands of scenarios based on:
- Historical market returns and volatility
- Their current savings and contribution rate
- Planned retirement age and withdrawal rate

{comparison_context}

Explain what this percentage means practically. Is 70% good? 90%? What affects this number?
""",

    "earliest_retirement_age": """
The user is viewing their **Earliest Retirement Age** estimate: **{earliest_age}**

This is the youngest age at which they could retire with an 80%+ success probability.
- Current age: {user_age}
- Years until earliest retirement: {years_to_earliest}

{comparison_context}

Provide context on what drives this estimate and how it compares to typical retirement ages.
""",

    "fire_number": """
The user is viewing their **FIRE Number**: **${fire_number:,.0f}**

FIRE = Financial Independence, Retire Early
This is the portfolio value needed to retire based on:
- Expected annual spending: ${annual_spending:,.0f}
- Using the 25x rule (4% withdrawal rate)

Current progress: {fire_progress:.0f}% of FIRE number achieved

{comparison_context}

Explain the FIRE concept briefly and their progress toward this goal.
""",

    # =========================================================================
    # DASHBOARD - Charts
    # =========================================================================
    "account_balances_table": """
The user is viewing a table of their **Account Balances** across {num_accounts} accounts.

Top accounts by value:
{account_summary}

{comparison_context}

Explain the benefit of having multiple account types and any notable observations about their account structure.
""",

    "allocation_chart": """
The user is viewing an **Asset Allocation** pie chart showing their top holdings by ticker:

{allocation_summary}

**Portfolio Statistics:**
- Total positions: {num_positions}
- Top 5 holdings: {top_5_pct:.1f}% of portfolio
- Top 10 holdings: {top_10_pct:.1f}% of portfolio

{comparison_context}

**Provide analysis covering:**

1. **Concentration Risk**: Evaluate whether any single position represents outsized risk. A common guideline suggests no single stock should exceed 5-10% of a portfolio, though index funds/ETFs can be larger.

2. **Diversification Quality**: Assess if the holdings provide true diversification or if they're clustered in similar sectors/asset classes. Holding multiple tech stocks, for example, doesn't provide the same diversification as spreading across sectors.

3. **Fund vs Individual Stocks**: If the portfolio contains broad index funds (VTI, VOO, VXUS, etc.), explain that these provide built-in diversification across hundreds or thousands of underlying holdings.

4. **Actionable Observations**: If concentration is high, suggest considering additional diversification. If well-diversified, acknowledge the balanced approach.

Provide a detailed response (1-2 paragraphs) commenting on their diversification level, any notable concentration risks, and practical observations about their asset allocation.
""",

    "account_type_chart": """
The user is viewing a chart showing portfolio breakdown by **Account Type**:

{account_type_summary}

**Current Allocation:**
- Tax-advantaged (retirement): {tax_advantaged_pct:.0f}%
- Taxable: {taxable_pct:.0f}%

**Breakdown by Tax Treatment:**
- Traditional (IRA/401k): {traditional_pct:.0f}% - Withdrawals taxed as ordinary income
- Roth (IRA/401k): {roth_pct:.0f}% - Withdrawals are tax-free
- Taxable: {taxable_pct:.0f}% - Only gains taxed (at capital gains rates)

{comparison_context}

**Provide detailed guidance covering these key points:**

1. **Income Limits & Contribution Restrictions**: In 2024, direct Roth IRA contributions phase out at $146k-$161k (single) or $230k-$240k (married filing jointly) MAGI. Traditional IRA deductions also phase out for those with workplace retirement plans. High earners who exceed these limits cannot contribute directly to Roth IRAs.

2. **Why High Earners Often Have Larger Taxable Allocations**: Once you exceed income limits for Roth contributions and max out 401k contributions ($23,000 in 2024, plus $7,500 catch-up if 50+), additional savings must go to taxable brokerage accounts. This is a normal outcome for high earners, not a planning failure. Backdoor Roth conversions can help but have limitations.

3. **Tax-Efficient Withdrawal Strategy**: In retirement, the optimal withdrawal sequence is typically:
   - First: Taxable accounts (only gains are taxed, at preferential capital gains rates of 0%, 15%, or 20%)
   - Second: Traditional accounts (fully taxed as ordinary income; plus Required Minimum Distributions start at age 73)
   - Last: Roth accounts (completely tax-free; no RMDs during owner's lifetime, so let it grow longest)

4. **Tax Diversification Benefits**: Having a mix of account types provides flexibility to manage tax brackets in retirement. You can pull from Roth in high-income years and Traditional in lower-income years.

5. **Asset Location Strategy**: Consider holding tax-inefficient investments (bonds, REITs) in tax-advantaged accounts and tax-efficient investments (index funds, growth stocks) in taxable accounts.

Provide a detailed response (1-2 paragraphs) explaining the tax implications of their current allocation, whether it represents reasonable diversification given typical income limits, and any strategic considerations for future contributions or withdrawals.
""",

    "history_chart": """
The user is viewing their **Portfolio Value History** chart.

Recent trend:
- 1 month change: {one_month_change:+.1f}%
- 3 month change: {three_month_change:+.1f}%
- Current value: ${current_value:,.0f}

{comparison_context}

Provide brief context on the recent trend without overreacting to short-term movements.
""",

    # =========================================================================
    # HOLDINGS
    # =========================================================================
    "holdings_table": """
The user is viewing their **Holdings Table** with {num_positions} positions across {num_accounts} accounts.

Portfolio statistics:
- Total positions: {num_positions}
- Average position size: ${avg_position:,.0f}
- Largest position: {largest_ticker} at {largest_pct:.1f}%
- Smallest position: {smallest_ticker} at {smallest_pct:.1f}%

{comparison_context}

Comment on the overall portfolio structure - number of holdings, concentration, etc.
""",

    # =========================================================================
    # ANALYSIS - Performance
    # =========================================================================
    "ytd_return": """
The user is viewing their **YTD Return**: **{ytd_return:+.1f}%**

This is the portfolio's return since January 1st of this year.

{comparison_context}

Compare to benchmarks if available (S&P 500 YTD). Explain that YTD return is just one timeframe and shouldn't drive major decisions.
""",

    "one_year_return": """
The user is viewing their **1-Year Return (TTM)**: **{one_year_return:+.1f}%**

TTM = Trailing Twelve Months (the past 365 days).

{comparison_context}

Provide context on this return vs market benchmarks. Is this outperforming or underperforming?
""",

    "alpha": """
The user is viewing their portfolio **Alpha**: **{alpha:+.2f}%**

Alpha measures excess return compared to the S&P 500 benchmark, adjusted for risk.
- Positive alpha = outperforming the market on a risk-adjusted basis
- Negative alpha = underperforming after accounting for risk taken

{comparison_context}

Explain what their alpha value means in practical terms.
""",

    "benchmark": """
The user is viewing the **S&P 500 Benchmark YTD**: **{benchmark_ytd:+.1f}%**

This shows how the overall US stock market has performed this year for comparison.
- Portfolio YTD: {portfolio_ytd:+.1f}%
- Difference: {difference:+.1f}%

{comparison_context}

Briefly explain why comparing to a benchmark matters.
""",

    # =========================================================================
    # ANALYSIS - Risk Metrics
    # =========================================================================
    "volatility": """
The user is viewing their portfolio **Volatility (Annual)**: **{volatility:.1f}%**

Volatility measures how much the portfolio value fluctuates. Higher = more ups and downs.

{comparison_context}

Compare to typical market volatility (S&P 500 ~15-20% historically) and explain what their volatility level means for their experience as an investor.
""",

    "sharpe_ratio": """
The user is viewing their **Sharpe Ratio**: **{sharpe_ratio:.2f}**

The Sharpe ratio measures risk-adjusted return:
- < 1.0: Taking more risk than the return justifies
- 1.0-2.0: Good risk-adjusted returns
- > 2.0: Excellent (rare for individual portfolios)

{comparison_context}

Explain what their Sharpe ratio means - are they being compensated for the risk they're taking?
""",

    "max_drawdown": """
The user is viewing their **Max Drawdown**: **{max_drawdown:.1f}%**

Max drawdown is the largest peak-to-trough decline in portfolio value over the measured period.
This shows the worst loss they would have experienced if they bought at the peak and sold at the bottom.

{comparison_context}

Provide context on whether this drawdown is concerning or within normal ranges.
""",

    "beta": """
The user is viewing their portfolio **Beta**: **{beta:.2f}**

Beta measures volatility relative to the market (S&P 500):
- Beta = 1.0: Moves with the market
- Beta > 1.0: More volatile than the market (amplifies gains AND losses)
- Beta < 1.0: Less volatile than the market

{comparison_context}

Explain what their beta means for their portfolio's behavior in up and down markets.
""",

    "var_95": """
The user is viewing **Value at Risk (95%)**: **{var_95:.1f}%**

VaR 95% means: "There's a 5% chance of losing more than {var_95:.1f}% in a single day."
On a ${total_value:,.0f} portfolio, that's a potential daily loss of ${var_dollars:,.0f}.

{comparison_context}

Explain this risk metric in practical terms - what kind of daily swings should they expect?
""",

    # =========================================================================
    # ANALYSIS - Concentration
    # =========================================================================
    "top_5_concentration": """
The user is viewing their **Top 5 Holdings Concentration**: **{top_5_pct:.1f}%**

This means their 5 largest positions make up {top_5_pct:.1f}% of the total portfolio.

Top 5 holdings:
{top_5_list}

{comparison_context}

Explain whether this concentration level is appropriate. High concentration = more risk but potentially higher returns.
""",

    "top_10_concentration": """
The user is viewing their **Top 10 Holdings Concentration**: **{top_10_pct:.1f}%**

Their 10 largest positions make up {top_10_pct:.1f}% of the portfolio.

{comparison_context}

Briefly comment on diversification. Is the portfolio too concentrated or reasonably spread?
""",

    "cash_allocation": """
The user is viewing their **Cash Allocation**: **{cash_pct:.1f}%**

Cash position: ${cash_value:,.0f}
This includes money market funds, savings, and uninvested cash.

{comparison_context}

Explain the role of cash in a portfolio - emergency fund, dry powder for opportunities, or potentially a drag on returns.
""",

    "invested_allocation": """
The user is viewing their **Invested Allocation**: **{invested_pct:.1f}%**

This is the portion of their portfolio that's invested in stocks, bonds, and other securities (vs cash).

{comparison_context}

Comment on whether being {invested_pct:.0f}% invested is appropriate for their situation.
""",

    # =========================================================================
    # ANALYSIS - Allocation Tables
    # =========================================================================
    "top_holdings": """
The user is viewing their **Top Holdings** list:

{holdings_list}

{comparison_context}

Comment on the composition - any notable concentrations, sector exposures, or diversification observations?
""",

    "allocation_by_sector": """
The user is viewing their **Sector Allocation**:

{sector_breakdown}

{comparison_context}

Comment on sector diversification. Are they over/underweight in any sectors compared to the broader market?
""",

    "allocation_by_asset_class": """
The user is viewing their **Asset Class Allocation**:

{asset_class_breakdown}

User age: {user_age}
A common rule of thumb is (110 - age)% in stocks.

{comparison_context}

Comment on whether their stock/bond mix is appropriate for their age and goals.
""",

    "allocation_by_geography": """
The user is viewing their **Geographic Allocation**:

{geography_breakdown}

{comparison_context}

Comment on international diversification. Many advisors suggest 20-40% international exposure.
""",

    # =========================================================================
    # ANALYSIS - Alerts
    # =========================================================================
    "triggered_alerts": """
The user is viewing **Triggered Alerts** - portfolio conditions that have breached their set thresholds.

{alerts_summary}

{comparison_context}

Explain what triggered alerts mean and whether any require attention. These are user-configured so don't question the thresholds.
""",

    # =========================================================================
    # PROJECTIONS - Monte Carlo
    # =========================================================================
    "mc_success_rate": """
The user is viewing their Monte Carlo **Success Rate**: **{success_rate:.0f}%**

This is the probability of not running out of money through retirement based on:
- Starting portfolio: ${portfolio_value:,.0f}
- Monthly withdrawal: ${monthly_withdrawal:,.0f}
- Retirement years: {retirement_years}

{comparison_context}

Explain what this success rate means. Is {success_rate:.0f}% comfortable or concerning?
""",

    "mc_median_final": """
The user is viewing the **Median Final Value**: **${median_final:,.0f}**

This is the middle outcome from the Monte Carlo simulation - half of scenarios ended with more, half with less.
- Starting value: ${starting_value:,.0f}
- Median ending value: ${median_final:,.0f}

{comparison_context}

Explain what the median outcome represents and why it's a reasonable planning target.
""",

    "mc_worst_case": """
The user is viewing the **Worst Case (5th Percentile)**: **${worst_case:,.0f}**

In 95% of simulated scenarios, they ended up with more than this amount.
Only 5% of scenarios resulted in a lower ending balance.

{comparison_context}

Explain what the 5th percentile represents - this is the "bad luck" scenario to plan for.
""",

    "mc_best_case": """
The user is viewing the **Best Case (95th Percentile)**: **${best_case:,.0f}**

In only 5% of scenarios, the portfolio grew to this amount or more.
This represents the "good luck" scenario - things going very well.

{comparison_context}

Explain that this is an optimistic outcome, not something to count on.
""",

    "mc_chart": """
The user is viewing the **Monte Carlo Projection Chart** showing {num_paths} simulated portfolio paths.

The chart shows:
- Multiple possible futures based on random market returns
- A range of outcomes from worst to best case
- The median path in the middle

Key statistics:
- Success rate: {success_rate:.0f}%
- Median final value: ${median_final:,.0f}

{comparison_context}

Help them interpret the fan-shaped chart - the spread represents uncertainty, not a prediction.
""",

    # =========================================================================
    # TAXES
    # =========================================================================
    "federal_tax": """
The user is viewing their **Federal Income Tax** projection tile.

**Current Values Displayed:**
- Total Federal Tax: {federal_tax_total}
- Detail: {federal_detail}

**User Settings:**
- Current Age: {current_age}
- Retirement Age: {retirement_age}
- End Age: {end_age}
- Annual Spending: ${annual_spending}
- Federal Rate: {federal_rate}%

{comparison_context}

Explain what this federal tax projection represents. Note that:
- This includes taxes during both the accumulation phase (on salary) and retirement (on withdrawals)
- Retirement withdrawals from traditional 401k/IRA are taxed as ordinary income
- The tax is calculated using progressive brackets with standard deduction
- Roth withdrawals are tax-free
""",

    "state_tax": """
The user is viewing their **State Income Tax** projection tile.

**Current Values Displayed:**
- Total State Tax: {state_tax_total}
- Detail: {state_detail}

**User Settings:**
- State Rate: {state_rate}%
- Current Age: {current_age}
- Retirement Age: {retirement_age}

{comparison_context}

Explain what this state tax projection represents. Mention:
- Some states have no income tax (FL, TX, WA, NV, etc.)
- State tax applies to both salary and retirement withdrawals
- Consider suggesting states with no income tax for retirement if applicable
""",

    "cap_gains_tax": """
The user is viewing projected **Lifetime Capital Gains Tax**: **${cap_gains_total:,.0f}**

This applies to gains realized when selling investments in taxable accounts.
Estimated cost basis: {cost_basis_pct:.0f}% of taxable account value

{comparison_context}

Briefly explain long-term vs short-term capital gains rates if relevant.
""",

    "total_tax": """
The user is viewing their **Total Lifetime Tax Burden** projection tile.

**Current Values Displayed:**
- Total Lifetime Tax: {total_lifetime_tax}
- Detail: {total_detail}
- Federal Tax: {federal_tax_total}
- State Tax: {state_tax_total}
- Average Effective Rate: {average_effective_rate}

**User Settings:**
- Current Age: {current_age}
- Retirement Age: {retirement_age}
- End Age: {end_age}
- Annual Spending: ${annual_spending}

{comparison_context}

Explain the total tax burden and provide context:
- This combines all taxes over the projection period (pre-retirement + retirement)
- Compare to total withdrawals to put in perspective
- Suggest potential optimization strategies (Roth conversions, tax-loss harvesting, etc.)
""",

    "withdrawal_table": """
The user is viewing a **Year-by-Year Withdrawal Table** showing tax-efficient retirement withdrawals.

**Current Portfolio:**
- Total balance: ${total_balance:,.0f}
- Taxable accounts: ${taxable_balance:,.0f} ({taxable_pct:.1f}%)
- Traditional (pre-tax): ${traditional_balance:,.0f} ({traditional_pct:.1f}%)
- Roth (post-tax): ${roth_balance:,.0f} ({roth_pct:.1f}%)

**Projection Parameters:**
- User age: {user_age}, Retirement age: {retirement_age}
- Years to retirement: {years_to_retirement}
- Estimated annual spending: ${annual_spending:,.0f}
- RMD starts at age {rmd_start_age} ({years_until_rmd} years away)

{comparison_context}

Explain:
1. How the withdrawal sequence works (Taxable → Traditional → Roth)
2. Why RMDs (Required Minimum Distributions) start at 73 and force traditional withdrawals
3. How this tax-efficient ordering minimizes lifetime taxes
""",

    "tax_burden_chart": """
The user is viewing a **Tax Burden Over Time** chart showing projected taxes throughout their retirement.

**Current Portfolio by Account Type:**
- Taxable: ${taxable_balance:,.0f} ({taxable_pct:.1f}%) - taxed at capital gains rate (~{cap_gains_rate}%)
- Traditional: ${traditional_balance:,.0f} ({traditional_pct:.1f}%) - taxed as ordinary income (~{federal_rate}%)
- Roth: ${roth_balance:,.0f} ({roth_pct:.1f}%) - TAX FREE withdrawals

**Chart Shows:**
- Stacked bars: Federal tax (blue) + State tax (orange)
- Line overlay: Effective tax rate percentage

**Key Tax Events:**
- Age 73: RMDs begin, forcing traditional withdrawals and potentially higher taxes
- As traditional depletes: tax burden decreases (Roth withdrawals are tax-free)

{comparison_context}

Explain why the tax burden pattern makes sense given their account mix, and any strategies to optimize.
""",

    "tax_balance_chart": """
The user is viewing an **Account Balances Over Time** chart showing how each account depletes through retirement.

**Current Balances:**
- Taxable: ${taxable_balance:,.0f} ({taxable_pct:.1f}%)
- Traditional (IRA/401k): ${traditional_balance:,.0f} ({traditional_pct:.1f}%)
- Roth: ${roth_balance:,.0f} ({roth_pct:.1f}%)
- Total: ${total_balance:,.0f}

**Withdrawal Sequence:**
1. **First: Taxable accounts** - Only gains taxed at lower capital gains rates
2. **Second: Traditional accounts** - Fully taxed as ordinary income (plus RMDs at 73)
3. **Last: Roth accounts** - Tax-free, let it grow as long as possible

**User Context:**
- Current age: {user_age}
- Retirement age: {retirement_age}
- Years in retirement: ~{years_in_retirement}

{comparison_context}

Explain the withdrawal sequence logic and what the user's balance trajectory means for their retirement security.
""",

    "effective_rate": """
The user is viewing their **Average Effective Tax Rate**: **{effective_rate:.1f}%**

This represents the average percentage of retirement withdrawals paid as taxes over the projection period.

**Context:**
- Marginal federal rate configured: {federal_rate}%
- Marginal state rate configured: {state_rate}%
- Combined marginal rate: {combined_marginal:.1f}%

**Why effective rate differs from marginal rate:**
The effective rate is typically lower because:
1. Roth withdrawals are tax-free
2. Taxable account withdrawals only tax gains (not principal)
3. Progressive tax brackets mean lower rates on initial income

{comparison_context}

Explain the difference between marginal and effective tax rates, and why their effective rate makes sense given their account mix.
""",

    "total_withdrawn": """
The user is viewing **Total Withdrawn**: **${total_withdrawn:,.0f}**

This is the total gross amount withdrawn from all accounts over {years} years of retirement.
- Average annual withdrawal: ${avg_annual:,.0f}
- Target annual spending: ${annual_spending:,.0f}

**Withdrawal Sources (over entire retirement):**
- From taxable accounts: ${from_taxable:,.0f}
- From traditional (IRA/401k): ${from_traditional:,.0f}
- From Roth (tax-free): ${from_roth:,.0f}

{comparison_context}

Explain what this total represents and how the tax-efficient withdrawal strategy works to minimize taxes over time.
""",

    "final_balance": """
The user is viewing their **Final Portfolio Balance**: **${final_balance:,.0f}**

This is the projected value remaining at age {end_age} after {years} years of retirement withdrawals.

**Projection Summary:**
- Starting balance (at retirement): ${starting_balance:,.0f}
- Total withdrawn: ${total_withdrawn:,.0f}
- Total taxes paid: ${total_taxes:,.0f}
- Investment growth during retirement: ${investment_growth:,.0f}

**What this means:**
{balance_interpretation}

{comparison_context}

Explain whether this ending balance indicates a healthy retirement trajectory. Mention legacy planning if balance is substantial, or portfolio risk if balance is low/depleted.
""",

    # =========================================================================
    # BUDGET
    # =========================================================================
    "income_summary": """
The user is viewing their **Income Summary**:

- Gross annual income: ${gross_annual:,.0f}
- Net annual income (after tax): ${net_annual:,.0f}
- Effective tax rate: {effective_rate:.1f}%

{comparison_context}

Provide context on their income level if comparison data is available.
""",

    "expenses_summary": """
The user is viewing their **Expenses Summary**:

- Total monthly expenses: ${monthly_expenses:,.0f}
- Total annual expenses: ${annual_expenses:,.0f}
- Savings rate: {savings_rate:.1f}%

{comparison_context}

Comment on their savings rate and expense level compared to their income.
""",

    "cashflow_chart": """
The user is viewing a **Cash Flow Waterfall** chart.

Income: ${gross_income:,.0f}
- Taxes: -${taxes:,.0f}
- Expenses: -${expenses:,.0f}
= Net savings: ${net_savings:,.0f}

Monthly surplus/deficit: ${monthly_net:,.0f}

{comparison_context}

Explain the waterfall visualization and their bottom-line cash flow.
""",

    "transition_chart": """
The user is viewing a **Retirement Transition** chart showing income sources over time.

Pre-retirement income: ${pre_retirement_income:,.0f}
Post-retirement income: ${post_retirement_income:,.0f} (from portfolio + Social Security)

Income replacement ratio: {replacement_ratio:.0f}%

{comparison_context}

Explain the transition from earned income to retirement income and whether they're on track.
""",

    # =========================================================================
    # SETTINGS
    # =========================================================================
    "settings_data_storage": """
The user is viewing **Data Storage Settings** which controls where portfolio data is stored.

Options available:
- **Server Mode**: Data stored on the server (allows access from multiple devices)
- **Local Mode**: Data stays only on the user's device (maximum privacy)

Explain the privacy and accessibility trade-offs between these modes. For a personal finance app:
- Server mode is convenient for multi-device access but requires trusting the server
- Local mode is more private but data won't sync across devices
""",

    "settings_personal": """
The user is configuring their **Personal Settings** for retirement planning.

Current settings:
- Date of Birth: {dob}
- Current Age: {user_age}
- Target Retirement Age: {retirement_age}
- Withdrawal Rate: {withdrawal_rate}%
- Target Monthly Income: ${target_income:,.0f}

{comparison_context}

Explain how these settings affect retirement projections:
- **Withdrawal rate**: The 4% rule is a common guideline, but 3-3.5% may be safer for early retirees
- **Retirement age**: Earlier retirement means more years to fund and lower Social Security benefits
- **Target income**: Setting this calculates a FIRE number (Financial Independence target)
""",

    "settings_asset_targets": """
The user is setting their **Asset Class Target Allocation**.

Current targets:
- Equities: {target_equities}%
- Bonds: {target_bonds}%
- Alternatives: {target_alternatives}%
- Cash: {target_cash}%

User age: {user_age}

{comparison_context}

Explain asset allocation concepts:
- **Glide path**: Many advisors suggest reducing equity exposure as you age (e.g., "110 minus your age" in stocks)
- **Risk tolerance**: Younger investors can typically handle more volatility
- **Bonds**: Provide stability but lower expected returns
- **Cash**: Useful for emergencies but may lag inflation long-term

For someone age {user_age}, a typical allocation might be {typical_equity}% stocks / {typical_bond}% bonds.
""",

    "settings_market_assumptions": """
The user is configuring **Market Assumptions** used for retirement projections.

Current settings:
- Stock Mean Return: {stock_return}%
- Stock Std Dev: {stock_std}%
- Bond Mean Return: {bond_return}%
- Bond Std Dev: {bond_std}%
- Inflation Rate: {inflation}%
- Risk-Free Rate: {risk_free}%

{comparison_context}

Explain what these parameters mean:
- **Mean return**: Expected average annual return (historically ~10% nominal for stocks, ~5% for bonds)
- **Standard deviation**: How much returns vary year-to-year (volatility)
- **Inflation**: Reduces purchasing power over time (historically ~3%)
- **Risk-free rate**: Return on "safe" assets like T-bills (used in Sharpe ratio calculation)

These assumptions significantly impact retirement projections - conservative assumptions lead to safer planning.
""",

    "settings_monte_carlo": """
The user is configuring **Monte Carlo Simulation** parameters.

Current settings:
- Number of Simulations: {num_simulations}
- Black Swan Probability: {black_swan_prob}%
- Black Swan Impact: {black_swan_impact}%
- Golden Swan Probability: {golden_swan_prob}%
- Golden Swan Impact: {golden_swan_impact}%

{comparison_context}

Explain Monte Carlo simulation and these settings:
- **Simulations**: More simulations = more accurate results (10,000 is typically sufficient)
- **Black Swan**: Rare negative events (like 2008 crisis). {black_swan_prob}% chance of a {black_swan_impact}% drop
- **Golden Swan**: Rare positive events. {golden_swan_prob}% chance of a {golden_swan_impact}% gain

Monte Carlo randomly simulates thousands of possible market scenarios to estimate retirement success probability. Including tail events (black/golden swans) makes projections more realistic.
""",

    "settings_portfolio_views": """
The user is viewing **Portfolio Views** settings.

Portfolio Views allow you to:
- Create filtered views of your portfolio (e.g., "Retirement Only", "Taxable Only")
- Focus analysis on specific account subsets
- Compare different segments of your portfolio

Use cases:
- Analyze just retirement accounts separately from taxable
- Track a specific goal (e.g., "Kids College Fund")
- Exclude certain accounts from projections temporarily

Views don't change your actual data - they just filter what's displayed in the dashboard, analysis, and projections.
""",
}


def get_prompt_template(prompt_key: str) -> str:
    """Get a prompt template by key."""
    return PROMPT_TEMPLATES.get(prompt_key, "")


def format_prompt(prompt_key: str, **kwargs) -> str:
    """Format a prompt template with provided values.

    Args:
        prompt_key: The template key from PROMPT_TEMPLATES
        **kwargs: Values to substitute into the template

    Returns:
        Formatted prompt string, or empty string if template not found
    """
    template = get_prompt_template(prompt_key)
    if not template:
        return ""

    # Add default comparison context if not provided
    if "comparison_context" not in kwargs:
        kwargs["comparison_context"] = "No comparison data available."

    try:
        # Use safe formatting that won't fail on missing keys
        return template.format(**kwargs)
    except KeyError as e:
        # Return template with placeholder note if formatting fails
        return f"{template}\n\n[Note: Missing data for {e}]"
