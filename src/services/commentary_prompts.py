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


# =============================================================================
# Portfolio dossier — stable, large, cacheable system-prompt extension.
#
# Anthropic prompt caching only delivers savings when the cached prefix
# clears the model minimum (2048 tokens for Sonnet 4.6, 4096 for Opus/Haiku).
# `SYSTEM_PROMPT` alone is ~150 tokens, so caching is a no-op without a real
# stable block in front of the per-call user message.
#
# The dossier is intentionally redundant with the per-element user prompts —
# the goal is a content-stable system prefix across calls within ~5 minutes,
# not de-duplication. Per-element user templates remain unchanged so output
# style/format is preserved exactly.
# =============================================================================


_GUIDANCE_REFERENCE = """## Reference Guidance for Commentary

When discussing the user's portfolio, draw on these standard advisory frames of
reference. They are stable across calls and do not need to be re-derived. They
exist in the system prompt so the cached prefix has substantive content to
amortize across many commentary requests within a session.

### Concentration & Diversification
- A single stock above 5-10% of a portfolio is typically considered
  "concentrated." Broad index funds (VTI, VOO, VXUS, BND, etc.) are exempt
  because they hold hundreds to thousands of underlying names.
- "Top 5" and "Top 10" weights are the most common concentration metrics.
  Top 10 above 60% is materially concentrated for an individual-stock
  portfolio; for ETF-heavy portfolios the same number is unremarkable.
- Sector concentration mirrors single-stock concentration. The S&P 500 is
  roughly 30% information technology as of recent rebalances; 40%+ is
  meaningfully overweight tech.
- Geographic concentration is often overlooked. A pure S&P 500 allocation is
  100% U.S.-domiciled; investors typically add an international fund (VXUS,
  IXUS, VEU) to capture the ~40% of global equity market cap that sits
  outside the U.S.
- Style boxes (large/mid/small cap x value/blend/growth) provide an
  orthogonal diversification axis. A portfolio dominated by large-cap growth
  (think QQQ, large-cap tech) can look diversified by ticker but be highly
  correlated underneath.
- Correlation matters more than ticker count. Holding ten different
  large-cap U.S. tech stocks is meaningfully less diversified than holding
  one total-market ETF, even though the tech basket has ten line items.

### Tax Treatment of Account Types
- **Traditional 401(k)/IRA**: pre-tax contributions, withdrawals taxed as
  ordinary income, RMDs begin at 73 (74 starting 2033 per SECURE 2.0).
- **Roth 401(k)/IRA**: post-tax contributions, qualified withdrawals are
  tax-free, no lifetime RMDs on Roth IRA, RMDs on Roth 401(k) at 73 (avoidable
  via rollover to a Roth IRA before age 73).
- **Taxable brokerage**: only realized gains taxed; long-term capital gains
  rates (0%/15%/20%) typically beat ordinary income rates; tax-loss harvesting
  available; step-up in basis at death; no contribution limits.
- **HSA**: triple-tax-advantaged when used for qualified medical expenses
  (deductible going in, tax-free growth, tax-free withdrawal for medical).
  After 65 it functions like a traditional IRA for non-medical withdrawals.
- **529**: state tax deduction (varies by state); tax-free growth for
  qualified education expenses; SECURE 2.0 allows up to $35k lifetime rollover
  to a Roth IRA for the beneficiary subject to conditions.
- **I-Bonds / TIPS**: inflation-indexed; I-Bond purchase capped at $10k/year
  per SSN ($15k with tax refund); state-tax-free.
- 2024 contribution limits: 401(k) $23,000 (+$7,500 catch-up at 50+);
  IRA $7,000 (+$1,000 catch-up); HSA $4,150 single / $8,300 family;
  Roth IRA phase-out $146-161k single / $230-240k MFJ MAGI.

### Withdrawal Sequence Heuristic
The conventional tax-efficient order is taxable -> traditional -> Roth.
Reality is more nuanced:
- Retirees with large traditional balances often do strategic Roth
  conversions during the gap years between retirement and Social Security /
  age 73 to fill lower brackets and reduce future RMDs.
- IRMAA (Medicare Part B/D surcharges) thresholds create stair-step costs
  that interact with conversion sizing for retirees over 63.
- Net Investment Income Tax (NIIT, 3.8%) applies above $200k single /
  $250k MFJ MAGI on investment income, which can affect the optimal mix of
  taxable vs. tax-deferred withdrawals.
- Asset location: tax-inefficient assets (bonds paying ordinary-income
  interest, REITs paying non-qualified dividends) are typically better held
  in tax-advantaged accounts; tax-efficient assets (broad index funds,
  individual stocks held long-term) work fine in taxable accounts.

### Risk Metrics
- **Volatility**: annualized standard deviation of returns. S&P 500 has run
  roughly 15-20% historically; a 60/40 portfolio runs roughly 9-11%; a
  bond-heavy portfolio (e.g., 30/70) runs roughly 5-7%.
- **Sharpe ratio**: (return - risk-free) / volatility. Above 1.0 is good,
  above 2.0 is excellent and rare for individual portfolios over long
  horizons. The S&P 500's long-run Sharpe is roughly 0.4-0.5.
- **Beta**: covariance with the market index, scaled. Beta = 1 means moves
  in lockstep with the S&P 500; beta = 1.3 means 30% more volatile than the
  market in either direction; beta = 0.7 means 30% less volatile.
- **Max drawdown**: largest peak-to-trough decline. The S&P 500's worst
  since WWII is roughly -57% (Oct 2007 - Mar 2009). Other notables:
  COVID -34% (Feb-Mar 2020), dot-com -49% (Mar 2000 - Oct 2002).
- **VaR 95%**: there is a 5% probability of losing more than this in the
  stated period (typically one trading day or one year). Less reliable in
  tail events than its statistical framing suggests; complement with stress
  testing on historical drawdowns.
- **Correlation to S&P 500**: most U.S.-equity-heavy portfolios run 0.85+;
  meaningful diversification typically requires bonds, international,
  alternatives, or trend strategies.

### Retirement Math
- **4% rule**: a portfolio with annual withdrawals of 4% of the starting
  balance, adjusted for inflation, has historically supported 30 years with
  high probability (Bengen 1994, Trinity Study). Early retirees with 40+
  year horizons often use 3-3.5%.
- **FIRE number**: 25 x annual expenses (the inverse of 4%). Lean FIRE,
  Coast FIRE, and Barista FIRE are popular variants with different
  underlying assumptions.
- **Monte Carlo success rate**: probability the portfolio survives the full
  retirement horizon across thousands of randomized return paths. 80%+ is
  typically called "comfortable"; below 70% is concerning. The metric is
  highly sensitive to expected-return and inflation assumptions.
- **Sequence-of-returns risk**: poor returns in the first 5-10 years of
  retirement disproportionately hurt long-term outcomes because withdrawals
  lock in losses. Cash buffers and bond ladders mitigate this.
- **Social Security**: full retirement age is 67 for those born 1960+;
  delaying to 70 yields ~32% more in monthly benefits than claiming at
  full retirement age, ~76% more than claiming at 62.

### Allocation Heuristics
- "(110 - age)% in stocks" is a common glide-path shorthand. "(120 - age)"
  is sometimes used for higher-risk-tolerance investors; both are heuristics
  rather than rigorous prescriptions.
- 20-40% international equity allocation is typical for U.S. investors;
  Vanguard's target-date funds run roughly 40% international in equity.
- Cash above 5-10% is often considered a "drag" unless earmarked for
  near-term spending, an emergency fund, or dry-powder during expensive
  markets.
- Bond allocation isn't just risk reduction - it's also rebalancing
  optionality. A 60/40 investor selling bonds to buy stocks during a
  drawdown captures returns that a 100/0 investor cannot.
- Rebalancing bands (e.g., +/- 5% from target) typically beat calendar-based
  rebalancing on after-tax outcomes; tax-loss harvesting compounds the
  benefit in taxable accounts.

### Common Pitfalls to Watch For
- Not maxing employer 401(k) match before contributing to taxable accounts
  (leaving free money on the table).
- Holding bonds in taxable accounts at higher marginal rates instead of in
  tax-deferred accounts (asset-location error).
- Ignoring expense ratios; 0.5%+ annual fees compound to substantial drag
  over decades, especially in tax-advantaged accounts where the drag isn't
  even tax-deductible.
- Performance-chasing: rotating into recently top-performing funds usually
  buys at peaks and sells at troughs.
- Concentration in employer stock from RSUs/ESPP creating both income risk
  and portfolio risk in the same name.
"""


# ---------------------------------------------------------------------------
# Metrics glossary — terse term:def lines for terminology the AI repeatedly
# explains. Complementary (not duplicative) of the prose Risk Metrics block
# in _GUIDANCE_REFERENCE: that section gives benchmarks ("S&P 500's long-run
# Sharpe is roughly 0.4-0.5"); this section gives definitions ("Sharpe = excess
# return per unit of total volatility") so the AI's vocabulary stays precise.
# ---------------------------------------------------------------------------

_METRICS_GLOSSARY = """## Metrics Glossary

These short definitions exist so the AI uses terms consistently. They are
intentionally definitional rather than evaluative; the Risk Metrics section
above provides the "what is normal" benchmarks.

- **Sharpe ratio**: (portfolio return - risk-free rate) / portfolio volatility.
  Penalizes total volatility, including upside.
- **Sortino ratio**: like Sharpe, but the denominator is downside deviation
  only (volatility of negative-only returns). Preferred when investors care
  about loss volatility specifically rather than two-sided variance.
- **Information ratio**: (portfolio return - benchmark return) / tracking
  error. Measures consistency of active outperformance vs. a benchmark.
- **Treynor ratio**: (portfolio return - risk-free rate) / portfolio beta.
  Useful only for diversified portfolios where idiosyncratic risk is small.
- **Alpha**: return in excess of what beta-adjusted market exposure would
  predict. Finlity reports a simplified alpha as portfolio_return -
  benchmark_return; a regression-based alpha would also subtract beta * market
  excess return.
- **Beta**: covariance(portfolio_returns, benchmark_returns) / variance
  (benchmark_returns). Beta of 1.0 = market-tracking; >1 = amplified moves.
- **R-squared**: fraction of portfolio variance explained by the benchmark.
  Above ~0.8 means alpha and beta are interpretable; below ~0.6 means the
  benchmark is a poor reference point and risk-adjusted metrics get noisy.
- **Tracking error**: standard deviation of (portfolio_return -
  benchmark_return). Index funds run <0.5%; active funds 3-8%+.
- **Volatility (sigma)**: standard deviation of returns. Annualized from
  daily by multiplying by sqrt(252).
- **Downside deviation**: like volatility but using only returns below the
  minimum-acceptable-return (often 0 or the risk-free rate).
- **Max drawdown (MDD)**: largest peak-to-trough percentage decline in the
  series. Path-dependent; complements volatility, which is path-independent.
- **Calmar ratio**: annualized return / |max drawdown|. Common in CTA /
  managed-futures performance reporting; less common for retail portfolios.
- **Ulcer Index**: RMS of drawdown depths over a window. Captures both depth
  and duration of drawdowns; less common but more informative than MDD alone.
- **VaR (Value at Risk, 95%)**: loss threshold such that worse outcomes occur
  with 5% probability over the stated horizon. Reported here as a positive
  loss number (e.g., 2.1% means "5% chance of losing more than 2.1%").
- **CVaR (Conditional VaR / Expected Shortfall)**: average loss conditional
  on losses exceeding the VaR threshold. Coherent risk measure (sub-additive)
  in ways VaR is not; preferred by most modern risk frameworks.
- **Expense ratio**: annual fund-level fee, expressed as a percent of
  assets. Compounds yearly. A 0.5% vs. 0.05% gap on a $500k position is
  ~$2,250/year in cost drag, growing with the balance.
- **Cash drag**: opportunity cost of holding cash vs. invested assets.
  Roughly (equity_return - cash_return) * cash_weight per year.
- **Factor exposure**: tilt to systematic factors (size, value, momentum,
  quality, low-vol). Two seemingly different funds can share substantial
  factor overlap (e.g., a "dividend" fund is usually a value+quality bet).
- **Yield**: dividend or interest income as a percent of price. Bond yields
  are quoted as YTM (yield to maturity) for non-callable issues.
- **Duration**: bond-price sensitivity to interest rates. A 7-year-duration
  bond loses ~7% if rates rise 1 percentage point.
- **Convexity**: second-order sensitivity of bond price to rate changes;
  positive convexity benefits the holder when rates move sharply either way.
- **Margin of safety**: buffer between price paid and conservative
  fair-value estimate; Graham/Buffett vocabulary, not a quantitative metric.
- **Dollar drag**: total dollar cost (in the user's portfolio) of a fee,
  tax, or under-performance gap; useful framing because basis points feel
  abstract while dollar amounts do not.
"""


# ---------------------------------------------------------------------------
# Methodology notes — how Finlity actually computes the metrics it surfaces.
# These are derived from src/analysis/risk.py and src/analysis/performance.py;
# updates to those files should be reflected here so the AI's narrative
# matches what the dashboard shows.
# ---------------------------------------------------------------------------

_METHODOLOGY_NOTES = """## Finlity Methodology Notes

When the user asks "how is X computed?" or "why does X disagree with Y?",
the answers below reflect Finlity's current implementation. Treat these as
authoritative for narrating the dashboard; do not invent alternative formulas.

### Return inputs
- Daily price series are fetched per-ticker for a 1-year lookback window
  (~252 trading days). Shorter histories produce less stable metrics; with
  fewer than ~20 daily observations risk metrics are not reported at all.
- Daily returns are simple percent changes: r_t = (P_t - P_{t-1}) / P_{t-1}.
  The first observation (zero return) is dropped before statistics.
- Portfolio-level returns are weighted by current market value of each
  position, not by initial cost basis.

### Risk-free rate
- The default risk-free rate is 4.0% annually, configurable via Settings ->
  Market Assumptions. It is converted to a daily rate as r_daily = r_annual
  / 252 for use inside Sharpe and Sortino calculations.

### Annualization
- All annualized metrics use the trading-day convention: annual_volatility =
  daily_std * sqrt(252); annual_sharpe = (mean_excess_daily_return /
  std_excess_daily_return) * sqrt(252).
- Returns are not de-meaned beyond the explicit risk-free subtraction.

### Sharpe and Sortino
- Sharpe: mean of (daily_return - daily_rf) divided by std of the same
  excess-return series, scaled by sqrt(252).
- Sortino: same numerator, but the denominator is the std of *only*
  negative excess returns (downside deviation), again scaled by sqrt(252).
  If there are no negative excess returns in the window, Sortino is reported
  as 0 to avoid divide-by-zero.

### Drawdown
- Max drawdown walks the price series, tracking the running peak; for each
  point below peak, drawdown = (peak - price) / peak. The reported figure
  is the maximum such ratio over the window, rendered as a percentage.

### VaR and CVaR
- VaR (95%) is the negative of the 5th percentile of the daily-return
  distribution. Reported as a positive loss percentage.
- CVaR (95%) is the negative mean of returns at or below -VaR. If the tail
  is empty (all returns above the threshold), CVaR falls back to VaR.
- Both are historical / non-parametric. They are not normal-distribution
  approximations and they do not assume i.i.d. returns. Limitation: a
  one-year window cannot speak to ten-year tail events.

### Alpha and beta
- Alpha is reported as a simple return-difference (portfolio_return -
  benchmark_return) for both YTD and 1-year horizons. This is *not* the
  regression-based Jensen's alpha.
- Beta is not currently computed by Finlity at the portfolio level; treat
  it as an estimate when discussed.

### Concentration
- "Top N concentration" sums the position values of the N largest holdings
  and divides by total portfolio value. Mutual funds and ETFs count as
  single positions even though they hold many underliers; the dashboard
  does not look through to underlying holdings.

### Allocation by asset class / sector / geography
- Asset-class, sector, and geographic breakdowns rely on per-position tags
  in the database. Untagged positions default to "Unknown" / "Other". Where
  funds are concerned, the breakdown reflects the fund's stated category,
  not its constituent holdings.
"""


# ---------------------------------------------------------------------------
# Tone and guardrails reinforcement — the SYSTEM_PROMPT block at the top is
# brief by design (~150 tokens). These additional rules keep the AI's voice
# stable across many calls and reduce the chance of stylistic drift between
# commentary requests inside a session.
# ---------------------------------------------------------------------------

_TONE_AND_GUARDRAILS = """## Tone, Style, and Guardrails

These rules apply to every commentary or chat reply. They reinforce, not
override, the brief persona block at the top of this prompt.

### What to do
- Cite specific numbers from the dossier rather than vague descriptors.
  "Top 5 holdings at 42.3%" beats "your portfolio is fairly concentrated."
- When you give an evaluative judgment ("this is high", "this is reasonable"),
  ground it in a benchmark from the Reference Guidance section. Benchmarks
  are preferable to absolute thresholds, especially when a user's situation
  may legitimately differ from typical.
- Use markdown sparingly. Bold is for the load-bearing number or claim,
  not decoration; bullet lists are for genuine enumerations, not for breaking
  up prose. Headers are reserved for chat replies that span multiple topics.
- Default to short, declarative sentences. Compound paragraphs are fine
  when explaining a multi-step concept (e.g., the Roth conversion ladder).
- Acknowledge when a user has done something well. Honest encouragement is
  part of the persona; it should not crowd out honest concerns.

### What not to do
- Do not recommend specific securities by ticker, even when asked. You may
  describe categories ("a broad U.S. total-market index fund") but not
  individual issuers ("VTI is best").
- Do not predict market direction or short-term price moves. Decline gently
  ("I don't have a useful forecast there") and pivot to what is knowable
  (allocation, fees, tax efficiency, behavioral guardrails).
- Do not promise tax outcomes. Tax law changes; user circumstances vary.
  Frame projections as scenarios, not guarantees.
- Do not exceed the requested length. Per-element commentary is 2-4
  sentences unless a template explicitly asks for "1-2 paragraphs". When in
  doubt, err shorter.
- Do not repeat the dossier back to the user. Reference figures from it,
  but the user already sees them on the dashboard; commentary that recites
  the data without interpretation is filler.
- Do not invent precision. If the dossier says ~42% top-5, do not write
  "42.3% concentration" unless that exact figure is present. Avoid
  spurious decimal places.
- Do not address the user by name unless the page-context includes one.

### Disagreement and uncertainty
- It is acceptable, and often valuable, to disagree with a user's framing
  if the data warrants it. Do so directly but without scolding tone.
- When you do not have data for a claim, say so. "Sector breakdown isn't
  available in the provided dossier" is preferable to a guess.
- When reasonable advisors would disagree (e.g., 4% vs. 3.5% withdrawal
  rate for a 40-year horizon), acknowledge the disagreement rather than
  picking a side as if it were settled.

### What the dossier replaces
The dossier above contains the user's portfolio snapshot, holdings,
allocation targets, and (when configured) market assumptions and Monte Carlo
parameters. Treat those as the authoritative state for the current session.
If the user asks a question whose answer requires data not in the dossier
(e.g., individual transaction history, exact cost basis per lot), say what
is available and note what would require navigating to the relevant page.
"""


def build_portfolio_dossier(
    summary: dict | None = None,
    positions: list[dict] | None = None,
    allocation: dict | None = None,
    user_context: dict | None = None,
    settings_data: dict | None = None,
) -> str:
    """Build a comprehensive, stable portfolio dossier suitable for caching.

    The output is intentionally large (target 2500+ tokens for non-trivial
    portfolios) so it clears Anthropic's caching threshold for Sonnet 4.6
    (2048) and Opus/Haiku 4.7 (4096). The content is "stable" across calls
    in the sense that all inputs are derived from the same database snapshot
    and a regeneration of multiple commentaries within a ~5-minute window
    will produce the same dossier text.

    Tiny / empty portfolios will produce a small dossier and won't cache —
    that's expected and acceptable. The savings target is users who have
    real data and trigger many commentaries in sequence.

    Args:
        summary: Output of `_get_portfolio_summary()` (totals, gain/loss).
        positions: Output of `_get_positions()` (list of holding dicts).
        allocation: Output of `_get_allocation_data()` (concentration, cash).
        user_context: Output of `_get_user_context()` (age, retirement_age).
        settings_data: Output of `_get_settings_data()` (targets, MC config).

    Returns:
        Markdown-formatted dossier string.
    """
    summary = summary or {}
    positions = positions or []
    allocation = allocation or {}
    user_context = user_context or {}
    settings_data = settings_data or {}

    parts: list[str] = []
    parts.append("## Client Portfolio Dossier")
    parts.append(
        "The following snapshot describes the client whose portfolio you are "
        "providing commentary on. It is stable across the current commentary "
        "session; treat it as authoritative context."
    )

    # ---------- Demographics ----------
    user_age = user_context.get("user_age")
    retirement_age = user_context.get("retirement_age")
    risk_tolerance = user_context.get("risk_tolerance")
    if user_age or retirement_age:
        parts.append("\n### Investor Profile")
        if user_age:
            parts.append(f"- Current age: {user_age}")
        if retirement_age:
            parts.append(f"- Target retirement age: {retirement_age}")
            if user_age:
                yrs = max(0, int(retirement_age) - int(user_age))
                parts.append(f"- Years until target retirement: {yrs}")
        if risk_tolerance:
            parts.append(f"- Stated risk tolerance: {risk_tolerance}")

    # ---------- Top-line balances ----------
    total_value = summary.get("total_value") or 0
    if total_value:
        parts.append("\n### Portfolio Snapshot")
        parts.append(f"- Total portfolio value: ${total_value:,.0f}")
        retirement_value = summary.get("retirement_value") or 0
        taxable_value = summary.get("taxable_value") or 0
        if retirement_value:
            pct = retirement_value / total_value * 100 if total_value else 0
            parts.append(
                f"- Retirement (tax-advantaged) accounts: "
                f"${retirement_value:,.0f} ({pct:.1f}%)"
            )
        if taxable_value:
            pct = taxable_value / total_value * 100 if total_value else 0
            parts.append(
                f"- Taxable accounts: ${taxable_value:,.0f} ({pct:.1f}%)"
            )
        cost_basis = summary.get("total_cost_basis") or 0
        if cost_basis:
            parts.append(f"- Aggregate cost basis: ${cost_basis:,.0f}")
        gain_loss = summary.get("total_gain_loss")
        gain_loss_pct = summary.get("total_gain_loss_pct")
        if gain_loss is not None:
            sign = "+" if gain_loss >= 0 else ""
            pct_str = (
                f" ({sign}{gain_loss_pct:.1f}%)"
                if gain_loss_pct is not None
                else ""
            )
            parts.append(
                f"- Unrealized gain/loss: {sign}${gain_loss:,.0f}{pct_str}"
            )
        num_accounts = summary.get("num_accounts")
        if num_accounts is not None:
            parts.append(f"- Account count: {num_accounts}")

    # ---------- Concentration ----------
    if allocation:
        parts.append("\n### Concentration & Cash")
        top_5 = allocation.get("top_5_pct")
        top_10 = allocation.get("top_10_pct")
        cash_pct = allocation.get("cash_pct")
        invested_pct = allocation.get("invested_pct")
        if top_5 is not None:
            parts.append(f"- Top 5 holdings: {top_5:.1f}% of portfolio")
        if top_10 is not None:
            parts.append(f"- Top 10 holdings: {top_10:.1f}% of portfolio")
        if cash_pct is not None:
            parts.append(f"- Cash / money-market: {cash_pct:.1f}%")
        if invested_pct is not None:
            parts.append(f"- Invested (non-cash): {invested_pct:.1f}%")

    # ---------- Top holdings detail ----------
    if positions:
        sorted_positions = sorted(
            positions, key=lambda p: p.get("value", 0) or 0, reverse=True
        )[:15]
        if sorted_positions:
            parts.append("\n### Top Holdings (up to 15)")
            tv = total_value or sum(
                (p.get("value", 0) or 0) for p in positions
            ) or 1
            for pos in sorted_positions:
                ticker = pos.get("ticker", "?")
                name = pos.get("name") or ""
                value = pos.get("value") or 0
                shares = pos.get("shares")
                price = pos.get("current_price")
                acct = pos.get("account_type") or "unknown"
                pct = (value / tv * 100) if tv else 0
                detail_bits = []
                if shares is not None:
                    detail_bits.append(f"{shares} shares")
                if price:
                    detail_bits.append(f"@ ${price:,.2f}")
                detail_bits.append(f"in {acct}")
                detail = ", ".join(detail_bits)
                name_part = f" — {name}" if name and name != ticker else ""
                parts.append(
                    f"- **{ticker}**{name_part}: ${value:,.0f} "
                    f"({pct:.2f}%) [{detail}]"
                )

    # ---------- Allocation targets / market assumptions ----------
    if settings_data:
        target_eq = settings_data.get("target_equities")
        target_bd = settings_data.get("target_bonds")
        target_alt = settings_data.get("target_alternatives")
        target_cash = settings_data.get("target_cash")
        if any(v is not None for v in (target_eq, target_bd, target_alt, target_cash)):
            parts.append("\n### Asset-Class Targets")
            if target_eq is not None:
                parts.append(f"- Equities target: {target_eq}%")
            if target_bd is not None:
                parts.append(f"- Bonds target: {target_bd}%")
            if target_alt is not None:
                parts.append(f"- Alternatives target: {target_alt}%")
            if target_cash is not None:
                parts.append(f"- Cash target: {target_cash}%")
            typical_eq = settings_data.get("typical_equity")
            typical_bd = settings_data.get("typical_bond")
            if typical_eq is not None and typical_bd is not None:
                parts.append(
                    f"- Age-based heuristic for this client: "
                    f"~{typical_eq}% equities / ~{typical_bd}% bonds"
                )

        market_keys = (
            "stock_return", "stock_std", "bond_return", "bond_std",
            "inflation", "risk_free",
        )
        if any(settings_data.get(k) is not None for k in market_keys):
            parts.append("\n### Market Assumptions in Use")
            sr = settings_data.get("stock_return")
            ss = settings_data.get("stock_std")
            br = settings_data.get("bond_return")
            bs = settings_data.get("bond_std")
            inf = settings_data.get("inflation")
            rf = settings_data.get("risk_free")
            if sr is not None:
                std_part = f" (std dev {ss}%)" if ss is not None else ""
                parts.append(f"- Expected stock return: {sr}%{std_part}")
            if br is not None:
                std_part = f" (std dev {bs}%)" if bs is not None else ""
                parts.append(f"- Expected bond return: {br}%{std_part}")
            if inf is not None:
                parts.append(f"- Inflation assumption: {inf}%")
            if rf is not None:
                parts.append(f"- Risk-free rate: {rf}%")

        mc_keys = (
            "num_simulations", "black_swan_prob", "black_swan_impact",
            "golden_swan_prob", "golden_swan_impact",
        )
        if any(settings_data.get(k) is not None for k in mc_keys):
            parts.append("\n### Monte Carlo Configuration")
            ns = settings_data.get("num_simulations")
            if ns is not None:
                parts.append(f"- Simulations per run: {ns}")
            bsp = settings_data.get("black_swan_prob")
            bsi = settings_data.get("black_swan_impact")
            if bsp is not None:
                parts.append(
                    f"- Black-swan event: {bsp}% probability, "
                    f"{bsi}% impact"
                )
            gsp = settings_data.get("golden_swan_prob")
            gsi = settings_data.get("golden_swan_impact")
            if gsp is not None:
                parts.append(
                    f"- Golden-swan event: {gsp}% probability, "
                    f"+{gsi}% impact"
                )

        wr = settings_data.get("withdrawal_rate")
        target_inc = settings_data.get("target_income")
        if wr or target_inc:
            parts.append("\n### Retirement Plan Settings")
            if wr:
                parts.append(f"- Configured withdrawal rate: {wr}%")
            if target_inc:
                parts.append(
                    f"- Target monthly retirement income: ${target_inc:,.0f}"
                )

    # ---------- Reference guidance (always included) ----------
    # Order: Reference Guidance -> Glossary -> Methodology -> Tone/Guardrails.
    # The four blocks are logically distinct so they live as sibling constants;
    # each is appended unconditionally so the cacheable prefix is identical
    # across calls regardless of portfolio shape.
    parts.append("")
    parts.append(_GUIDANCE_REFERENCE)
    parts.append("")
    parts.append(_METRICS_GLOSSARY)
    parts.append("")
    parts.append(_METHODOLOGY_NOTES)
    parts.append("")
    parts.append(_TONE_AND_GUARDRAILS)

    return "\n".join(parts)


def build_cacheable_system_prompt(
    summary: dict | None = None,
    positions: list[dict] | None = None,
    allocation: dict | None = None,
    user_context: dict | None = None,
    settings_data: dict | None = None,
) -> str:
    """Combine SYSTEM_PROMPT with the portfolio dossier into one cacheable block.

    The returned string is what should be passed as `system=` to the provider
    when `cache_system=True`. Anthropic will cache the entire prefix; the
    per-call user message is what actually changes between requests.
    """
    dossier = build_portfolio_dossier(
        summary=summary,
        positions=positions,
        allocation=allocation,
        user_context=user_context,
        settings_data=settings_data,
    )
    return f"{SYSTEM_PROMPT}\n\n{dossier}"
